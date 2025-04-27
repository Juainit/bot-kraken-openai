// ✅ Versión segura y optimizada
require("dotenv").config();
const { Pool } = require("pg");

// Configuración de PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway") 
    ? { rejectUnauthorized: false } 
    : false
});

const kraken = require("./krakenClient");

// Sistema de caché
const priceCache = new Map();
const CACHE_DURATION = 60000;

setInterval(() => {
  const now = Date.now();
  priceCache.forEach((value, key) => {
    if (now - value.timestamp > CACHE_DURATION) priceCache.delete(key);
  });
}, 60000);

async function getCachedPrice(pair) {
  try {
    const now = Date.now();
    if (priceCache.has(pair)) {
      const cached = priceCache.get(pair);
      if (now - cached.timestamp < CACHE_DURATION) return cached.price;
    }
    const price = await kraken.getTicker(pair);
    if (price !== undefined) priceCache.set(pair, { price, timestamp: now });
    return price;
  } catch (error) {
    console.error(`❌ Error al obtener precio de ${pair}:`, error.message);
    return null;
  }
}

async function retry(fn, intentos = 3, delay = 1000) {
  try {
    return await fn();
  } catch (err) {
    if (intentos <= 1) throw err;
    await new Promise(r => setTimeout(r, delay));
    return retry(fn, intentos - 1, delay * 2);
  }
}

async function actualizarHighestPrice(tradeId, nuevaHighest) {
  await pool.query(
    "UPDATE trades SET highestprice = $1 WHERE id = $2",
    [nuevaHighest, tradeId]
  );
}

async function manejarVentaLimit(trade, stopPrice) {
  try {
    const orderId = await retry(() => 
      kraken.sellLimit(trade.pair, trade.quantity, stopPrice), 
      3
    );
    await pool.query(
      "UPDATE trades SET limitorderid = $1 WHERE id = $2",
      [orderId, trade.id]
    );
    console.log(`🧾 Orden límite colocada: ${trade.pair} @ ${stopPrice}`);
  } catch (err) {
    console.error(`❌ Falló límite ${trade.pair}:`, err.message);
    await manejarVentaEmergencia(trade, await getCachedPrice(trade.pair));
  }
}

async function manejarVentaEmergencia(trade, marketPrice) {
  try {
    if (trade.limitorderid) {
      await kraken.cancelOrder(trade.limitorderid);
      await pool.query("UPDATE trades SET limitorderid = NULL WHERE id = $1", [trade.id]);
    }
    const orden = await retry(() => kraken.sell(trade.pair, trade.quantity), 3);
    const txid = orden.result.txid[0];
    const ejecucion = await verificarEjecucionOrden(txid);
    await pool.query("BEGIN");
    await pool.query(
      `UPDATE trades 
       SET status = 'completed', 
           sellprice = $1, 
           feeeur = $2,
           profitpercent = ROUND((($1 - buyprice) / buyprice * 100)::numeric, 2)
       WHERE id = $3`,
      [ejecucion.price, ejecucion.fee, trade.id]
    );
    await pool.query("COMMIT");
    console.log(`🚨 Venta EMERGENCIA: ${trade.quantity} ${trade.pair} @ ${ejecucion.price}`);
  } catch (error) {
    await pool.query("ROLLBACK");
    console.error(`❌ Falló venta emergencia ${trade.pair}:`, error.message);
    await pool.query("UPDATE trades SET status = 'failed' WHERE id = $1", [trade.id]);
  }
}

async function verificarEjecucionOrden(txid, intentos = 5) {
  for (let i = 0; i < intentos; i++) {
    const estado = await kraken.checkOrderExecuted(txid);
    if (estado?.status === 'closed') return estado;
    await new Promise(r => setTimeout(r, 3000));
  }
  throw new Error("Orden no ejecutada después de múltiples intentos");
}

async function verificarDisponibilidadVenta(trade, balance) {
  const baseAsset = trade.pair.replace(/[^A-Z]/g, "").slice(0, 3);
  const balanceDisponible = parseFloat(balance[baseAsset] || 0);
  if (balanceDisponible < trade.quantity * 0.9) {
    console.warn(`⚠️ Bajo saldo en ${baseAsset}: ${balanceDisponible}`);
    return false;
  }
  return true;
}

async function updateTrades() {
  try {
    // 1. Obtener trades activos con todos los campos necesarios
    const { rows: tradesActivos } = await pool.query(`
      SELECT 
        id, pair, quantity, buyprice, highestprice, 
        stoppercent, limitorderid, createdat
      FROM trades 
      WHERE status = 'active'
    `);
    
    if (!tradesActivos.length) {
      console.log("⏭ No hay trades activos");
      return;
    }

    // 2. Obtener precios y balance en paralelo para eficiencia
    const [precios, balance] = await Promise.all([
      Promise.allSettled(tradesActivos.map(trade => getCachedPrice(trade.pair))),
      retry(() => kraken.getBalance(), 3)
    ]);

    if (!balance || Object.keys(balance).length === 0) {
      console.warn("⚠️ Balance no disponible - Ciclo omitido");
      return;
    }

    // 3. Procesar cada trade con validaciones mejoradas
    for (const [i, trade] of tradesActivos.entries()) {
      const { id, pair, createdat, limitorderid, quantity } = trade;
      
      // Validación de trade reciente (2 minutos de protección)
      if (Date.now() - new Date(createdat).getTime() < 120000) {
        console.log(`⏳ ${pair}: Trade muy reciente`);
        continue;
      }

      // ===== [NUEVO] Validación de saldo en tiempo real =====
      const asset = pair.replace(/USD$|EUR$/, '');
      const saldoActual = parseFloat(balance[asset] || 0);
      
      if (saldoActual < quantity) {
        console.log(`🛑 Saldo insuficiente: ${pair} (${saldoActual} < ${quantity})`);
        await pool.query("UPDATE trades SET status='failed' WHERE id=$1", [id]);
        continue;
      }
      // ======================================================

      const marketPrice = precios[i]?.value;
      if (!marketPrice) {
        console.warn(`⚠️ ${pair}: Precio no disponible`);
        continue;
      }

      // Lógica de trailing stop
      const nuevaHighest = Math.max(trade.highestprice, marketPrice);
      const trailingValue = nuevaHighest * (trade.stoppercent / 100);
      const stopPrice = nuevaHighest - trailingValue;
      
      // Niveles clave para toma de decisiones
      const limiteVenta = nuevaHighest - (trailingValue * 0.98);
      const nivelEmergencia = stopPrice - (trailingValue * 0.02);

      // Actualizar precio máximo si es necesario
      if (nuevaHighest > trade.highestprice) {
        await actualizarHighestPrice(trade.id, nuevaHighest);
        
        // [NUEVO] Cancelar orden previa con delay de 2s
        if (limitorderid) {
          await kraken.cancelOrder(limitorderid);
          await pool.query("UPDATE trades SET limitorderid = NULL WHERE id = $1", [trade.id]);
          console.log(`🛑 Orden cancelada: ${pair}`);
          await new Promise(resolve => setTimeout(resolve, 2000)); // Evitar rate limit
        }
      }

      // Estrategia de venta
      if (marketPrice <= limiteVenta) {
        await manejarVentaLimit(trade, stopPrice);
      } else if (marketPrice <= nivelEmergencia) {
        await manejarVentaEmergencia(trade, marketPrice);
      }

      // [NUEVO] Verificación final de disponibilidad
      const puedeVender = await verificarDisponibilidadVenta(trade, balance);
      if (!puedeVender) {
        console.warn(`⏸️ ${pair}: Saldo insuficiente post-validación`);
      }
    }
  } catch (err) {
    console.error("❌ Error crítico en updateTrades:", err.message);
    // [NUEVO] Notificar a sistema de monitoreo externo
    // enviarAlertaSlack(`Fallo en updateTrades: ${err.message}`);
  }
}

// Ejecutar cada 3 minutos
setInterval(updateTrades, 180000);