require("dotenv").config();
const { Client } = require("pg");
const kraken = require("./krakenClient");

const pair = process.argv[2] || "ADAEUR";

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("railway")
    ? { rejectUnauthorized: false }
    : false,
});

client.connect().then(() => {
  console.log("📡 Conectado a la base de datos");
  vender(pair);
});

async function vender(pair) {
  try {
    const res = await client.query(
      "SELECT * FROM trades WHERE pair = $1 AND status = 'active' ORDER BY createdAt DESC LIMIT 1",
      [pair]
    );

    if (res.rows.length === 0) {
      console.log(`ℹ️ No hay ninguna operación activa para ${pair}. No se vendió nada.`);
      return;
    }

    const trade = res.rows[0];
    const { quantity, buyprice, id } = trade;

    console.log(`💣 Vendiendo el 100% de ${pair}: ${quantity} unidades`);

    const orden = await kraken.sell(pair, quantity);

    if (!orden?.result?.txid?.[0]) {
      console.error(`❌ Kraken no devolvió txid para la orden de venta de ${pair}`);
      return;
    }

    const ordenInfo = await kraken.checkOrderExecuted(orden.result.txid[0]);

    if (!ordenInfo || ordenInfo.status !== "closed") {
      console.error(`❌ La orden de venta no fue confirmada como ejecutada para ${pair}`);
      return;
    }

    const sellPrice = ordenInfo.price;
    const fee = ordenInfo.fee || 0;
    const profit = ((sellPrice - buyprice) / buyprice) * 100;

    await client.query(
      "UPDATE trades SET status = 'completed', sellPrice = $1, profitPercent = $2, feeEUR = $3 WHERE id = $4",
      [sellPrice.toFixed(5), profit.toFixed(2), fee.toFixed(5), id]
    );

    console.log(`✅ Venta completada de ${pair}`);
    console.log(`💰 Precio de venta: ${sellPrice.toFixed(5)} EUR`);
    console.log(`📈 Beneficio: ${profit.toFixed(2)}%`);
    console.log(`💸 Fee aplicado: ${fee.toFixed(5)} ${pair.slice(-3)}`);
  } catch (err) {
    console.error("❌ Error al ejecutar venta manual:", err);
  }
}