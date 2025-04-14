// venderManual.js – Ejecuta una venta límite de ADAEUR al 100% a 0.562915

require('dotenv').config();
const kraken = require('./krakenApiSetup');

(async () => {
  const par = 'ADAEUR';
  const cantidad = 26.50916686; // Reemplaza esto con la cantidad exacta que compraste
  const precioLimite = 0.563013;

  const orderId = await kraken.sellLimit(par, cantidad, precioLimite);
  if (orderId) {
    console.log(`✅ Orden límite colocada: ${orderId}`);
  } else {
    console.log(`❌ No se pudo colocar la orden límite`);
  }
})();