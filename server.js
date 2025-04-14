// server.js - con verificación de balance antes de comprar
const express = require('express');
const KrakenClient = require('kraken-api');
const axios = require('axios');
const dotenv = require('dotenv');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Configuración inicial
dotenv.config();
const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = './trades.db';
const CHECK_INTERVAL = 180000;

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
    const { par, cantidad, trailingStopPercent } = req.body;
    if (!par || !cantidad || !trailingStopPercent) {
      return res.status(400).json({ error: 'Faltan parámetros' });
    }

    const cleanPair = par.toUpperCase();
    const amount = parseFloat(cantidad);
    const stop = parseFloat(trailingStopPercent);

    // Obtener el balance real
    const balanceResult = await kraken.api('Balance');
    const balanceEnPar = parseFloat(balanceResult[cleanPair]) || 0;

    if (balanceEnPar > 8) {
      console.log(`⚠️ Ya tienes ${balanceEnPar} en ${cleanPair}, no se compra.`);
      return res.status(200).json({ message: `No se compra porque ya hay ${balanceEnPar} en Kraken para ${cleanPair}` });
    }

    const ticker = await axios.get(`https://api.kraken.com/0/public/Ticker?pair=${cleanPair}`);
    const price = parseFloat(ticker.data.result[cleanPair].c[0]);
    const quantity = Math.floor((amount / price) * 100000000) / 100000000;

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