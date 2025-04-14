const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const kraken = require('./krakenApiSetup');

(async () => {
  const db = await open({
    filename: './trades.db',
    driver: sqlite3.Database
  });

  async function updateTrades() {
    const trades = await db.all("SELECT * FROM trades WHERE status = 'active'");
    
    for (const trade of trades) {
      const currentPrice = await kraken.getCurrentPrice(trade.pair);
      if (!currentPrice) continue;

      const stopPrice = trade.highestPrice * (1 - trade.stopPercent / 100);
      const limitTriggerPrice = trade.highestPrice * (1 - (trade.stopPercent * 0.75) / 100);

      // Actualizar highestPrice si sube
      if (currentPrice > trade.highestPrice) {
        await db.run("UPDATE trades SET highestPrice = ?, sellPrice = NULL WHERE id = ?", [currentPrice, trade.id]);
        continue;
      }

      // Si hay una orden límite colocada, comprobar si se ha ejecutado
      if (trade.sellPrice && trade.sellPrice.length > 4) {
        const executedPrice = await kraken.checkOrderExecuted(trade.sellPrice);
        if (executedPrice) {
          const profit = ((executedPrice - trade.buyPrice) / trade.buyPrice) * 100;
          await db.run("UPDATE trades SET status = 'completed', sellPrice = ?, profitPercent = ? WHERE id = ?", 
                       [executedPrice, profit, trade.id]);
          console.log(`✅ Venta límite ejecutada para ${trade.pair}. Precio: ${executedPrice}`);
          continue;
        }
      }

      // Si el precio actual sube, cancelar la orden límite si existe
      if (trade.sellPrice && currentPrice > limitTriggerPrice) {
        await kraken.cancelOrder(trade.sellPrice);
        await db.run("UPDATE trades SET sellPrice = NULL WHERE id = ?", [trade.id]);
        continue;
      }

      // Colocar orden límite si el precio bajó lo suficiente
      if (!trade.sellPrice && currentPrice <= limitTriggerPrice && currentPrice > stopPrice) {
        const orderId = await kraken.sellLimit(trade.pair, trade.quantity, stopPrice);
        if (orderId) {
          await db.run("UPDATE trades SET sellPrice = ? WHERE id = ?", [orderId, trade.id]);
          console.log(`📌 Venta límite colocada para ${trade.pair} a ${stopPrice}`);
        } else {
          console.warn(`⚠️ No se pudo colocar orden límite para ${trade.pair}`);
        }
        continue;
      }

      // Vender a mercado si se alcanzó el stop real
      if (currentPrice <= stopPrice) {
        const orderId = await kraken.sell(trade.pair, trade.quantity);
        if (orderId) {
          const priceFinal = await kraken.getCurrentPrice(trade.pair);
          const profit = ((priceFinal - trade.buyPrice) / trade.buyPrice) * 100;
          await db.run("UPDATE trades SET status = 'completed', sellPrice = ?, profitPercent = ? WHERE id = ?", 
                       [priceFinal, profit, trade.id]);
          console.log(`✅ Venta a mercado ejecutada para ${trade.pair}. Precio: ${priceFinal}`);
        } else {
          console.error(`❌ Venta a mercado fallida para ${trade.pair}, trade sigue activo`);
        }
      }
    }
  }

  setInterval(updateTrades, 60000);
})();