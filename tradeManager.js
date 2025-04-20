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

      const price = await kraken.getTicker(pair);
      if (!price) continue;

      const stopPrice = highestprice * (1 - stoppercent / 100);
      const preLimitTrigger = highestprice * (1 - 0.75 * stoppercent / 100);
      const emergencyTrigger = stopPrice * 0.8;

      preciosStop.set(pair, stopPrice);

      // Validar si orden LIMIT anterior ya fue ejecutada
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

      // Si el precio sube → cancelar orden LIMIT y actualizar trailing
      if (price > highestprice) {
        await client.query("UPDATE trades SET highestPrice = $1 WHERE id = $2", [price, id]);
        if (ordenesLimitadas.has(pair)) {
          await kraken.cancelOrder(ordenesLimitadas.get(pair));
          ordenesLimitadas.delete(pair);
          console.log(`🔄 Orden limitada cancelada por subida: ${pair}`);
        }
        continue;
      }

      // Colocar orden limitada si no existe y cae 75 % del trailing
      if (!ordenesLimitadas.has(pair) && price <= preLimitTrigger) {
        const limitOrderId = await kraken.sellLimit(pair, quantity, stopPrice);
        if (limitOrderId) {
          ordenesLimitadas.set(pair, limitOrderId);
          console.log(`🧷 Venta LIMIT colocada para ${pair} a ${stopPrice.toFixed(5)}`);
        } else {
          console.error(`❌ No se pudo colocar orden LIMIT para ${pair}`);
        }
        continue;
      }

      // Venta de emergencia si cae por debajo del 80 % del trailing
      if (ordenesLimitadas.has(pair) && price <= emergencyTrigger) {
        console.log(`⚠️ Activando venta de emergencia para ${pair}`);
        const sellOrder = await kraken.sell(pair, quantity);

        if (!sellOrder || !sellOrder.result?.txid?.[0]) {
          console.error(`❌ Venta de emergencia fallida para ${pair}: Kraken no devolvió txid.`);
          continue;
        }

        const orderId = sellOrder.result.txid[0];
        const executed = await kraken.checkOrderExecuted(orderId);

        if (!executed) {
          console.error(`❌ Kraken no confirma ejecución de venta de emergencia para ${pair}`);
          continue;
        }

        const sellPrice = executed.price;
        const fee = executed.fee || 0;
        const profitPercent = ((sellPrice - buyprice) / buyprice) * 100;

        await client.query(
          "UPDATE trades SET status = 'completed', sellPrice = $1, profitPercent = $2, feeEUR = $3 WHERE id = $4",
          [sellPrice.toFixed(5), profitPercent.toFixed(2), fee.toFixed(5), id]
        );

        ordenesLimitadas.delete(pair);
        preciosStop.delete(pair);
        console.log(`💥 Venta de emergencia ejecutada: ${pair} a ${sellPrice}, fee: ${fee}`);
      }
    }
  } catch (err) {
    console.error("❌ Error en updateTrades:", err);
  }
}