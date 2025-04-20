// ⏱️ tradeManager iniciado
console.log("⏱️ tradeManager iniciado");

require("dotenv").config();
const { Client } = require("pg");
const kraken = require("./krakenClient");
const { TRADE_AMOUNT_EUR } = require("./utils/constants");

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("railway")
    ? { rejectUnauthorized: false }
    : false,
});

async function updateTrades() {
  try {
    await client.connect();
    const res = await client.query(
      "SELECT * FROM trades WHERE status = 'active'"
    );
    for (const trade of res.rows) {
      const ticker = await kraken.api("Ticker", { pair: trade.pair });
      const price = parseFloat(
        ticker.result[Object.keys(ticker.result)[0]].c[0]
      );
      if (price > trade.highestprice) {
        await client.query(
          "UPDATE trades SET highestPrice = $1 WHERE id = $2",
          [price, trade.id]
        );
      }
      const stopPrice = trade.highestprice * (1 - trade.stoppercent / 100);
      if (price <= stopPrice) {
        const response = await kraken.api("AddOrder", {
          pair: trade.pair,
          type: "sell",
          ordertype: "market",
          volume: trade.quantity,
        });

        const sellPrice = price;
        const profitPercent = ((sellPrice - trade.buyprice) / trade.buyprice) * 100;

        await client.query(
          "UPDATE trades SET status = 'completed', sellPrice = $1, profitPercent = $2 WHERE id = $3",
          [sellPrice.toFixed(5), profitPercent.toFixed(2), trade.id]
        );

        console.log(
          `📉 Venta ejecutada por trailing stop: ${trade.pair}, Cantidad: ${trade.quantity}, Precio: ${sellPrice}, Beneficio: ${profitPercent.toFixed(2)}%`
        );
      }
    }
  } catch (err) {
    console.error("❌ Error en updateTrades:", err);
  } finally {
    await client.end();
  }
}

setInterval(updateTrades, 60 * 1000);
