require("dotenv").config();
const KrakenClient = require("kraken-api");
const kraken = new KrakenClient(process.env.API_KEY, process.env.API_SECRET);

// Función mejorada para validar pares y obtener decimales
async function validarPar(par) {
  try {
    const response = await kraken.api("AssetPairs");
    const pairInfo = response.result[par];
    
    if (!pairInfo) {
      console.error(`❌ Par ${par} no registrado en Kraken`);
      return { valido: false, decimales: null };
    }

    return {
      valido: true,
      decimales: {
        precio: pairInfo.pair_decimals || 4,
        cantidad: pairInfo.lot_decimals || 8
      }
    };
  } catch (error) {
    console.error(`❌ Fallo validación par ${par}: ${error.message}`);
    return { valido: false, decimales: null };
  }
}

// Interpretador de errores mejorado
function interpretarErrorKraken(errorArray) {
  console.log("🔍 Raw Kraken Error:", errorArray);
  if (!Array.isArray(errorArray)) return "Error desconocido";
  
  if (errorArray.some(e => e.includes("EQuery:Unknown asset pair"))) {
    return "Par no válido o mal escrito";
  }
  if (errorArray.some(e => e.includes("EOrder:Insufficient funds"))) {
    return "Fondos insuficientes para operar";
  }
  if (errorArray.some(e => e.includes("EOrder:Rate limit exceeded"))) {
    return "Límite de solicitudes excedido";
  }
  
  return errorArray.join(" | ");
}

async function getBalance() {
  try {
    const response = await kraken.api("Balance");
    return response.result;
  } catch (error) {
    const mensaje = interpretarErrorKraken(error.error || []);
    console.error(`❌ Error al obtener balance: ${mensaje}`);
    return {};
  }
}

async function getTicker(par) {
  try {
    const ticker = await kraken.api("Ticker", { pair: par });
    const price = parseFloat(ticker.result[par].c[0]);
    console.log(`📈 Precio actual de ${par}: ${price}`);
    return price;
  } catch (error) {
    const mensaje = interpretarErrorKraken(error.error || []);
    console.error(`❌ Error al obtener precio de ${par}: ${mensaje}`);
    return null;
  }
}

async function buy(par, cantidad) {
  try {
    const validacion = await validarPar(par);
    if (!validacion.valido) throw new Error(`Par ${par} no válido`);
    
    const volumenFormateado = Number(cantidad).toFixed(validacion.decimales.cantidad);
    const order = await kraken.api("AddOrder", {
      pair: par,
      type: "buy",
      ordertype: "market",
      volume: volumenFormateado
    });
    console.log(`🛒 Compra ejecutada: ${cantidad} ${par}`);
    return order.result.txid[0];
  } catch (error) {
    const mensaje = interpretarErrorKraken(error.error || []);
    console.error(`❌ Error al comprar ${par}: ${mensaje}`);
    return null;
  }
}

async function sellLimit(par, cantidad, precio) {
  try {
    const validacion = await validarPar(par);
    if (!validacion.valido) throw new Error(`Par ${par} no válido`);

    const volumenFormateado = Number(cantidad).toFixed(validacion.decimales.cantidad);
    const precioFormateado = Number(precio).toFixed(validacion.decimales.precio);

    const order = await kraken.api("AddOrder", {
      pair: par,
      type: "sell",
      ordertype: "limit",
      volume: volumenFormateado,
      price: precioFormateado
    });
    console.log(`🧷 Venta LÍMITE colocada: ${cantidad} ${par} a ${precioFormateado}`);
    return order.result.txid[0];
  } catch (error) {
    const mensaje = interpretarErrorKraken(error.error || []);
    console.error(`❌ Error al colocar orden límite de ${par}: ${mensaje}`);
    return null;
  }
}

async function sell(par, cantidad) {
  try {
    const validacion = await validarPar(par);
    if (!validacion.valido) throw new Error(`Par ${par} no válido`);
    
    const volumenFormateado = Number(cantidad).toFixed(validacion.decimales.cantidad);
    const order = await kraken.api("AddOrder", {
      pair: par,
      type: "sell",
      ordertype: "market",
      volume: volumenFormateado
    });
    console.log(`💰 Venta a mercado ejecutada: ${cantidad} ${par}`);
    return order;
  } catch (error) {
    const mensaje = interpretarErrorKraken(error.error || []);
    console.error(`❌ Error al vender ${par}: ${mensaje}`);
    return null;
  }
}

async function cancelOrder(orderId) {
  try {
    const cancel = await kraken.api("CancelOrder", { txid: orderId });
    console.log(`🛑 Orden cancelada: ${orderId}`);
    return cancel;
  } catch (error) {
    const mensaje = interpretarErrorKraken(error.error || []);
    console.error(`❌ Error al cancelar orden ${orderId}: ${mensaje}`);
    return null;
  }
}

async function checkOrderExecuted(orderId) {
  try {
    const info = await kraken.api("QueryOrders", { txid: orderId });
    const order = info.result[orderId];
    if (order.status === 'closed' && parseFloat(order.vol_exec) > 0) {
      return {
        price: parseFloat(order.price),
        fee: parseFloat(order.fee),
        status: order.status
      };
    }
    return null;
  } catch (error) {
    const mensaje = interpretarErrorKraken(error.error || []);
    console.error(`❌ Error al consultar estado de orden ${orderId}: ${mensaje}`);
    return null;
  }
}

module.exports = {
  getBalance,
  getTicker,
  buy,
  sell,
  sellLimit,
  cancelOrder,
  checkOrderExecuted,
  validarPar,
  api: (...args) => kraken.api(...args)
};