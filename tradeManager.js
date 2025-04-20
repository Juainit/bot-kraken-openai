// ⏱️ tradeManager avanzado con lógica de venta limitada y trailing CORREGIDA
console.log("⏱️ tradeManager iniciado");

require("dotenv").config();
const { Client } = require("pg");
const kraken = require("./krakenClient");

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("railway")
    ? { rejectUnauthorized: false }
    : false,
});

const ordenesLimitadas = new Map(); // Guardamos ordenes pendientes por par
const preciosStop = new Map(); // Guardamos el stopPrice real por par

async function updateTrades() {
  try {
    await client.connect();
    const res = await client.query("SELECT * FROM trades WHERE status = 'active'");

    for (const trade of res.rows) {
      const { pair, quantity, highestprice, stoppercent, buyprice, id } = trade;

      const ticker = await kraken.api("Ticker", { pair });
      const price = parseFloat(ticker.result[Object.keys(ticker.result)[0]].c[0]);

      const stopPrice = highestprice * (1 - stoppercent / 100);
      const preLimitPrice = highestprice * (1 - 0.75 * stoppercent / 100);

      preciosStop.set(pair, stopPrice); // Guardamos el stopPrice actual

      // Si el precio sube, se cancela orden limitada y se actualiza el máximo
      if (price > highestprice) {
        await client.query("UPDATE trades SET highestPrice = $1 WHERE id = $2", [price, id]);
        if (ordenesLimitadas.has(pair)) {
          await kraken.cancelOrder(ordenesLimitadas.get(pair));
          console.log(`🔄 Orden limitada cancelada por subida: ${pair}`);
          ordenesLimitadas.delete(pair);
        }
        continue;
      }

      // Colocar venta limitada si cae al 75% del stop
      if (!ordenesLimitadas.has(pair) && price <= preLimitPrice) {
        const limitOrderId = await kraken.sellLimit(pair, quantity, price);
        if (limitOrderId) {
          ordenesLimitadas.set(pair, limitOrderId);
          console.log(`🧷 Venta LIMIT colocada para ${pair} a ${price.toFixed(5)}`);
        }
        continue;
      }

      // Si ya hay venta limitada y sigue cayendo hasta 80% del stopPrice
      const emergencyThreshold = stopPrice * 0.8;
      if (ordenesLimitadas.has(pair) && price <= emergencyThreshold) {
        const response = await kraken.sell(pair, quantity);
        const sellPrice = price;
        const profitPercent = ((sellPrice - buyprice) / buyprice) * 100;

        await client.query(
          "UPDATE trades SET status = 'completed', sellPrice = $1, profitPercent = $2 WHERE id = $3",
          [sellPrice.toFixed(5), profitPercent.toFixed(2), id]
        );

        console.log(`💥 Venta a mercado forzada: ${pair} @ ${sellPrice}`);
        ordenesLimitadas.delete(pair);
        preciosStop.delete(pair);
      }
    }
  } catch (err) {
    console.error("❌ Error en updateTrades:", err);
  } finally {
    await client.end();
  }
}

setInterval(updateTrades, 60 * 1000);