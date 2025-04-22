const { Pool } = require("pg");
const kraken = require("./krakenClient");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("railway")
    ? { rejectUnauthorized: false }
    : false,
});

// Cache para almacenar precios y evitar consultas repetidas
const priceCache = {};
const CACHE_DURATION = 60000; // 1 minuto en milisegundos

async function getCachedPrice(pair) {
  const now = Date.now();
  
  if (priceCache[pair] && (now - priceCache[pair].timestamp) < CACHE_DURATION) {
    return priceCache[pair].price;
  }

  const price = await kraken.getTicker(pair);
  if (price) {
    priceCache[pair] = {
      price: price,
      timestamp: now
    };
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

    // Primero obtenemos todos los precios necesarios en una sola pasada
    const pricePromises = tradesActivos.map(trade => getCachedPrice(trade.pair));
    const prices = await Promise.all(pricePromises);

    for (let i = 0; i < tradesActivos.length; i++) {
      const trade = tradesActivos[i];
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
          console.log(`❌ Orden LIMIT cancelada por subida de precio: ${pair}`);
        }
      }

      console.log(`\n📈 Precio actual de ${pair}: ${marketPrice}`);

      const baseAsset = pair.replace(/(USD|EUR)$/, "");
      const balance = await kraken.getBalance();

      if (!balance || Object.keys(balance).length === 0) {
        console.warn(`⚠️ Kraken devolvió balance vacío para ${pair}. Se omite este ciclo.`);
        continue;
      }

      if (marketPrice < stopPrice) {
        console.log(`🛑 Activado STOP para ${pair}`);

        if (limitorderid) {
          await kraken.cancelOrder(limitorderid);
          await pool.query("UPDATE trades SET limitorderid = NULL WHERE id = $1", [id]);
          console.log(`❌ Orden LIMIT cancelada antes de venta de emergencia: ${pair}`);
        }

        const balanceDisponible = parseFloat(balance?.[baseAsset] || 0);
        const cantidadVendible = Math.min(balanceDisponible, quantity);

        if (cantidadVendible < 0.00001) {
          console.warn(`⚠️ Cantidad insuficiente de ${baseAsset} para vender ${pair}. Disponible: ${balanceDisponible}`);
          continue;
        }

        const orden = await kraken.sell(pair, cantidadVendible);
        if (!orden) {
          console.error(`❌ No se pudo vender ${pair}`);
          continue;
        }

        const txid = orden.result.txid[0];
        const ejecucion = await kraken.checkOrderExecuted(txid);

        if (!ejecucion || ejecucion.status !== "closed") {
          console.warn(`⏳ Venta no ejecutada aún para ${pair}`);
          continue;
        }

        const { price: sellPrice, fee } = ejecucion;
        const profitPercent = ((sellPrice - buyprice) / buyprice) * 100;

        await pool.query(
          `UPDATE trades 
           SET status = 'completed', sellPrice = $1, feeEUR = $2, profitPercent = $3 
           WHERE id = $4`,
          [sellPrice, fee, profitPercent, id]
        );

        console.log(`✅ VENTA de emergencia ejecutada: ${cantidadVendible} ${pair} a ${sellPrice}`);
      } else if (!limitorderid) {
        const balanceDisponible = parseFloat(balance?.[baseAsset] || 0);
        const cantidadVendible = Math.min(balanceDisponible, quantity);

        if (cantidadVendible < 0.00001) {
          console.warn(`⚠️ Cantidad insuficiente de ${baseAsset} para colocar LIMIT en ${pair}`);
          continue;
        }

        const orderId = await kraken.sellLimit(pair, cantidadVendible, stopPrice);
        if (!orderId) {
          console.error(`❌ No se pudo colocar orden LIMIT para ${pair}`);
        } else {
          await pool.query("UPDATE trades SET limitorderid = $1 WHERE id = $2", [
            orderId,
            id,
          ]);
          console.log(`📌 Orden LIMIT colocada para ${pair} al STOP: ${stopPrice}`);
        }
      }
    }
  } catch (err) {
    console.error("❌ Error en updateTrades:", err);
  }
}

// Aumentamos el intervalo a 5 minutos (300000 ms) para reducir peticiones
setInterval(updateTrades, 300000);