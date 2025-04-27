// ✅ Versión optimizada y segura:
require("dotenv").config(); 
const express = require("express");
const { Pool } = require("pg");
const app = express();

// Configuración básica
app.use(express.json());
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("railway") 
    ? { rejectUnauthorized: false } 
    : false
});

const kraken = require("./krakenClient");

// Endpoint POST /alerta - Versión mejorada
app.post("/alerta", async (req, res) => {
  let orderId;
  const { par, trailingStopPercent, inversion } = req.body;

  try {
    // Validaciones básicas
    if (!par || typeof par !== "string") {
      return res.status(400).json({ error: "Par requerido y debe ser texto" });
    }
    if (typeof trailingStopPercent !== "number" || trailingStopPercent < 1) {
      return res.status(400).json({ error: "Trailing stop debe ser ≥1%" });
    }

    await pool.query("BEGIN");
    const cleanPair = par.replace(/[^A-Z]/g, "").toUpperCase();

    // Verificar operaciones existentes
    const { rows: existing } = await pool.query(
      "SELECT 1 FROM trades WHERE pair = $1 AND status = 'active'",
      [cleanPair]
    );
    
    if (existing.length > 0) {
      await pool.query("ROLLBACK");
      return res.status(400).json({ error: "Operación activa existente" });
    }

    // Lógica de inversión dinámica
    let inversionEUR = process.env.DEFAULT_INVERSION || 40;
    if (process.env.REINVERSION === 'true') {
      const balance = await kraken.getAvailableBalance();
      inversionEUR = Math.max(balance, 40);
    }

    // Obtener metadata del par
    const { decimales } = await kraken.validarPar(cleanPair);
    if (!decimales) {
      await pool.query("ROLLBACK");
      return res.status(400).json({ error: "Par no válido" });
    }

    // Ejecutar compra
    const ticker = await kraken.getTicker(cleanPair);
    const quantity = (inversionEUR / ticker).toFixed(decimales.cantidad);
    
    orderId = await kraken.buy(cleanPair, quantity);
    
    // Registrar en base de datos
    await pool.query(
      `INSERT INTO trades (
        pair, quantity, buyprice, highestprice, 
        stoppercent, status, feeeur
      ) VALUES (
        $1, $2, $3, $3, $4, 'active', 0
      )`,
      [
        cleanPair,
        quantity,
        ticker.toFixed(decimales.precio),
        trailingStopPercent
      ]
    );

    await pool.query("COMMIT");
    console.log(`✅ COMPRA: ${quantity} ${cleanPair} @ ${ticker}€`);
    res.status(200).json({ 
      message: "Compra exitosa",
      detalles: { par: cleanPair, cantidad: quantity, invertido: inversionEUR }
    });

  } catch (err) {
    await pool.query("ROLLBACK");
    if (orderId) await kraken.cancelOrder(orderId);
    
    const mensajeError = err.message.includes("decimales") 
      ? "Error de formato en precio/cantidad" 
      : err.message;
    
    console.error("❌ Error en /alerta:", mensajeError);
    res.status(500).json({ 
      error: "Error en ejecución",
      detalle: mensajeError 
    });
  }
});

// GET /estado
app.get("/estado", async (req, res) => {
  try {
    const [activos, completados] = await Promise.all([
      pool.query(
        `SELECT 
          pair, 
          quantity, 
          buyprice AS "buyPrice", 
          highestprice AS "highestPrice",
          stoppercent AS "stopPercent",
          createdat AS "createdAt"
         FROM trades 
         WHERE status = 'active' 
         ORDER BY createdat DESC`
      ),
      pool.query(
        `SELECT 
          pair,
          sellprice AS "sellPrice",
          profitpercent AS "profitPercent",
          feeeur,
          createdat AS "createdAt"
         FROM trades 
         WHERE status = 'completed' 
         ORDER BY createdat DESC 
         LIMIT 1`
      )
    ]);
    res.json({
      activos: activos.rows,
      ultimo_completado: completados.rows[0] || null
    });
  } catch (err) {
    console.error("❌ Error en /estado:", err.message);
    res.status(500).json({ 
      error: "Error al consultar estado",
      detalle: err.message 
    });
  }
});

// GET /historial
app.get("/historial", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        id,
        pair,
        quantity,
        buyprice AS "buyPrice",
        sellprice AS "sellPrice",
        stoppercent AS "stopPercent",
        feeeur,
        status,
        createdat AS "createdAt",
        updatedat AS "updatedAt"
      FROM trades 
      ORDER BY createdat DESC`
    );
    
    res.json(rows);
  } catch (err) {
    console.error("❌ Error al obtener historial:", err.message);
    res.status(500).json({ 
      error: "Error al obtener historial completo",
      detalle: err.message 
    });
  }
});

// GET /historial/:par
app.get("/historial/:par", async (req, res) => {
  const par = req.params.par.toUpperCase().replace(/[^A-Z]/g, "");
  
  try {
    const { rows } = await pool.query(
      `SELECT 
        id,
        pair,
        quantity,
        buyprice AS "buyPrice",
        sellprice AS "sellPrice",
        stoppercent AS "stopPercent",
        feeeur,
        status,
        createdat AS "createdAt"
       FROM trades 
       WHERE pair = $1 
       ORDER BY createdat DESC`, 
      [par]
    );
    if (rows.length === 0) {
      return res.status(404).json({ 
        mensaje: `No hay operaciones registradas para ${par}`,
        moneda: par
      });
    }
    res.json(rows);
  } catch (err) {
    console.error(`❌ Error en historial de ${par}:`, err.message);
    res.status(500).json({ 
      error: `Error al obtener historial de ${par}`,
      detalle: err.message 
    });
  }
});

// Sincronización
const sincronizarTrades = require("./sincronizador");
app.get("/sincronizar", async (req, res) => {
  try {
    const authToken = req.query.token;
    if (!authToken || authToken !== process.env.SYNC_TOKEN) {
      console.warn("⚠️ Intento de sincronización no autorizado");
      return res.status(403).json({ 
        error: "Acceso denegado",
        codigo: "AUTH_REQUIRED"
      });
    }
    
    console.log("🔄 Iniciando sincronización manual...");
    const resultado = await sincronizarTrades();
    
    res.json({
      status: "success",
      message: "Sincronización completada",
      detalles: resultado
    });
  } catch (error) {
    console.error("❌ Error crítico en sincronización:", error.message);
    res.status(500).json({
      error: "Fallo en sincronización",
      codigo: "SYNC_FAILED",
      detalle: process.env.NODE_ENV === "production" 
        ? "Ver logs del servidor" 
        : error.message
    });
  }
});

// Inicio del servidor
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Servidor operativo en puerto ${port}`);
  console.log("🔒 Modo de seguridad:", process.env.NODE_ENV || "development");
  
  if (process.env.NODE_ENV !== "test") {
    require("./tradeManager");
  }
});