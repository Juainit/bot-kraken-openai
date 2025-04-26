require("dotenv").config(); // ✅ Carga primero las variables

const { Pool } = require("pg");
const kraken = require("./krakenClient");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://postgres:oGaCnBFsBUlnePPStrsDgHYxbNXDApGR@shinkansen.proxy.rlwy.net:45439/railway", // ✅ Fallback
  ssl: (process.env.DATABASE_URL || "").includes("railway") // ✅ Protege contra undefined
    ? { rejectUnauthorized: false }
    : false
});

// Cache para precios
const priceCache = {};
const CACHE_DURATION = 60000; // 1 minuto

async function getCachedPrice(pair) {
  const now = Date.now();
  if (priceCache[pair] && (now - priceCache[pair].timestamp) < CACHE_DURATION) {
    return priceCache[pair].price;
  }
  const price = await kraken.getTicker(pair);
  if (price) {
    priceCache[pair] = { price, timestamp: now };
  }
  return price;
}

async function updateTrades() {
  try {
    const { rows: tradesActivos } = await pool.query(
      "SELECT * FROM trades WHERE status = 'active'"
    );

    if (tradesActivos.length === 0) {
      console.log("⏭ No hay trades activos, omitiendo ciclo");
      return;
    }

    const pricePromises = tradesActivos.map(trade => getCachedPrice(trade.pair));
    const prices = await Promise.all(pricePromises);

    // ✅ Solo UNA llamada a getBalance()
    const balance = await kraken.getBalance();
    if (!balance || Object.keys(balance).length === 0) {
      console.warn("⚠️ Kraken devolvió balance vacío. Se omite ciclo completo.");
      return;
    }

    for (let i = 0; i < tradesActivos.length; i++) {
      const trade = tradesActivos[i];
      // ⏳ Espera de 2 minutos antes de evaluar trailing
const creadoHaceMs = Date.now() - new Date(trade.createdat).getTime();
if (creadoHaceMs < 120000) {
  console.log(`⏳ Trade ${trade.pair} creado hace menos de 2 minutos. Se omite este ciclo.`);
  continue;
}
      const marketPrice = prices[i];
      if (!marketPrice) {
        console.warn(`⚠️ No se pudo obtener precio para ${trade.pair}, omitiendo`);
        continue;
      }

      const {
        id,
        pair,
        quantity,
        buyprice,
        highestprice,
        stoppercent,
        limitorderid,
      } = trade;

        // Revisar si hay una orden LIMIT cerrada (ejecutada)
  if (limitorderid) {
    const ejecucion = await kraken.checkOrderExecuted(limitorderid);

    if (ejecucion?.status === "closed") {
      const { price: sellPrice, fee } = ejecucion;
      const profitPercent = ((sellPrice - buyprice) / buyprice) * 100;

      await pool.query(
        `UPDATE trades 
         SET status = 'completed', sellPrice = $1, feeEUR = $2, profitPercent = $3, limitorderid = NULL 
         WHERE id = $4`,
        [sellPrice, fee, profitPercent, id]
      );

      console.log(`✅ Trade cerrado por ejecución de LIMIT: ${pair} a ${sellPrice}`);
      continue; // Ya no hay que procesar más este trade
    }
  }

      const nuevaHighest = Math.max(highestprice, marketPrice);
      const stopPrice = parseFloat((nuevaHighest * (1 - stoppercent / 100)).toFixed(6));

      if (nuevaHighest > highestprice) {
        await pool.query("UPDATE trades SET highestPrice = $1 WHERE id = $2", [
          nuevaHighest,
          id,
        ]);
        if (limitorderid) {
          await kraken.cancelOrder(limitorderid);
          await pool.query("UPDATE trades SET limitorderid = NULL WHERE id = $1", [id]);
          console.log(`❌ Orden LIMIT cancelada antes de venta de emergencia: ${pair}`);
        
          // 🕐 Esperamos a que Kraken libere el saldo reservado
          console.log(`⏳ Esperando liberación de saldo para ${pair}...`);
          await new Promise(resolve => setTimeout(resolve, 1500));
        }
      }

      console.log(`\n📈 Precio actual de ${pair}: ${marketPrice}`);

      const baseAsset = pair.replace(/(USD|EUR)$/, "");
      const balanceDisponible = parseFloat(balance?.[baseAsset] || 0);
      const cantidadVendible = Math.min(balanceDisponible, quantity);

      
      if (cantidadVendible < 0.00001) {
        console.warn(`⚠️ Cantidad insuficiente de ${baseAsset} para vender ${pair}. Disponible: ${balanceDisponible}`);

        if (limitorderid) {
          const ejecucion = await kraken.checkOrderExecuted(limitorderid);

          if (ejecucion?.status === "closed") {
            const { price: sellPrice, fee } = ejecucion;
            const profitPercent = ((sellPrice - buyprice) / buyprice) * 100;

            await pool.query(
              `UPDATE trades 
               SET status = 'completed', sellPrice = $1, feeEUR = $2, profitPercent = $3, limitorderid = NULL 
               WHERE id = $4`,
              [sellPrice, fee, profitPercent, id]
            );

            console.log(`✅ Trade cerrado por ejecución de LIMIT (sin saldo): ${pair} a ${sellPrice}`);
          } else {
            console.log(`⏸ Orden LIMIT aún activa pero sin saldo: ${pair}`);
          }
        } else {
          await pool.query(
            `UPDATE trades SET status = 'cancelled' WHERE id = $1`,
            [id]
          );
          console.log(`🚫 Trade cancelado automáticamente por saldo 0 sin LIMIT: ${pair}`);
        }

        continue;
      }

if (marketPrice < stopPrice) {
  console.log(`🛑 Activado STOP para ${pair}`);
  
  // 1. Cancelar orden límite si existe
  if (limitorderid) {
    await kraken.cancelOrder(limitorderid);
    await pool.query("UPDATE trades SET limitorderid = NULL WHERE id = $1", [id]);
    console.log(`❌ Orden LIMIT cancelada antes de venta de emergencia: ${pair}`);
    await new Promise(resolve => setTimeout(resolve, 1000)); // Esperar liberación de saldo
  }

  // 2. Validar cantidad vendible
  if (cantidadVendible < 0.00001) {
    console.warn(`⚠️ Cantidad insuficiente de ${baseAsset} para vender ${pair}. Disponible: ${balanceDisponible}`);
    continue;
  }

  // 🚀 3. VALIDACIÓN NUMÉRICA Y SEGURIDAD AÑADIDA
  const numericMarketPrice = parseFloat(marketPrice);
  if (isNaN(numericMarketPrice)) {
    console.error(`❌ Precio de mercado inválido para ${pair}: ${marketPrice}`);
    continue;
  }

  // 4. Ejecutar venta en Kraken
  const orden = await kraken.sell(pair, cantidadVendible);
  if (!orden) {
    console.error(`❌ No se pudo vender ${pair}`);
    continue;
  }

  // 5. Verificar ejecución
  const txid = orden.result.txid[0];
  const ejecucion = await kraken.checkOrderExecuted(txid);
  if (!ejecucion || ejecucion.status !== "closed") {
    console.warn(`⏳ Venta no ejecutada aún para ${pair}`);
    continue;
  }

  // 🚀 6. ACTUALIZACIÓN SEGURA DE LA DB
  const { price: sellPrice, fee } = ejecucion;
  const numericSellPrice = parseFloat(sellPrice);
  const numericFee = parseFloat(fee);

  await pool.query(
    `UPDATE trades 
     SET status = 'completed', 
         sellPrice = $1, 
         "feeEUR" = $2, 
         profitPercent = (($1 - buyprice) / buyprice) * 100
     WHERE id = $3`,
    [numericSellPrice, numericFee, id]  // 🚀 Parámetros preparados
  );
  console.log(`✅ VENTA ejecutada: ${cantidadVendible} ${pair} a ${numericSellPrice}`);

} else if (!limitorderid) {
  // ... (mantener lógica existente de órdenes límite)
}
    }
  } catch (err) {
    console.error("❌ Error en updateTrades:", err);
  }
}

// ✅ Ejecutar cada 5 minutos
setInterval(updateTrades, 300000);