const { Pool } = require("pg");
const kraken = require("./krakenClient");
const dayjs = require("dayjs");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway")
    ? { rejectUnauthorized: false }
    : false,
});

module.exports = async function sincronizarTrades() {
  const client = await pool.connect();
  
  try {
    await client.query("BEGIN");
    console.log("🔄 Iniciando sincronización...");

    // 1. Actualizar ventas faltantes con transacción
    const { rows: trades } = await client.query(
      `SELECT * FROM trades WHERE status = 'active'`
    );

    for (const trade of trades) {
      if (!trade.limitorderid) continue;
      
      const result = await kraken.checkOrderExecuted(trade.limitorderid);
      if (result?.status === "closed") {
        await client.query(
          `UPDATE trades 
           SET status = 'completed', sellprice = $1, feeeur = $2, profitpercent = $3 
           WHERE id = $4`,
          [result.price, result.fee, 
           ((result.price - trade.buyprice) / trade.buyprice) * 100, 
           trade.id]
        );
        console.log(`✅ Venta sincronizada: ${trade.pair}`);
      }
    }

    // 2. Añadir compras con validación mejorada por limitorderid
    const krakenTrades = await kraken.api("ClosedOrders", {});
    const closedOrders = krakenTrades.result.closed || {};
    
    // Obtener todos los limitorderids existentes
    const dbTrades = await client.query("SELECT limitorderid FROM trades");
    
    for (const [txid, order] of Object.entries(closedOrders)) {
      // 1. Validar si el trade ya existe en la BD
      const existeEnBD = dbTrades.rows.some(t => t.limitorderid === txid);
      if (existeEnBD) continue;

      // 2. Filtrar solo órdenes de compra ejecutadas
      if (order.descr.type !== "buy" || order.status !== "closed") continue;

      // 3. Insertar nuevo trade con todos los campos necesarios
      await client.query(
        `INSERT INTO trades (
          pair, quantity, buyprice, 
          highestprice, stoppercent, 
          status, createdat, feeeur,
          limitorderid
        ) VALUES (
          $1, $2, $3,
          $3, $4,  -- highestprice = buyprice inicialmente
          'active', $5, $6,
          $7
        )`,
        [
          order.descr.pair.toUpperCase(),
          parseFloat(order.vol_exec),
          parseFloat(order.price),
          4,  // % stop inicial
          dayjs.unix(order.closetm).toISOString(),
          parseFloat(order.fee || 0),
          txid  // ID de la orden en Kraken
        ]
      );
      console.log(`➕ Trade sincronizado desde Kraken: ${order.descr.pair}`);
    }

    // 3. Validación de balances reales
    const balanceReal = await kraken.getBalance();
    const { rows: activeTrades } = await client.query(
      "SELECT * FROM trades WHERE status = 'active'"
    );

    for (const trade of activeTrades) {
      const asset = trade.pair.replace(/USD|EUR/g, '');
      
      if (parseFloat(balanceReal[asset] || 0) < trade.quantity) {
        console.log(`🛑 Saldo insuficiente: ${trade.pair}`);
        await client.query(
          "UPDATE trades SET status = 'failed' WHERE id = $1",
          [trade.id]
        );
      }
    }

    await client.query("COMMIT");
    console.log("✅ Sincronización completa");
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("❌ Error en sincronización:", error);
    throw error;
  } finally {
    client.release();
  }
};