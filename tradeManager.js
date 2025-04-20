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

      const stopPrice = highestprice * (1 - stoppercent / 100);          // 100 % del trailing
      const preLimitTrigger = highestprice * (1 - 0.75 * stoppercent / 100); // 75 % del trailing
      const emergencyTrigger = stopPrice * 0.8; // 20 % más bajo que el límite

      preciosStop.set(pair, stopPrice);

      // Comprobamos si la orden limitada fue ejecutada por completo
      if (ordenesLimitadas.has(pair)) {
        const orderId = ordenesLimitadas.get(pair);
        const estado = await kraken.checkOrderExecuted(orderId);
        if (estado && estado.status === "closed") {
          const sellPrice = parseFloat(estado.price);
          const fee = parseFloat(estado.fee || 0);
          const profitPercent = ((sellPrice - buyprice) / buyprice) * 100;

          await client.query(
            "UPDATE trades SET status = 'completed', sellPrice = $1, profitPercent = $2, feeEUR = $3 WHERE id = $4",
            [sellPrice.toFixed(5), profitPercent.toFixed(2), fee.toFixed(5), id]
          );

          ordenesLimitadas.delete(pair);
          preciosStop.delete(pair);
          console.log(`✅ Orden LIMIT ejecutada: ${pair} @ ${sellPrice}, fee: ${fee}`);
          continue;
        }
      }

      // Si el precio sube, se reinicia trailing
      if (price > highestprice) {
        await client.query("UPDATE trades SET highestPrice = $1 WHERE id = $2", [price, id]);
        if (ordenesLimitadas.has(pair)) {
          await kraken.cancelOrder(ordenesLimitadas.get(pair));
          ordenesLimitadas.delete(pair);
          console.log(`🔄 Orden limitada cancelada por subida: ${pair}`);
        }
        continue;
      }

      // Si precio cae al 75 % del stop → colocar venta limitada al stopPrice
      if (!ordenesLimitadas.has(pair) && price <= preLimitTrigger) {
        const limitOrderId = await kraken.sellLimit(pair, quantity, stopPrice);
        if (limitOrderId) {
          ordenesLimitadas.set(pair, limitOrderId);
          console.log(`🧷 Venta LIMIT colocada para ${pair} a ${stopPrice.toFixed(5)}`);
        }
        continue;
      }

      // Si precio cae al 80 % del stop y la orden limitada no se ejecutó → venta de emergencia
      if (ordenesLimitadas.has(pair) && price <= emergencyTrigger) {
        const sellOrder = await kraken.sell(pair, quantity);
        const sellPrice = price;

        let fee = 0;
        if (sellOrder?.result?.txid?.[0]) {
          const orderId = sellOrder.result.txid[0];
          const executed = await kraken.checkOrderExecuted(orderId);
          if (executed && executed.fee) {
            fee = parseFloat(executed.fee);
          }
        }

        const profitPercent = ((sellPrice - buyprice) / buyprice) * 100;

        await client.query(
          "UPDATE trades SET status = 'completed', sellPrice = $1, profitPercent = $2, feeEUR = $3 WHERE id = $4",
          [sellPrice.toFixed(5), profitPercent.toFixed(2), fee.toFixed(5), id]
        );

        ordenesLimitadas.delete(pair);
        preciosStop.delete(pair);
        console.log(`💥 Venta de emergencia: ${pair} @ ${sellPrice} EUR, fee: ${fee}`);
      }
    }
  } catch (err) {
    console.error("❌ Error en updateTrades:", err);
  }
}