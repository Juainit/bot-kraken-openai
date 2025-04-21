require("dotenv").config();
const { Client } = require("pg");
const KrakenClient = require("kraken-api");

const kraken = new KrakenClient(process.env.API_KEY, process.env.API_SECRET);

async function sincronizarTrades() {
  console.log("🔄 Iniciando sincronización de trades cerrados...");
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();

    const { rows: openTrades } = await client.query(`
      SELECT * FROM trades
      WHERE status = 'abierto'
    `);

    for (const trade of openTrades) {
      const pair = trade.pair.replace("/", "").toUpperCase();
      const { result } = await kraken.api("Balance");

      const base = pair.replace("USD", "").replace("EUR", "");
      const balance = parseFloat(result[base] || "0");

      if (balance < trade.quantity * 0.01) {
        const sellPrice = trade.highestPrice;
        const profit = ((sellPrice - trade.buyPrice) / trade.buyPrice) * 100;

        await client.query(`
          UPDATE trades
          SET status = 'cerrado',
              sellPrice = $1,
              sellTime = NOW(),
              profitPercent = $2
          WHERE id = $3
        `, [sellPrice, profit.toFixed(2), trade.id]);

        console.log(`✅ Trade cerrado sincronizado: ${trade.pair}, ID: ${trade.id}`);
      } else {
        console.log(`📈 Trade sigue abierto: ${trade.pair}, balance: ${balance}`);
      }
    }

    await client.end();
    console.log("🟢 Sincronización completada.");
  } catch (error) {
    console.error("❌ Error al sincronizar:", error);
    await client.end();
  }
}

module.exports = sincronizarTrades;