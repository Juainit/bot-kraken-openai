// server.js - versión con reinversión automática según último trade cerrado
const express = require('express');
const KrakenClient = require('kraken-api');
const axios = require('axios');
const dotenv = require('dotenv');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = './trades.db';

const kraken = new KrakenClient(process.env.API_KEY, process.env.API_SECRET);
const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pair TEXT NOT NULL,
      quantity REAL NOT NULL,
      stopPercent REAL,
      highestPrice REAL,
      buyPrice REAL,
      buyOrderId TEXT NOT NULL,
      sellPrice REAL,
      profitPercent REAL,
      status TEXT DEFAULT 'active',
      createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

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
    const balanceEnPar = parseFloat(balanceResult[cleanPair]) || 0;

    if (balanceEnPar > 8) {
      console.log(`⚠️ Ya tienes ${balanceEnPar} en ${cleanPair}, no se compra.`);
      return res.status(200).json({ message: `No se compra porque ya hay ${balanceEnPar} en Kraken para ${cleanPair}` });
    }

    // Consultar última venta completada
    const lastTrade = await new Promise((resolve, reject) => {
      db.get(`SELECT quantity, sellPrice FROM trades WHERE pair = ? AND status = 'completed' ORDER BY id DESC LIMIT 1`, [cleanPair], (err, row) => {
        if (err) return reject(err);
        resolve(row);
      });
    });

    let inversionEUR = 40;

    if (lastTrade && lastTrade.sellPrice && lastTrade.quantity) {
      inversionEUR = lastTrade.sellPrice * lastTrade.quantity;
      console.log(`🔁 Reinvierte ${inversionEUR.toFixed(2)} EUR de la última venta.`);
    } else {
      console.log(`🆕 Primera vez para ${cleanPair}, usa inversión por defecto de 40 EUR`);
    }

    // Obtener precio actual
    const ticker = await axios.get(`https://api.kraken.com/0/public/Ticker?pair=${cleanPair}`);
    const price = parseFloat(ticker.data.result[cleanPair].c[0]);

    // Calcular cantidad a comprar
    const quantity = Math.floor((inversionEUR / price) * 100000000) / 100000000;

    // Ejecutar orden de compra
    const order = await kraken.api('AddOrder', {
      pair: cleanPair,
      type: 'buy',
      ordertype: 'market',
      volume: quantity.toString()
    });

    const orderId = order.result.txid[0];

    db.run(`INSERT INTO trades (pair, quantity, stopPercent, highestPrice, buyPrice, buyOrderId)
            VALUES (?, ?, ?, ?, ?, ?)`,
            [cleanPair, quantity, stop, price, price, orderId]);

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