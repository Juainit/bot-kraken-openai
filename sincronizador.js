const { Pool } = require("pg");
const kraken = require("./krakenClient");
const dayjs = require("dayjs");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("railway")
    ? { rejectUnauthorized: false }
    : false,
});

module.exports = async function sincronizarTrades() {
  try {
    console.log("🔄 Iniciando sincronización...");

    // Actualizar ventas faltantes (ya implementado)
    const { rows: trades } = await pool.query(
      `SELECT * FROM trades WHERE status = 'active'`
    );

    for (const trade of trades) {
      if (!trade.limitorderid) continue;

      const result = await kraken.checkOrderExecuted(trade.limitorderid);

      if (result && result.status === "closed") {
        const { price: sellPrice, fee } = result;
        const profitPercent = ((sellPrice - trade.buyprice) / trade.buyprice) * 100;

        await pool.query(
          `UPDATE trades 
           SET status = 'completed', sellPrice = $1, feeEUR = $2, profitPercent = $3 
           WHERE id = $4`,
          [sellPrice, fee, profitPercent, trade.id]
        );

        console.log(`✅ Venta sincronizada: ${trade.pair} a ${sellPrice}`);
      }
    }

    // Añadir compras que faltan
    const krakenTrades = await kraken.api("ClosedOrders", {});
    const closedOrders = krakenTrades.result.closed || {};

    for (const [txid, order] of Object.entries(closedOrders)) {
      if (order.descr.type !== "buy" || order.status !== "closed") continue;

      const pair = order.descr.pair.toUpperCase();

      const { rows: existingRows } = await pool.query(
        "SELECT * FROM trades WHERE pair = $1 AND status = 'active'",
        [pair]
      );
      if (existingRows.length > 0) continue; // ya está en seguimiento

      const quantity = parseFloat(order.vol_exec);
      const buyPrice = parseFloat(order.price);
      const createdAt = dayjs.unix(order.closetm).toISOString();
      const fee = parseFloat(order.fee || 0);

      await pool.query(
        `INSERT INTO trades 
        (pair, quantity, buyprice, highestprice, stoppercent, status, createdat, "feeEUR", limitorderid)
        VALUES ($1, $2, $3, $3, 4, 'active', $4, $5, NULL)`,
        [pair, quantity, buyPrice, createdAt, fee]
      );

      console.log(`➕ Trade añadido desde Kraken: ${pair} @ ${buyPrice}`);
    }

    // Actualizar los fees de los trades existentes
    const krakenTradesHistory = await kraken.api("TradesHistory", {});
    const closedHistoryOrders = krakenTradesHistory.result.trades || {};

    const { rows: tradesWithoutFee } = await pool.query(
      "SELECT id, pair FROM trades WHERE feeEUR IS NULL OR feeEUR = 0"
    );

    for (const trade of closedHistoryOrders) {
      const fee = parseFloat(trade.fee);
      const cleanPair = trade.pair.replace(/[^a-zA-Z]/g, "").toUpperCase();

      for (const tradeWithoutFee of tradesWithoutFee) {
        if (tradeWithoutFee.pair === cleanPair) {
          await pool.query(
            `UPDATE trades SET "feeEUR" = $1 WHERE id = $2`,
            [fee, tradeWithoutFee.id]
          );
          console.log(`➕ Fee actualizado para ${cleanPair}: ${fee}`);
        }
      }
    }

    console.log("✅ Sincronización completa.");
  } catch (error) {
    console.error("❌ Error en sincronización:", error);
  }
};