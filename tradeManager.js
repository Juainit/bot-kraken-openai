// tradeManager.js - versión PostgreSQL
const { Pool } = require('pg');
const kraken = require('./krakenApiSetup');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function updateTrades() {
  const { rows: trades } = await pool.query("SELECT * FROM trades WHERE status = 'active'");

  for (const trade of trades) {
    const currentPrice = await kraken.getCurrentPrice(trade.pair);
    if (!currentPrice) continue;

    const stopPrice = trade.highestprice * (1 - trade.stoppercent / 100);
    const limitTrigger = trade.highestprice * (1 - (trade.stoppercent * 0.75) / 100);

    if (currentPrice > trade.highestprice) {
      await pool.query("UPDATE trades SET highestPrice = $1, sellPrice = NULL WHERE id = $2", [currentPrice, trade.id]);
      continue;
    }

    if (trade.sellprice && trade.sellprice.length > 4) {
      const executedPrice = await kraken.checkOrderExecuted(trade.sellprice);
      if (executedPrice) {
        const profit = ((executedPrice - trade.buyprice) / trade.buyprice) * 100;
        await pool.query("UPDATE trades SET status = 'completed', sellPrice = $1, profitPercent = $2 WHERE id = $3", [executedPrice, profit, trade.id]);
        console.log(`✅ Venta límite ejecutada para ${trade.pair}. Precio: ${executedPrice}`);
        continue;
      }
    }

    if (trade.sellprice && currentPrice > limitTrigger) {
      await kraken.cancelOrder(trade.sellprice);
      await pool.query("UPDATE trades SET sellPrice = NULL WHERE id = $1", [trade.id]);
      continue;
    }

    if (!trade.sellprice && currentPrice <= limitTrigger && currentPrice > stopPrice) {
      const orderId = await kraken.sellLimit(trade.pair, trade.quantity, stopPrice);
      if (orderId) {
        await pool.query("UPDATE trades SET sellPrice = $1 WHERE id = $2", [orderId, trade.id]);
        console.log(`📌 Venta límite colocada para ${trade.pair} a ${stopPrice}`);
      }
      continue;
    }

    if (currentPrice <= stopPrice) {
      const orderId = await kraken.sell(trade.pair, trade.quantity);
      if (orderId) {
        const finalPrice = await kraken.getCurrentPrice(trade.pair);
        const profit = ((finalPrice - trade.buyprice) / trade.buyprice) * 100;
        await pool.query("UPDATE trades SET status = 'completed', sellPrice = $1, profitPercent = $2 WHERE id = $3", [finalPrice, profit, trade.id]);
        console.log(`✅ Venta a mercado ejecutada para ${trade.pair}. Precio: ${finalPrice}`);
      } else {
        console.error(`❌ Venta a mercado fallida para ${trade.pair}, trade sigue activo`);
      }
    }
  }
}

setInterval(updateTrades, 60000);
