// tradeManager.js - Versión 4.0 (Producción)
require('dotenv').config();
const { Pool } = require('pg');
const kraken = require('./krakenClient');
const logger = require('./logger'); // Asume un módulo logger personalizado
const { ExponentialBackoff } = require('./strategies'); // Estrategia de reintentos

// 1. Configuración de conexión optimizada
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { 
    rejectUnauthorized: true,
    ca: process.env.DB_SSL_CERT
  } : false,
  max: 15,
  min: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

// 2. Sistema de caché mejorado
class PriceCache {
  constructor(ttl = 60000, maxSize = 100) {
    this.ttl = ttl;
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  get(pair) {
    const entry = this.cache.get(pair);
    return entry && Date.now() - entry.timestamp < this.ttl 
      ? entry.price 
      : null;
  }

  async fetch(pair) {
    try {
      const price = await kraken.getTicker(pair);
      if (this.cache.size >= this.maxSize) {
        const oldest = this.cache.keys().next().value;
        this.cache.delete(oldest);
      }
      this.cache.set(pair, { price, timestamp: Date.now() });
      return price;
    } catch (error) {
      logger.error(`Price fetch failed for ${pair}`, error);
      return null;
    }
  }
}

const priceCache = new PriceCache();

// 3. Estrategia de reintentos mejorada
const tradingRetry = new ExponentialBackoff({
  maxAttempts: 5,
  initialDelay: 1000,
  factor: 3
});

// 4. Funciones principales
async function updateHighestPrice(tradeId, newHigh) {
  const client = await pool.connect();
  try {
    await client.query(
      'UPDATE trades SET highestprice = $1 WHERE id = $2',
      [newHigh, tradeId]
    );
    logger.info(`Highest price updated for trade ${tradeId}`);
  } finally {
    client.release();
  }
}

async function executeLimitSale(trade, stopPrice) {
  return tradingRetry.execute(async () => {
    const order = await kraken.sellLimit(trade.pair, trade.quantity, stopPrice);
    await pool.query(
      'UPDATE trades SET limitorderid = $1 WHERE id = $2',
      [order.txid, trade.id]
    );
    logger.info(`Limit order placed`, { 
      pair: trade.pair, 
      price: stopPrice,
      txid: order.txid 
    });
    return order;
  });
}

async function emergencySell(trade) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    if (trade.limitorderid) {
      await kraken.cancelOrder(trade.limitorderid);
      await client.query(
        'UPDATE trades SET limitorderid = NULL WHERE id = $1',
        [trade.id]
      );
    }

    const order = await tradingRetry.execute(() => 
      kraken.sell(trade.pair, trade.quantity)
    );
    
    const execution = await verifyOrderExecution(order.txid);
    
    await client.query(
      `UPDATE trades 
       SET status = 'completed', 
           sellprice = $1, 
           feeeur = $2,
           profitpercent = ROUND((($1 - buyprice) / buyprice * 100)::numeric, 2)
       WHERE id = $3`,
      [execution.price, execution.fee, trade.id]
    );
    
    await client.query('COMMIT');
    logger.warn(`Emergency sale executed`, {
      pair: trade.pair,
      price: execution.price
    });
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(`Emergency sale failed`, { 
      pair: trade.pair,
      error: error.message 
    });
    throw error;
  } finally {
    client.release();
  }
}

// 5. Lógica central mejorada
async function processActiveTrades() {
  const client = await pool.connect();
  try {
    const { rows: activeTrades } = await client.query(`
      SELECT 
        id, pair, quantity, buyprice, highestprice, 
        stoppercent, limitorderid, createdat
      FROM trades 
      WHERE status = 'active'
      FOR UPDATE SKIP LOCKED
    `);

    if (!activeTrades.length) {
      logger.info('No active trades to process');
      return;
    }

    const [prices, balance] = await Promise.all([
      Promise.all(activeTrades.map(t => 
        priceCache.get(t.pair) || priceCache.fetch(t.pair)
      ),
      kraken.getEffectiveBalances()
    ]);

    await Promise.all(activeTrades.map(async (trade, index) => {
      if (Date.now() - trade.createdat.getTime() < 120000) {
        logger.debug('Skipping recent trade', { pair: trade.pair });
        return;
      }

      const marketPrice = prices[index];
      if (!marketPrice) {
        logger.warn('Missing price data', { pair: trade.pair });
        return;
      }

      const newHigh = Math.max(trade.highestprice, marketPrice);
      if (newHigh > trade.highestprice) {
        await updateHighestPrice(trade.id, newHigh);
        await cancelExistingOrder(trade);
      }

      const stopPrice = calculateStopPrice(newHigh, trade.stoppercent);
      await evaluateSaleConditions(trade, marketPrice, stopPrice, balance);
    }));
    
  } catch (error) {
    logger.error('Trade processing failed', error);
  } finally {
    client.release();
  }
}

// 6. Funciones auxiliares optimizadas
async function cancelExistingOrder(trade) {
  if (trade.limitorderid) {
    await kraken.cancelOrder(trade.limitorderid);
    await pool.query(
      'UPDATE trades SET limitorderid = NULL WHERE id = $1',
      [trade.id]
    );
    logger.info('Order cancelled', { 
      pair: trade.pair,
      txid: trade.limitorderid 
    });
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
}

function calculateStopPrice(high, percent) {
  return high * (1 - (percent / 100));
}

async function evaluateSaleConditions(trade, marketPrice, stopPrice, balance) {
  const asset = trade.pair.replace(/EUR|USD$/, '');
  
  if ((balance[asset] || 0) < trade.quantity * 0.9) {
    logger.warn('Insufficient balance', { 
      pair: trade.pair,
      required: trade.quantity,
      available: balance[asset]
    });
    await pool.query(
      'UPDATE trades SET status = $1 WHERE id = $2',
      ['failed', trade.id]
    );
    return;
  }

  if (marketPrice <= stopPrice * 0.98) {
    await executeLimitSale(trade, stopPrice);
  } else if (marketPrice <= stopPrice * 0.95) {
    await emergencySell(trade);
  }
}

// 7. Configuración de intervalo segura
const interval = setInterval(() => {
  processActiveTrades().catch(error => 
    logger.error('Interval processing failed', error)
  );
}, process.env.TRADE_INTERVAL || 180000);

// 8. Manejo de cierre limpio
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

async function gracefulShutdown() {
  clearInterval(interval);
  logger.info('Shutting down trade manager');
  
  try {
    await pool.end();
    logger.info('Database pool closed');
    process.exit(0);
  } catch (error) {
    logger.error('Shutdown error', error);
    process.exit(1);
  }
}

module.exports = {
  processActiveTrades,
  gracefulShutdown
};
