require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const { Pool } = require("pg");
const kraken = require("./krakenClient");

const app = express();
app.use(bodyParser.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("railway")
    ? { rejectUnauthorized: false }
    : false,
});

app.post("/alerta", async (req, res) => {
  const { par, trailingStopPercent, inversion } = req.body;

  if (!par || typeof par !== "string") {
    return res.status(400).json({ error: "Campo 'par' requerido y debe ser texto" });
  }

  if (
    typeof trailingStopPercent !== "number" ||
    trailingStopPercent < 1 ||
    trailingStopPercent > 50
  ) {
    return res.status(400).json({ error: "Campo 'trailingStopPercent' requerido y debe ser un número entre 1 y 50" });
  }

  if (
    inversion !== undefined &&
    (typeof inversion !== "number" || inversion < 5)
  ) {
    return res.status(400).json({ error: "Si se incluye 'inversion', debe ser un número mayor a 5" });
  }

  try {
    const cleanPair = par.replace(/[^a-zA-Z]/g, "").toUpperCase();
    const balance = await kraken.getBalance();
    const baseAsset = cleanPair.slice(0, 3);
    const baseAmount = parseFloat(balance?.[baseAsset] || 0);

    if (baseAmount > 10) {
      console.log(`⛔ Ya hay más de 10 unidades de ${baseAsset} en cartera. No se ejecuta compra.`);
      return res.status(200).json({ message: "Par ya en cartera, no se compra." });
    }

    const { rows } = await pool.query(
      "SELECT * FROM trades WHERE pair = $1 AND status = 'completed' ORDER BY createdAt DESC LIMIT 1",
      [cleanPair]
    );

    let inversionEUR;

    if (inversion) {
      inversionEUR = parseFloat(inversion);
      console.log(`💸 Inversión personalizada recibida: ${inversionEUR} EUR`);
    } else if (rows.length > 0) {
      const lastTrade = rows[0];
      if (lastTrade.sellprice && lastTrade.quantity) {
        inversionEUR = lastTrade.sellprice * lastTrade.quantity;
        console.log(`🔁 Reinvierte ${inversionEUR.toFixed(2)} EUR de la última venta.`);
      } else {
        inversionEUR = 40;
        console.log(`🆕 Primer trade registrado, usando inversión por defecto de 40 EUR`);
      }
    } else {
      inversionEUR = 40;
      console.log(`🆕 Primer trade registrado, usando inversión por defecto de 40 EUR`);
    }

    const ticker = await kraken.getTicker(cleanPair);
    const marketPrice = parseFloat(ticker);
    const quantity = +(inversionEUR / marketPrice).toFixed(8);

    const orderId = await kraken.buy(cleanPair, quantity);

    await pool.query(
      "INSERT INTO trades (pair, quantity, buyPrice, highestPrice, stopPercent, status, createdAt) VALUES ($1, $2, $3, $4, $5, 'active', NOW())",
      [cleanPair, quantity, marketPrice, marketPrice, trailingStopPercent]
    );

    console.log(`✅ COMPRA ejecutada: ${quantity} ${cleanPair} a ${marketPrice}`);
    res.status(200).json({ message: "Compra ejecutada correctamente" });

  } catch (err) {
    console.error("❌ Error en /alerta:", err);
    res.status(500).json({ error: "Error al procesar la alerta" });
  }
});

app.get("/estado", async (req, res) => {
  try {
    const { rows: activos } = await pool.query(
      `SELECT pair, quantity, buyPrice, highestPrice, stopPercent, createdAt
       FROM trades
       WHERE status = 'active'
       ORDER BY createdAt DESC`
    );

    const { rows: completados } = await pool.query(
      `SELECT pair, sellPrice, profitPercent, feeEUR, createdAt
       FROM trades
       WHERE status = 'completed'
       ORDER BY createdAt DESC LIMIT 1`
    );

    res.json({
      activos,
      ultimo_completado: completados[0] || null
    });

  } catch (err) {
    console.error("❌ Error en /estado:", err);
    res.status(500).json({ error: "Error al consultar estado." });
  }
});

app.get("/historial", async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM trades ORDER BY createdAt DESC");
    res.json(result.rows);
  } catch (err) {
    console.error("❌ Error al obtener historial:", err);
    res.status(500).json({ error: "Error al obtener el historial completo" });
  }
});

app.get("/historial/:par", async (req, res) => {
  const par = req.params.par;

  try {
    const result = await pool.query(
      "SELECT * FROM trades WHERE pair = $1 ORDER BY createdAt DESC",
      [par]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ mensaje: `No hay historial para ${par}` });
    }

    res.json(result.rows);
  } catch (err) {
    console.error(`❌ Error al obtener historial de ${par}:`, err);
    res.status(500).json({ error: "Error al obtener el historial de esta moneda" });
  }
});

app.post("/vender", async (req, res) => {
  const { pair, tipo, cantidad, precio } = req.body;
  const cleanPair = pair?.replace(/[^A-Z]/gi, "").toUpperCase();

  if (!cleanPair || !tipo || !["mercado", "limite"].includes(tipo)) {
    return res.status(400).json({
      error: "Faltan campos obligatorios o tipo inválido ('mercado' o 'limite')",
    });
  }

  if (tipo === "limite" && (typeof precio !== "number" || precio <= 0)) {
    return res.status(400).json({
      error: "Debe especificar 'precio' válido para orden límite",
    });
  }

  try {
    const balance = await kraken.getBalance();
    const baseAsset = cleanPair.slice(0, 3);
    const totalDisponible = parseFloat(balance?.[baseAsset] || 0);
    const montoAVender = cantidad ? parseFloat(cantidad) : totalDisponible;

    if (montoAVender > totalDisponible || montoAVender <= 0) {
      return res.status(400).json({ error: "Cantidad inválida o saldo insuficiente" });
    }

    let result;
    if (tipo === "mercado") {
      result = await kraken.sell(cleanPair, montoAVender);
    } else {
      result = await kraken.sellLimit(cleanPair, montoAVender, precio);
    }

    if (!result || !result.result?.txid?.[0]) {
      return res.status(500).json({ error: "No se pudo ejecutar la orden" });
    }

    const orderId = result.result.txid[0];
    const execution = await kraken.checkOrderExecuted(orderId);
    const sellPrice = execution?.price || precio;
    const feeEUR = execution?.fee || 0;

    // Intentar encontrar el último trade activo para actualizar
    const { rows } = await pool.query(
      "SELECT * FROM trades WHERE pair = $1 AND status = 'active' ORDER BY createdAt DESC LIMIT 1",
      [cleanPair]
    );

    if (rows.length > 0) {
      const last = rows[0];
      const profit = ((sellPrice - last.buyprice) / last.buyprice) * 100;

      await pool.query(
        "UPDATE trades SET sellPrice = $1, profitPercent = $2, feeEUR = $3, status = 'completed' WHERE id = $4",
        [sellPrice.toFixed(5), profit.toFixed(2), feeEUR.toFixed(5), last.id]
      );

      console.log(`✅ Venta registrada para ${cleanPair}: ${montoAVender} a ${sellPrice}, fee: ${feeEUR}`);
    } else {
      console.log(`⚠️ Venta ejecutada sin entrada activa en DB para ${cleanPair}`);
    }

    res.status(200).json({ message: "Venta ejecutada correctamente", txid: orderId });
  } catch (err) {
    console.error("❌ Error en /vender:", err);
    res.status(500).json({ error: "Error al procesar la venta" });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Servidor corriendo en el puerto ${port}`);
});