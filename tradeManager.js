const { Pool } = require("pg");
const kraken = require("./krakenClient");
require("dotenv").config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("railway")
    ? { rejectUnauthorized: false }
    : false,
});

async function updateTrades() {
  try {
    const { rows: tradesActivos } = await pool.query(
      "SELECT * FROM trades WHERE status = 'active'"
    );

    for (const trade of tradesActivos) {
      const { id, pair, quantity, buyprice, highestprice, stoppercent } = trade;

      const marketPrice = await kraken.getTicker(pair);
      if (!marketPrice) continue;

      const stopPrice = highestprice * (1 - stoppercent / 100);
      const nuevaHighest = Math.max(highestprice, marketPrice);

      await pool.query(
        "UPDATE trades SET highestPrice = $1 WHERE id = $2",
        [nuevaHighest, id]
      );

      console.log(`\n📈 Precio actual de ${pair}: ${marketPrice}`);

      if (marketPrice < stopPrice) {
        console.log(`🛑 Activado STOP para ${pair}`);

        // Validar cantidad vendible actual
        const balance = await kraken.getBalance();
        const baseAsset = pair.slice(0, 3);
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

        if (!ejecucion || ejecucion.status !== 'closed') {
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
      } else {
        // Intento de venta límite (si stop activado pero no aún por debajo)
        const precioLimite = parseFloat((marketPrice * 1.01).toFixed(4));

        const balance = await kraken.getBalance();
        const baseAsset = pair.slice(0, 3);
        const balanceDisponible = parseFloat(balance?.[baseAsset] || 0);
        const cantidadVendible = Math.min(balanceDisponible, quantity);

        if (cantidadVendible < 0.00001) {
          console.warn(`⚠️ Cantidad insuficiente de ${baseAsset} para colocar LIMIT en ${pair}`);
          continue;
        }

        const orderId = await kraken.sellLimit(pair, cantidadVendible, precioLimite);
        if (!orderId) {
          console.error(`❌ No se pudo colocar orden LIMIT para ${pair}`);
        } else {
          console.log(`📌 Orden LIMIT colocada para ${pair} a ${precioLimite}`);
        }
      }
    }
  } catch (err) {
    console.error("❌ Error en updateTrades:", err);
  }
}

setInterval(updateTrades, 15000);
