// restore-sync.mjs — Restaura SOLO los documentos de sync desde backup/ (no toca usuarios).
// Útil tras una operación write-back que haya sobreescrito datos por error.
//
// Uso:
//   node server/restore-sync.mjs            # desde ./backup (default, junto a server/)
//   node server/restore-sync.mjs --dir /ruta  # desde otra carpeta con estructura backup/
//
// Lee backup/sync/*.json y los reescribe en SQLite con putSyncDoc (merge-on-write
// preservado para los writes concurrentes del cliente, pero aquí se fuerza overwrite
// desde el backup de Vercel → datos originales restaurados). Los usuarios y el
// motor local (SQLite) se conservan.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, initSchema, putSyncDoc, getSyncDoc } from "./db.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dirArg = process.argv.indexOf("--dir");
const sourceDir = dirArg >= 0 ? path.resolve(process.argv[dirArg + 1]) : path.join(__dirname, "..", "backup");

const db = openDb();
initSchema(db);

const syncDir = path.join(sourceDir, "sync");
let restored = 0;
let failed = 0;
let files = [];
try { files = readdirSync(syncDir).filter((f) => f.endsWith(".json")); } catch { console.log(`No se encontró ${syncDir}`); process.exit(0); }

for (const f of files) {
  const code = f.replace(/\.json$/, "");
  try {
    const data = JSON.parse(readFileSync(path.join(syncDir, f), "utf8"));
    if (data && data.state) {
      putSyncDoc(db, code, data.state, data.updatedAt ?? null);
      restored++;
    } else { console.log(`  (omitido ${f}: sin state)`); }
  } catch (e) {
    console.log(`  (error ${f}: ${e.message})`);
    failed++;
  }
}

console.log(`\nRestaurados ${restored} documentos de sync desde ${syncDir} (${failed} fallidos).`);

// Verificación rápida del doc principal
const d = getSyncDoc(db, "6c1f6e95-3cc4-4a3d-999a-5eded8789c52");
console.log(
  "6c1f6e95… -> cuentas:", (d && d.state && d.state.accounts ? d.state.accounts.length : 0),
  "tx:", (d && d.state && d.state.transactions ? d.state.transactions.length : 0),
  "v:", d && d.state && d.state._syncVersion
);
db.close();
