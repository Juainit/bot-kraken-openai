const sincronizar = require("./sincronizador");

console.log("⏱️ Ejecutando sincronización única...");

sincronizar()
  .then(() => {
    console.log("✅ Sincronización finalizada. Cerrando...");
    process.exit(0); // Finaliza correctamente el proceso
  })
  .catch((error) => {
    console.error("❌ Error durante la sincronización:", error);
    process.exit(1); // Finaliza con error si falla
  });