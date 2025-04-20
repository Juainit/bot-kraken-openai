require('dotenv').config();
const KrakenClient = require('kraken-api');

const kraken = new KrakenClient(process.env.API_KEY, process.env.API_SECRET);

async function getCurrentPrice(par) {
  try {
    const ticker = await kraken.api('Ticker', { pair: par });
    const price = parseFloat(ticker.result[par].c[0]);
    console.log(`📈 Precio actual de ${par}: ${price}`);
    return price;
  } catch (error) {
    console.error(`❌ Error al obtener precio de ${par}:`, error.message);
    return null;
  }
}

async function sellLimit(par, cantidad, precio) {
  try {
    const volume = cantidad.toString();
    const order = await kraken.api('AddOrder', {
      pair: par,
      type: 'sell',
      ordertype: 'limit',
      volume: volume,
      price: precio.toFixed(5)
    });
    console.log(`🧷 Venta LÍMITE colocada: ${cantidad} ${par} a ${precio.toFixed(5)}`);
    return order.result.txid[0];
  } catch (error) {
    console.error(`❌ Error al colocar orden límite de ${par}:`, error.message);
    return null;
  }
}

async function sell(par, cantidad) {
  try {
    const volume = cantidad.toString();
    const order = await kraken.api('AddOrder', {
      pair: par,
      type: 'sell',
      ordertype: 'market',
      volume: volume
    });
    console.log(`💰 Venta a mercado ejecutada: ${cantidad} ${par}`);
    return order;
  } catch (error) {
    console.error(`❌ Error al vender ${par}:`, error.message);
    return null;
  }
}

async function cancelOrder(orderId) {
  try {
    const cancel = await kraken.api('CancelOrder', { txid: orderId });
    console.log(`🛑 Orden cancelada: ${orderId}`);
    return cancel;
  } catch (error) {
    console.error(`❌ Error al cancelar orden ${orderId}:`, error.message);
    return null;
  }
}

async function checkOrderExecuted(orderId) {
  try {
    const info = await kraken.api('QueryOrders', { txid: orderId });
    const order = info.result[orderId];

    if (order.status === 'closed' && parseFloat(order.vol_exec) > 0) {
      const executedPrice = parseFloat(order.price);
      return executedPrice;
    }

    return null;
  } catch (error) {
    console.error(`❌ Error al consultar estado de orden ${orderId}:`, error.message);
    return null;
  }
}

module.exports = {
  getCurrentPrice,
  sell,
  sellLimit,
  cancelOrder,
  checkOrderExecuted
};