// ✅ Versión optimizada y segura:
require("dotenv").config(); 
const express = require("express"); // <-- Módulo core primero
const { Pool } = require("pg");
const app = express();

// Middleware básico
app.use(express.json()); 

// Configuración PostgreSQL (source id=2 y 3)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // ❌ Elimina el string hardcodeado (¡riesgo de seguridad!)
  ssl: process.env.DATABASE_URL?.includes("railway") // ✅ Optional chaining
    ? { rejectUnauthorized: false }
    : false
});

// ✅ Requiere krakenClient DESPUÉS de inicializar lo esencial
const kraken = require("./krakenClient"); 

// Endpoint POST /alerta (Versión mejorada)
// ✅ Versión corregida y unificada:
app.post("/alerta", async (req, res) => {
  let orderId;
  const { par, trailingStopPercent, inversion } = req.body;

  // Validaciones iniciales (sincrónicas)
  if (!par || typeof par !== "string") {
    return res.status(400).json({ error: "Campo 'par' requerido y debe ser texto" });
  }
  if (typeof trailingStopPercent !== "number" || trailingStopPercent < 1) {
    return res.status(400).json({ error: "'trailingStopPercent' debe ser ≥1" });
  }
  if (inversion !== undefined && (typeof inversion !== "number" || inversion < 5)) {
    return res.status(400).json({ error: "'inversion' debe ser ≥5" });
  }

  try {
    await pool.query("BEGIN");

    // 1. Validar si el par ya está en cartera
    const cleanPair = par.replace(/[^A-Z]/g, "").toUpperCase();
    const { rows: existing } = await pool.query(
      "SELECT quantity FROM trades WHERE pair = $1 AND status = 'active'",
      [cleanPair]
    );
    if (existing.length > 0) {
      await pool.query("ROLLBACK");
      return res.status(400).json({ error: "Par ya en cartera" });
    }

    // 2. Calcular inversión
    let inversionEUR = process.env.DEFAULT_INVERSION || 40;
    // ... (lógica de reinversión)

    // 3. Obtener precio y cantidad
    const ticker = await kraken.getTicker(cleanPair);
    const marketPrice = parseFloat(ticker);
    const quantity = +(inversionEUR / marketPrice).toFixed(8);

    // 4. Ejecutar compra en Kraken
    orderId = await kraken.buy(cleanPair, quantity);
    if (!orderId) throw new Error("Fallo en Kraken.buy()");

    // 5. Registrar en PostgreSQL
    await pool.query(
      `INSERT INTO trades 
        (pair, quantity, buyprice, highestprice, stoppercents, status, feeeur) 
       VALUES ($1, $2, $3, $4, $5, 'active', $6)`,
      [cleanPair, quantity, marketPrice, marketPrice, trailingStopPercent, 0]
    );

    await pool.query("COMMIT");
    console.log(`✅ COMPRA: ${quantity} ${cleanPair} @ ${marketPrice}€`);
    res.status(200).json({ message: "Compra exitosa" });

  } catch (err) {
    await pool.query("ROLLBACK");
    if (orderId) await kraken.cancelOrder(orderId);
    console.error("❌ Error en /alerta:", err.message);
    res.status(500).json({ error: "Error interno: " + err.message });
  }
});

// GET /estado (Versión mejorada)
app.get("/estado", async (req, res) => {
  try {
    const [activos, completados] = await Promise.all([
      pool.query(
        `SELECT 
          pair, 
          quantity, 
          buyprice AS "buyPrice", 
          highestprice AS "highestPrice",
          stoppercents AS "stopPercent",
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

// GET /historial (Versión unificada)
app.get("/historial", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        id,
        pair,
        quantity,
        buyprice AS "buyPrice",
        sellprice AS "sellPrice",
        stoppercents AS "stopPercent",
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

// Endpoint GET /historial/:par (Versión mejorada)
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
        stoppercents AS "stopPercent",
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

const sincronizarTrades = require("./sincronizador");

// Endpoint de sincronización mejorado
app.get("/sincronizar", async (req, res) => {
  try {
    // Validación de seguridad reforzada
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

// Inicio seguro del servidor
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Servidor operativo en puerto ${port}`);
  console.log("🔒 Modo de seguridad:", process.env.NODE_ENV || "development");
  
  // Inicia tradeManager solo si no está en test
  if (process.env.NODE_ENV !== "test") {
    require("./tradeManager");
  }
});