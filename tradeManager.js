// ⏱️ tradeManager con feeEUR incluido
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

const ordenesLimitadas = new Map();
const preciosStop = new Map();

client.connect()
  .then(() => {
    console.log("🛢️ Conectado a PostgreSQL");
    setInterval(updateTrades, 60 * 1000);
  })
  .catch(err => console.error("❌ Error al conectar a la base de datos:", err));

async function updateTrades() {
  try {
    const res = await client.query("SELECT * FROM trades WHERE status = 'active'");

    for (const trade of res.rows) {
      const { pair, quantity, highestprice, stoppercent, buyprice, id } = trade;

      const ticker = await kraken.api("Ticker", { pair });
      const price = parseFloat(ticker.result[Object.keys(ticker.result)[0]].c[0]);

      const stopPrice = highestprice * (1 - stoppercent / 100);
      const preLimitPrice = highestprice * (1 - 0.75 * stoppercent / 100);
      preciosStop.set(pair, stopPrice);

      // Actualizar si sube
      if (price > highestprice) {
        await client.query("UPDATE trades SET highestPrice = $1 WHERE id = $2", [price, id]);
        if (ordenesLimitadas.has(pair)) {
          await kraken.cancelOrder(ordenesLimitadas.get(pair));
          ordenesLimitadas.delete(pair);
          console.log(`🔄 Orden limitada cancelada por subida: ${pair}`);
        }
        continue;
      }

      // Crear orden limitada
      if (!ordenesLimitadas.has(pair) && price <= preLimitPrice) {
        const limitOrderId = await kraken.sellLimit(pair, quantity, price);
        if (limitOrderId) {
          ordenesLimitadas.set(pair, limitOrderId);
          console.log(`🧷 Venta LIMIT colocada para ${pair} a ${price.toFixed(5)}`);
        }
        continue;
      }

      // Venta de emergencia
      const emergencyThreshold = stopPrice * 0.8;
      if (ordenesLimitadas.has(pair) && price <= emergencyThreshold) {
        const sellOrder = await kraken.sell(pair, quantity);
        const sellPrice = price;

        let feeEUR = 0;

        if (sellOrder?.result?.txid?.[0]) {
          const orderId = sellOrder.result.txid[0];
          const executed = await kraken.checkOrderExecuted(orderId);

          if (executed && executed.fee) {
            feeEUR = parseFloat(executed.fee);
          }
        }

        const profitPercent = ((sellPrice - buyprice) / buyprice) * 100;

        await client.query(
          "UPDATE trades SET status = 'completed', sellPrice = $1, profitPercent = $2, feeEUR = $3 WHERE id = $4",
          [sellPrice.toFixed(5), profitPercent.toFixed(2), feeEUR.toFixed(5), id]
        );

        console.log(`💥 Venta ejecutada: ${pair} @ ${sellPrice} EUR, fee: ${feeEUR} EUR`);
        ordenesLimitadas.delete(pair);
        preciosStop.delete(pair);
      }
    }
  } catch (err) {
    console.error("❌ Error en updateTrades:", err);
  }
}