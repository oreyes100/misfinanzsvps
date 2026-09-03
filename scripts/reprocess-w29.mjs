// reprocess-w29.mjs — Reprocesa una imagen/PDF por el pipeline completo de Hermes.
// CORRER EN EL VPS: node /home/devops/mis-finanzas/scripts/reprocess-w29.mjs /ruta/a/imagen.jpg
// Usa el pipeline real: processImage → extractFromImage → pushDelta (/api/push).
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProcessorConfig, processImage, openDb } from "../server/hermes/processor.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.HERMES_CONFIG || path.join(HERE, "../server/hermes/config.json");
const filePath = process.argv[2];

if (!filePath) {
  console.error("Uso: node scripts/reprocess-w29.mjs /ruta/a/imagen-o-pdf");
  console.error("Ejemplo: node scripts/reprocess-w29.mjs ~/mis-finanzas/server/data/blobs/receipts/1787715930126-mzh5z9.jpg");
  process.exit(1);
}

const cfg = loadProcessorConfig(CONFIG_PATH);
const db = openDb(cfg.dbPath || undefined);
console.log(`=== REPROCESO W29 ===`);
console.log(`archivo: ${filePath}`);
console.log(`syncCode: ${cfg.syncCode} | serverUrl: ${cfg.serverUrl || "http://127.0.0.1:3000"}`);

try {
  const res = await processImage(db, cfg, filePath, path.basename(filePath));
  console.log(`\n✅ EXITO`);
  console.log(`  tipo: ${res.type}`);
  console.log(`  acciones: ${JSON.stringify(res.actions)}`);
  console.log(`  syncVersion: ${res.syncVersion}`);
  if (res.report) console.log(`  report: ${JSON.stringify(res.report).slice(0, 300)}`);
} catch (e) {
  console.error(`\n❌ FALLO: ${e.message}`);
  console.error(e.stack);
  process.exit(1);
} finally {
  db.close?.();
}
