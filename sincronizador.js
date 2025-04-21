const { Pool } = require("pg");
const kraken = require("./krakenClient");
const dayjs = require("dayjs");

console.log("🔄 Iniciando sincronización de trades completados...");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

async function sincronizarTrades() {
  try {
    const { rows: trades } = await pool.query(`SELECT * FROM trades WHERE status = 'completed'`);

    for (const trade of trades) {
      const pair = trade.pair.toUpperCase().replace("/", "");
      const krakenTrades = await kraken.api("ClosedOrders", {});

      const closedOrders = krakenTrades.result.closed || {};
      const match = Object.values(closedOrders).find(
        (order) => order.descr.pair === pair && order.status === "closed"
      );

      if (match && !trade.sellprice) {
        const sellPrice = parseFloat(match.price);
        const sellTime = dayjs.unix(match.closetm).toISOString();
        const profitPercent = ((sellPrice - trade.buyprice) / trade.buyprice) * 100;

        await pool.query(
          `UPDATE trades
           SET sellprice = $1,
               status = 'completed',
               profitpercent = $2,
               selltime = $3
           WHERE id = $4`,
          [sellPrice, profitPercent, sellTime, trade.id]
        );

        console.log(`✅ Trade ${trade.id} sincronizado con venta a ${sellPrice}`);
      }
    }
  } catch (error) {
    console.error("❌ Error al sincronizar:", error);
  }
}

module.exports = sincronizarTrades;