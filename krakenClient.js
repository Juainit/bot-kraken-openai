require("dotenv").config();
const KrakenClient = require("kraken-api");
const { format } = require("date-fns");

const kraken = new KrakenClient(
  process.env.API_KEY, 
  process.env.API_SECRET,
  { timeout: 20000 }
);

// Función mejorada con verificación de órdenes existentes
async function validarPar(par) {
  const timestamp = format(new Date(), "yyyy-MM-dd HH:mm:ss");
  try {
    const response = await this.api("AssetPairs");
    const pairInfo = response.result[par];
    
    if (!pairInfo) {
      console.error(`[${timestamp}] ❌ Par ${par} no válido`);
      return { valido: false, decimales: null };
    }

    // Verificar si ya hay órdenes abiertas para este par [1][7]
    const openOrders = await this.getOpenOrders(par);
    if (openOrders.length > 0) {
      console.warn(`[${timestamp}] ⚠️ Par ${par} tiene ${openOrders.length} órdenes pendientes`);
    }

    return {
      valido: true,
      decimales: {
        precio: pairInfo.pair_decimals || 4,
        cantidad: pairInfo.lot_decimals || 8
      },
      ordenesPendientes: openOrders.length
    };
  } catch (error) {
    console.error(`[${timestamp}] ❌ Fallo validación ${par}: ${this.interpretarError(error)}`);
    return { valido: false, decimales: null };
  }
}

// Sistema de errores ampliado con códigos
function interpretarErrorKraken(errorArray) {
  const timestamp = format(new Date(), "HH:mm:ss.SSS");
  const errores = {
    'EQuery:Unknown asset pair': 'Par inválido',
    'EOrder:Insufficient funds': 'Fondos insuficientes',
    'EOrder:Rate limit exceeded': 'Límite de solicitudes',
    'EGeneral:Invalid arguments': 'Argumentos inválidos',
    'EService:Unavailable': 'Servicio no disponible'
  };

  if (!Array.isArray(errorArray) || errorArray.length === 0) {
    console.error(`[${timestamp}] 🔍 Error vacío - Verificar conexión API`);
    return 'Error desconocido - Respuesta vacía de Kraken';
  }

  for (const [codigo, mensaje] of Object.entries(errores)) {
    if (errorArray.some(e => e.includes(codigo))) {
      console.warn(`[${timestamp}] ⚠️ Código error: ${codigo}`);
      return mensaje;
    }
  }
  
  console.error(`[${timestamp}] � Error no catalogado:`, JSON.stringify(errorArray));
  return `Error múltiple: ${errorArray.join(' | ')}`;
}

// Balance efectivo (disponible - reservado en órdenes)
async function getEffectiveBalance(asset) {
  try {
    const [balance, openOrders] = await Promise.all([
      this.getBalance(asset),
      this.getOpenOrders()
    ]);

    const reservado = openOrders.reduce((total, orden) => {
      return orden.pair.startsWith(asset) ? total + parseFloat(orden.vol) : total;
    }, 0);

    console.log(`[${format(new Date(), "HH:mm:ss")}] 💰 Balance ${asset}: ${balance} (Reservado: ${reservado})`);
    
    return Math.max(balance - reservado, 0);
  } catch (error) {
    console.error(`Error balance efectivo: ${this.interpretarError(error)}`);
    return 0;
  }
}

// Nueva función para obtener órdenes abiertas
async function getOpenOrders(pairFilter = null) {
  try {
    const response = await this.api("OpenOrders");
    const orders = Object.values(response.result.open);
    
    return pairFilter 
      ? orders.filter(o => o.descr.pair === pairFilter)
      : orders;
  } catch (error) {
    console.error(`Error obteniendo órdenes: ${this.interpretarError(error)}`);
    return [];
  }
}

// Función de venta límite con control de duplicados
async function sellLimit(par, cantidad, precio) {
  const timestamp = format(new Date(), "yyyyMMdd-HHmmss");
  const MAX_INTENTOS = 3;
  const DELAY_ANTI_RATELIMIT = 2500; // 2.5 segundos
  
  try {
    // 1. Verificación mejorada de órdenes abiertas (consulta directa a Kraken)
    const ordenesAbiertas = await this.getOpenOrders(par);
    if (ordenesAbiertas.length > 0) {
      throw new Error(`[DUPLICADO] Par ${par} tiene orden activa: ${ordenesAbiertas[0].txid}`);
    }

    // 2. Doble validación de balance con última hora
    const asset = par.replace(/EUR|USD$/, '');
    let balanceEfectivo = await this.getEffectiveBalance(asset);
    balanceEfectivo = await this.actualizarBalanceEnTiempoReal(asset); // [Nueva función]
    
    if (balanceEfectivo < cantidad) {
      throw new Error(`[BALANCE] ${balanceEfectivo.toFixed(4)} < ${cantidad} | Asset: ${asset}`);
    }

    // 3. Formateo numérico con validación estricta
    const volumenFormateado = this.formatearDecimales(cantidad, 'cantidad', par); // [Nueva función]
    const precioFormateado = this.formatearDecimales(precio, 'precio', par);

    // 4. Delay anti rate-limiting
    await new Promise(resolve => setTimeout(resolve, DELAY_ANTI_RATELIMIT));
    
    // 5. Sistema de reintentos inteligente
    const order = await this.retryOperation(
      () => this.api("AddOrder", {
        pair: par,
        type: "sell",
        ordertype: "limit",
        volume: volumenFormateado,
        price: precioFormateado,
        userref: `BOT_${timestamp}_${hashCode(par)}` // ID único por par
      }),
      MAX_INTENTOS
    );

    if (!order?.result?.txid?.[0]) {
      throw new Error("[KRAKEN] Respuesta inválida sin TXID");
    }

    console.log(`[${timestamp}] 🧷 Venta LÍMITE ${par} | TXID: ${order.result.txid[0]} | Vol: ${volumenFormateado}`);
    return { success: true, txid: order.result.txid[0] };

  } catch (error) {
    const errorDetalle = {
      code: 'SELL_LIMIT_FAILED',
      message: this.interpretarErrorKraken(error.error || error.message),
      params: {
        par,
        cantidad_intentada: cantidad,
        cantidad_formateada: volumenFormateado,
        precio_intentado: precio,
        precio_formateado: precioFormateado,
        balance_efectivo: balanceEfectivo?.toFixed(8)
      },
      timestamp,
      intentos: MAX_INTENTOS
    };
    
    console.error(JSON.stringify(errorDetalle, null, 2));
    await this.registrarErrorEnDB(errorDetalle); // [Nueva función]
    
    return { 
      success: false, 
      error: errorDetalle,
      sugerencia: error.message.includes('DUPLICADO') 
        ? "Ejecutar 'npm run sincronizar -- --force'" 
        : "Verificar balances con 'npm run check-balance'"
    };
  }
}

// Función mejorada para cancelar órdenes
async function cancelOrder(txid) {
  try {
    const result = await this.api("CancelOrder", { txid });
    
    if (result.result.count === 1) {
      console.log(`[${format(new Date(), "HH:mm:ss")}] 🗑️ Orden ${txid} cancelada`);
      return true;
    }
    
    throw new Error(`Error cancelando orden: ${JSON.stringify(result)}`);
  } catch (error) {
    console.error(`Cancelación fallida: ${this.interpretarErrorKraken(error.error)}`);
    return false;
  }
}

// Verificador de estado de órdenes
async function checkOrderExecuted(txid) {
  try {
    const response = await this.api("ClosedOrders", { txid });
    const orden = Object.values(response.result.closed).find(o => o.txid === txid);
    
    return orden ? {
      executed: orden.status === 'closed',
      price: parseFloat(orden.price),
      fee: parseFloat(orden.fee),
      volume: parseFloat(orden.vol_exec)
    } : null;
  } catch (error) {
    console.error(`Verificación orden fallida: ${this.interpretarErrorKraken(error.error)}`);
    return null;
  }
}

module.exports = {
  api: kraken.api.bind(kraken),
  validarPar,
  interpretarErrorKraken,
  getEffectiveBalance,
  sellLimit,
  cancelOrder,
  checkOrderExecuted,
  getOpenOrders
};
