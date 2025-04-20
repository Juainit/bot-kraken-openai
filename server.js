// server.js - versión PostgreSQL completa y corregida con log inicial
const express = require('express');
const KrakenClient = require('kraken-api');
const axios = require('axios');
const dotenv = require('dotenv');
const { Pool } = require('pg');

dotenv.config();
console.log("📡 Iniciando server.js...");

const app = express();
const PORT = process.env.PORT || 3000;

const kraken = new KrakenClient(process.env.API_KEY, process.env.API_SECRET);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

app.use(express.json());

app.post('/alerta', async (req, res) => {
  try {
    const { par, trailingStopPercent } = req.body;
    if (!par || !trailingStopPercent) {
      return res.status(400).json({ error: 'Faltan parámetros: par y trailingStopPercent son obligatorios' });
    }

    const cleanPair = par.toUpperCase();
    const stop = parseFloat(trailingStopPercent);

    // Verificar saldo actual del activo
    const balanceResult = await kraken.api('Balance');
    const balanceEnPar = parseFloat(balanceResult.result[cleanPair]) || 0;

    if (balanceEnPar > 8) {
      console.log(`⚠️ Ya tienes ${balanceEnPar} en ${cleanPair}, no se compra.`);
      return res.status(200).json({ message: `No se compra porque ya hay ${balanceEnPar} en Kraken para ${cleanPair}` });
    }

    const { rows } = await pool.query(
      `SELECT quantity, sellPrice FROM trades WHERE pair = $1 AND status = 'completed' ORDER BY id DESC LIMIT 1`,
      [cleanPair]
    );

    let inversionEUR = 40;
if (req.body.inversion) {
  inversionEUR = parseFloat(req.body.inversion);
  console.log(`💸 Inversión personalizada recibida: ${inversionEUR} EUR`);
} else if (rows.length > 0) {
  const lastTrade = rows[0];
  if (lastTrade.sellprice && lastTrade.quantity) {
    inversionEUR = lastTrade.sellprice * lastTrade.quantity;
    console.log(`🔁 Reinvierte ${inversionEUR.toFixed(2)} EUR de la última venta.`);
  }
} else {
  console.log(`🆕 Primera vez para ${cleanPair}, usa inversión por defecto de 40 EUR`);
}

    const ticker = await axios.get(`https://api.kraken.com/0/public/Ticker?pair=${cleanPair}`);
    const price = parseFloat(ticker.data.result[cleanPair].c[0]);
    const quantity = Math.floor((inversionEUR / price) * 100000000) / 100000000;

    const order = await kraken.api('AddOrder', {
      pair: cleanPair,
      type: 'buy',
      ordertype: 'market',
      volume: quantity.toString()
    });

    const orderId = order.result.txid[0];

    await pool.query(
      `INSERT INTO trades (pair, quantity, stopPercent, highestPrice, buyPrice, sellPrice, status)
       VALUES ($1, $2, $3, $4, $4, NULL, 'active')`,
      [cleanPair, quantity, stop, price]
    );

    console.log(`✅ COMPRA ejecutada: ${quantity} ${cleanPair} a ${price}`);
    res.json({ message: 'Compra ejecutada', pair: cleanPair, quantity, price });
  } catch (error) {
    console.error(`❌ Error en /alerta: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
});