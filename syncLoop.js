const sincronizar = require("./sincronizador");

console.log("⏱️ Arrancando ciclo de sincronización cada 15 minutos...");

setInterval(() => {
  sincronizar();
}, 15 * 60 * 1000); // cada 15 minutos

// Llamada inicial
sincronizar();