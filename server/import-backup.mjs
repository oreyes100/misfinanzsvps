// import-backup.mjs — Carga el respaldo JSON (export de la app) en la DB SQLite
// local con un syncCode NUEVO y crea el usuario admin 'jr'.
// Uso: node server/import-backup.mjs <backup.json> <syncCode> <admin-pass>
import { readFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { openDb, initSchema, putSyncDoc, replaceUsers, DATA_DIR } from "./db.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const [, , backupPath, syncCode, adminPass] = process.argv;
if (!backupPath || !syncCode || !adminPass) {
  console.error("Uso: node server/import-backup.mjs <backup.json> <syncCode> <admin-pass>");
  process.exit(1);
}

mkdirSync(DATA_DIR, { recursive: true });
const db = openDb();
initSchema(db);

const raw = JSON.parse(readFileSync(backupPath, "utf8"));
const state = raw.state;
if (!state || typeof state !== "object") {
  console.error("El respaldo no tiene estado (.state).");
  process.exit(1);
}

// Actualizar geminiKey en settings para que Hermes la use (si viene en respaldo)
if (state.settings && state.settings.geminiKey) {
  console.log(`  settings.geminiKey presente (${String(state.settings.geminiKey).slice(0, 8)}…)`);
}

putSyncDoc(db, syncCode, state, Date.now());
const txs = (state.transactions || []).length;
const acs = (state.accounts || []).length;
console.log(`sync_docs: '${syncCode}' → ${acs} cuentas, ${txs} tx, v${state._syncVersion ?? "?"}`);

// Crear usuario admin jr
const salt = crypto.randomBytes(16).toString("base64");
const hash = crypto.pbkdf2Sync(String(adminPass), salt, 100_000, 32, "sha256").toString("hex");
replaceUsers(db, [
  {
    username: "jr",
    role: "admin",
    sections: "all",
    hash,
    salt,
    created: new Date().toISOString(),
  },
]);
console.log("users: jr (admin) creado");

db.close();
console.log("Importación completada.");