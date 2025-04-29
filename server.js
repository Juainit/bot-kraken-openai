// server.js - Versión 3.1 Optimizada
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const kraken = require('./krakenClient');
const { format } = require('date-fns');

// 1. Configuración inicial
const app = express();
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';

// 2. Configuración de base de datos
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: process.env.NODE_ENV === 'production',
  },
});

// 3. Middlewares de seguridad
app.use(express.json({ limit: '10kb' }));
app.use((req, res, next) => {
  res.header('X-Content-Type-Options', 'nosniff');
  res.header('X-Frame-Options', 'DENY');
  res.header('Content-Security-Policy', "default-src 'self'");
  next();
});

// 4. Endpoint: /alerta (POST)
app.post('/alerta', async (req, res) => {
  const startTime = Date.now();
  const transaction = await pool.connect();
  
  try {
    // 4.1 Validación de entrada
    const { par, trailingStopPercent, inversion } = req.body;
    const erroresValidacion = [];
    
    if (!/^[A-Z]{6,8}$/.test(par)) {
      erroresValidacion.push('Formato de par inválido (ejemplo: ADAEUR)');
    }
    
    if (typeof trailingStopPercent !== 'number' || trailingStopPercent < 1 || trailingStopPercent > 20) {
      erroresValidacion.push('El trailing stop debe estar entre 1% y 20%');
    }
    
    if (erroresValidacion.length > 0) {
      return res.status(400).json({
        error: 'Validación fallida',
        detalles: erroresValidacion,
        codigo: 'VALIDACION_001'
      });
    }

    // 4.2 Bloqueo de transacción
    await transaction.query('BEGIN');
    const cleanPair = par.toUpperCase();
    
    // 4.3 Verificación de operación existente
    const { rows: existing } = await transaction.query(
      `SELECT id FROM trades 
       WHERE pair = $1 AND status = 'active'
       FOR UPDATE NOWAIT`,
      [cleanPair]
    );
    
    if (existing.length > 0) {
      await transaction.query('ROLLBACK');
      return res.status(409).json({
        error: 'Operación duplicada',
        codigo: 'TRADING_001',
        solucion: 'Cancelar operación existente primero'
      });
    }

    // 4.4 Validación técnica del par
    const validacionPar = await kraken.validarPar(cleanPair);
    if (!validacionPar.valido) {
      await transaction.query('ROLLBACK');
      return res.status(400).json({
        error: 'Par no soportado',
        codigo: 'TRADING_002',
        pares_validos: 'https://api.kraken.com/0/public/AssetPairs'
      });
    }

    // 4.5 Cálculo de balance efectivo
    const baseAsset = cleanPair.replace(/EUR|USD/g, '');
    const balanceDisponible = await kraken.getEffectiveBalance(baseAsset);
    const inversionFinal = Math.min(
      inversion || process.env.DEFAULT_INVERSION ||40,
      balanceDisponible
    );

    if (inversionFinal < 25) {
      await transaction.query('ROLLBACK');
      return res.status(400).json({
        error: 'Fondos insuficientes',
        codigo: 'BALANCE_001',
        balance_disponible: balanceDisponible,
        inversion_minima: '25 EUR'
      });
    }

    // 4.6 Ejecución de la orden
    const precioActual = await kraken.getTicker(cleanPair);
    const cantidad = (inversionFinal / precioActual).toFixed(validacionPar.decimales.cantidad);
    
    const orden = await kraken.buy(cleanPair, cantidad, {
      intentos: 3,
      delay: 2000
    });

    // 4.7 Registro en base de datos
    await transaction.query(
      `INSERT INTO trades (
        pair, quantity, buyprice, highestprice, 
        stoppercent, status, metadata
      ) VALUES (
        $1, $2, $3, $3, $4, 'active', $5
      ) RETURNING id`,
      [
        cleanPair,
        cantidad,
        precioActual.toFixed(validacionPar.decimales.precio),
        trailingStopPercent,
        {
          user_agent: req.headers['user-agent'],
          execution_time: Date.now() - startTime,
          kraken_txid: orden.txid
        }
      ]
    );

    await transaction.query('COMMIT');

    // 4.8 Respuesta exitosa
    res.status(201).json({
      status: 'success',
      data: {
        par: cleanPair,
        cantidad: cantidad,
        precio: precioActual,
        inversion: inversionFinal,
        txid: orden.txid
      },
      meta: {
        timestamp: format(new Date(), 'yyyy-MM-dd HH:mm:ss'),
        response_time: `${Date.now() - startTime}ms`
      }
    });

  } catch (error) {
    await transaction.query('ROLLBACK');
    
    // 4.9 Manejo estructurado de errores
    const errorInfo = kraken.interpretarErrorKraken(error.error || error.message);
    
    res.status(errorInfo.status || 500).json({
      status: 'error',
      codigo: errorInfo.codigo || 'ERROR_DESCONOCIDO',
      mensaje: errorInfo.mensaje,
      ...(NODE_ENV !== 'production' && { stack: error.stack })
    });
    
    console.error(`[${format(new Date(), 'yyyy-MM-dd HH:mm:ss')}] ${errorInfo.codigo}: ${errorInfo.mensaje}`);
  } finally {
    transaction.release();
  }
});

// 5. Endpoint: /estado (GET)
app.get('/estado', async (req, res) => {
  try {
    const [activos, historial] = await Promise.all([
      pool.query(`SELECT * FROM trades WHERE status = 'active'`),
      pool.query(`SELECT * FROM trades ORDER BY createdat DESC LIMIT 10`)
    ]);

    res.json({
      status: 'success',
      data: {
        operaciones_activas: activos.rows,
        historial_reciente: historial.rows
      },
      meta: {
        total_activas: activos.rowCount,
        total_historial: historial.rowCount
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      codigo: 'ESTADO_001',
      mensaje: 'Error al obtener estado'
    });
  }
});

// 6. Health Check
app.get('/health', async (req, res) => {
  const checks = {
    database: false,
    kraken_api: false,
    memory_usage: process.memoryUsage().rss / 1024 / 1024
  };

  try {
    await pool.query('SELECT 1');
    checks.database = true;
    
    const time = await kraken.api('Time');
    checks.kraken_api = !!time.result.unixtime;
  } catch (error) {
    console.error('Health check failed:', error);
  }

  res.json({
    status: checks.database && checks.kraken_api ? 'OK' : 'DEGRADED',
    checks,
    uptime: process.uptime(),
    environment: NODE_ENV,
    timestamp: Date.now()
  });
});

// 7. Inicio del servidor
app.listen(PORT, () => {
  console.log(`
  ██████╗  ██████╗ ████████╗
  ██╔══██╗██╔═══██╗╚══██╔══╝
  ██████╔╝██║   ██║   ██║   
  ██╔══██╗██║   ██║   ██║   
  ██║  ██║╚██████╔╝   ██║   
  ╚═╝  ╚═╝ ╚═════╝    ╚═╝   
  `);
  console.log(`🚀 Servidor activo en puerto ${PORT}`);
  console.log(`🔧 Entorno: ${NODE_ENV}`);
  console.log(`⏱️  Hora de inicio: ${format(new Date(), 'yyyy-MM-dd HH:mm:ss')}`);
});

// 8. Manejo de errores global
process.on('unhandledRejection', (reason, promise) => {
  console.error('Rechazo no manejado:', reason.stack || reason);
});

module.exports = app;
