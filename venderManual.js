// venderManual.js - versión PostgreSQL
require('dotenv').config();
const { Pool } = require('pg');
const kraken = require('./krakenApiSetup');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function venderManual(par) {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM trades WHERE pair = $1 AND status = 'active' ORDER BY id DESC LIMIT 1`,
      [par]
    );

    if (rows.length === 0) {
      console.log(`❌ No hay trade activo para ${par}`);
      return;
    }

    const trade = rows[0];
    const result = await kraken.sell(par, trade.quantity);

    if (!result) {
      console.error(`❌ Error al ejecutar la venta para ${par}`);
      return;
    }

    const precioActual = await kraken.getCurrentPrice(par);
    const profit = ((precioActual - trade.buyprice) / trade.buyprice) * 100;

    await pool.query(
      `UPDATE trades SET status = 'completed', sellPrice = $1, profitPercent = $2 WHERE id = $3`,
      [precioActual, profit, trade.id]
    );

    console.log(`💰 Venta a mercado ejecutada: ${trade.quantity} ${par}`);
    console.log(`📈 Precio actual de ${par}: ${precioActual}`);
    console.log(`✅ Trade manual vendido: ${par}, Cantidad: ${trade.quantity}, Precio: ${precioActual}, Beneficio: ${profit.toFixed(2)}%`);
  } catch (error) {
    console.error(`❌ Error en venta manual: ${error.message}`);
  } finally {
    await pool.end();
  }
}

venderManual('ADAEUR'); // Puedes cambiar el par aquí si quieres probar otro