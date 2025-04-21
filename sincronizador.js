const db = require("./db");
const kraken = require("./krakenClient");
const dayjs = require("dayjs");

console.log("🔄 Iniciando sincronización de trades completados...");

async function sincronizarTrades() {
  try {
    const trades = await db.all(`SELECT * FROM trades WHERE status = 'completed'`);

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

        await db.run(
          `UPDATE trades
           SET sellprice = ?,
               status = 'completed',
               profitpercent = ?,
               createdat = createdat
           WHERE id = ?`,
          [sellPrice, profitPercent, trade.id]
        );

        console.log(`✅ Trade ${trade.id} sincronizado con venta a ${sellPrice}`);
      }
    }

    console.log("🟢 Sincronización completada.");
  } catch (error) {
    console.error("❌ Error al sincronizar:", error);
  }
}

sincronizarTrades();