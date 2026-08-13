// migrate.mjs — Migra los datos de Vercel Blob a la base SQLite local.
//
// Uso:
//   node server/migrate.mjs              # migra desde ./backup/* (respaldado antes)
//   node server/migrate.mjs --live       # migra desde Vercel Blob (requiere BLOB_READ_WRITE_TOKEN en .env.local)
//   node server/migrate.mjs --dir /ruta  # migra desde una carpeta con la estructura de backup
//
// Genera server/data/misfinanzas.db. El backup local es el resultado de
// scripts/backup_blobs.mjs (deja copia exacta de cada blob).
import { readFileSync, readdirSync, existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, initSchema, replaceUsers, putSyncDoc, DATA_DIR } from "./db.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const live = process.argv.includes("--live");
const dirArg = process.argv.indexOf("--dir");
const sourceDir = dirArg >= 0 ? path.resolve(process.argv[dirArg + 1]) : path.join(__dirname, "..", "backup");

mkdirSync(DATA_DIR, { recursive: true });
const db = openDb();
initSchema(db);

// ── 1. users/global.json ──
async function loadUsers() {
  if (live) {
    const { get } = await import("@vercel/blob");
    const env = readFileSync(path.join(__dirname, "..", ".env.local"), "utf8");
    const token = env.match(/BLOB_READ_WRITE_TOKEN="?([^"\n]+)"?/)?.[1];
    if (!token) throw new Error("Sin BLOB_READ_WRITE_TOKEN en .env.local");
    const r = await get("users/global.json", { access: "private", token, useCache: false });
    if (!r) return { users: [], updatedAt: 0 };
    return JSON.parse(await new Response(r.stream).text());
  }
  const f = path.join(sourceDir, "users", "global.json");
  if (!existsSync(f)) return { users: [], updatedAt: 0 };
  return JSON.parse(readFileSync(f, "utf8"));
}

// ── 2. sync/<code>.json ──
async function loadSyncDocs() {
  if (live) {
    const { list, get } = await import("@vercel/blob");
    const env = readFileSync(path.join(__dirname, "..", ".env.local"), "utf8");
    const token = env.match(/BLOB_READ_WRITE_TOKEN="?([^"\n]+)"?/)?.[1];
    if (!token) throw new Error("Sin BLOB_READ_WRITE_TOKEN en .env.local");
    const out = [];
    const res = await list({ prefix: "sync/", token, limit: 1000 });
    for (const b of res.blobs) {
      const r = await get(b.pathname, { access: "private", token, useCache: false });
      out.push({ code: b.pathname.replace(/^sync\//, "").replace(/\.json$/, ""), data: JSON.parse(await new Response(r.stream).text()) });
    }
    return out;
  }
  const syncDir = path.join(sourceDir, "sync");
  if (!existsSync(syncDir)) return [];
  const out = [];
  for (const f of readdirSync(syncDir).filter((f) => f.endsWith(".json"))) {
    try {
      const code = f.replace(/\.json$/, "");
      out.push({ code, data: JSON.parse(readFileSync(path.join(syncDir, f), "utf8")) });
    } catch (e) {
      console.log(`  (omitido ${f}: ${e.message})`);
    }
  }
  return out;
}

// ── Ejecución ──
const usersData = await loadUsers();
const users = Array.isArray(usersData.users) ? usersData.users : [];
if (users.length) {
  replaceUsers(db, users);
  console.log(`users: ${users.length} importados (${users.map((u) => u.username).join(", ")})`);
} else {
  console.log("users: vacío");
}

const docs = await loadSyncDocs();
let imported = 0;
for (const { code, data } of docs) {
  if (!data || typeof data.state !== "object") { console.log(`sync/${code}: sin state, omitido`); continue; }
  putSyncDoc(db, code, data.state, data.updatedAt ?? null);
  const txs = (data.state.transactions || []).length;
  const acs = (data.state.accounts || []).length;
  console.log(`sync/${code}: ${acs} cuentas, ${txs} tx (v${data.state._syncVersion ?? "?"})`);
  imported++;
}
console.log(`\nMigración completada: ${imported} documentos de sync + ${users.length} usuarios -> ${path.join(DATA_DIR, "misfinanzas.db")}`);
db.close();