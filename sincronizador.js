// sincronizador.js - Versión 2.3 (Producción)
const { Pool } = require("pg");
const kraken = require("./krakenClient");
const dayjs = require("dayjs");
const { format } = require("date-fns");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway") 
    ? { rejectUnauthorized: false } 
    : true,
  max: 10, // Conexiones máximas
  idleTimeoutMillis: 30000
});

const SYNC_INTERVAL = process.env.SYNC_INTERVAL || 180000; // 3 minutos

module.exports = async function sincronizarTrades() {
  const client = await pool.connect();
  const syncId = `SYNC-${format(new Date(), "yyyyMMdd-HHmmss")}`;
  
  try {
    console.log(`\n🔄 [${syncId}] Iniciando sincronización...`);
    await client.query("BEGIN");
    
    // 1. Sincronizar órdenes cerradas desde Kraken
    const { rows: activeTrades } = await client.query(`
      SELECT id, pair, limitorderid, quantity 
      FROM trades 
      WHERE status = 'active'
      FOR UPDATE
    `);

    await syncClosedOrders(client, activeTrades, syncId);
    
    // 2. Sincronizar nuevas compras desde Kraken
    await syncNewTrades(client, syncId);
    
    // 3. Validación de balances efectivos
    await validateBalances(client, syncId);
    
    await client.query("COMMIT");
    console.log(`✅ [${syncId}] Sincronización completada`);
    
    return { success: true, syncId };
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(`❌ [${syncId}] Error crítico: ${error.message}`);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
};

// Funciones auxiliares
async function syncClosedOrders(client, activeTrades, syncId) {
  const txids = activeTrades.map(t => t.limitorderid).filter(Boolean);
  
  if (txids.length === 0) {
    console.log(`ℹ️ [${syncId}] No hay órdenes activas para sincronizar`);
    return;
  }

  try {
    const closedOrders = await kraken.api("QueryOrders", { 
      txid: txids.join(','),
      trades: true 
    });

    for (const trade of activeTrades) {
      const order = closedOrders.result[trade.limitorderid];
      
      if (order?.status === 'closed' && parseFloat(order.vol_exec) > 0) {
        const profit = calculateProfit(trade.buyprice, order.price, order.fee);
        
        await client.query(`
          UPDATE trades 
          SET status = 'completed', 
              sellprice = $1, 
              feeeur = $2, 
              profitpercent = $3,
              updatedat = NOW()
          WHERE id = $4
        `, [order.price, order.fee, profit, trade.id]);
        
        console.log(`🔄 [${syncId}] Trade cerrado: ${trade.pair} | Beneficio: ${profit.toFixed(2)}%`);
      }
    }
  } catch (error) {
    console.error(`⚠️ [${syncId}] Error sincronizando órdenes: ${kraken.interpretarErrorKraken(error)}`);
    throw error;
  }
}

async function syncNewTrades(client, syncId) {
  try {
    const lastSync = await client.query(
      "SELECT MAX(createdat) as last_sync FROM trades"
    );
    
    const closedOrders = await kraken.api("ClosedOrders", {
      start: dayjs(lastSync.rows[0].last_sync).unix()
    });

    const existingOrders = await client.query(
      "SELECT limitorderid FROM trades"
    );

    for (const [txid, order] of Object.entries(closedOrders.result.closed || {})) {
      if (isValidTrade(order, existingOrders.rows)) {
        await insertNewTrade(client, order, txid, syncId);
      }
    }
  } catch (error) {
    console.error(`⚠️ [${syncId}] Error sincronizando nuevas compras: ${error.message}`);
    throw error;
  }
}

async function validateBalances(client, syncId) {
  try {
    const { rows: activeTrades } = await client.query(`
      SELECT pair, quantity 
      FROM trades 
      WHERE status = 'active'
    `);

    const assetBalances = await kraken.getEffectiveBalances();
    
    for (const trade of activeTrades) {
      const asset = trade.pair.replace(/EUR|USD/g, '');
      
      if (assetBalances[asset] < trade.quantity) {
        console.log(`🛑 [${syncId}] Saldo insuficiente: ${trade.pair}`);
        await client.query(`
          UPDATE trades 
          SET status = 'failed', 
              error = $1 
          WHERE pair = $2 AND status = 'active'
        `, [`Saldo insuficiente: ${assetBalances[asset]} < ${trade.quantity}`, trade.pair]);
      }
    }
  } catch (error) {
    console.error(`⚠️ [${syncId}] Error validando balances: ${error.message}`);
    throw error;
  }
}

function isValidTrade(order, existingOrders) {
  return order.descr.type === 'buy' &&
         order.status === 'closed' &&
         parseFloat(order.vol_exec) > 0 &&
         !existingOrders.some(t => t.limitorderid === txid);
}

async function insertNewTrade(client, order, txid, syncId) {
  const pair = order.descr.pair.toUpperCase();
  const { decimales } = await kraken.validarPar(pair);
  
  await client.query(`
    INSERT INTO trades (
      pair, quantity, buyprice, highestprice, 
      stoppercent, status, feeeur, limitorderid, metadata
    ) VALUES (
      $1, $2, $3, $3, $4, 'active', $5, $6, $7
    )
  `, [
    pair,
    parseFloat(order.vol_exec).toFixed(decimales.cantidad),
    parseFloat(order.price).toFixed(decimales.precio),
    process.env.DEFAULT_STOP_PERCENT || 4,
    parseFloat(order.fee),
    txid,
    {
      source: 'sync',
      kraken_data: order,
      sync_id: syncId
    }
  ]);
  
  console.log(`➕ [${syncId}] Nuevo trade sincronizado: ${pair}`);
}

function calculateProfit(buyPrice, sellPrice, fee) {
  const profit = ((sellPrice - buyPrice) / buyPrice) * 100;
  return parseFloat((profit - (fee / buyPrice * 100)).toFixed(2);
}
