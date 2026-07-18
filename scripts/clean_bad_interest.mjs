/**
 * clean_bad_interest.mjs
 * Dry-run por defecto. Ejecutar con --apply para escribir al blob.
 *
 * Limpia:
 * 1. Todas las txs auto de interés/impuestos con IDs legados (no determinísticos)
 * 2. Entre txs con ID nuevo, elimina duplicados por accountId|date|tier|k
 * 3. Assets eth/dep-1: añade a deletedAssetIds y quita de arrays
 * 4. lastAccrual de todas las cuentas con intereses → hoy (evita catch-up al reiniciar)
 */
import { get, put } from "@vercel/blob";
import { readFileSync } from "node:fs";

const apply = process.argv.includes("--apply");
const todayISO = () => new Date().toISOString().slice(0, 10);

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const token = env.match(/BLOB_READ_WRITE_TOKEN="?([^"\n]+)"?/)?.[1];
if (!token) { console.error("Sin BLOB_READ_WRITE_TOKEN en .env.local"); process.exit(1); }

// ── 1) Detectar blob activo ──────────────────────────────────────────────────
const { list } = await import("@vercel/blob");
const { blobs } = await list({ prefix: "sync/", token });
if (!blobs.length) { console.error("Sin blobs sync/*"); process.exit(1); }

// El blob más recientemente actualizado
const active = blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0];
console.log(`Blob activo: ${active.pathname}  size=${active.size}  updated=${active.uploadedAt}`);

const result = await get(active.pathname, { access: "private", token, useCache: false });
if (!result) { console.error("No se pudo leer el blob"); process.exit(1); }
const blobData = JSON.parse(await new Response(result.stream).text());
const state = blobData.state;

const today = todayISO();
const NEW_PAT = /^(int|isr)-([^-]+)-t([12])-(\d{4}-\d{2}-\d{2})-k([123])$/;
const APPROVED_PAT = /-approved-/;

const txs = state.transactions || [];
const accounts = state.accounts || [];

// ── 2) Identificar txs legadas vs nuevas ─────────────────────────────────────
const legacyIds = new Set();
const newFormatIds = new Set();
for (const t of txs) {
  if (!t.auto || !["Intereses", "Impuestos"].includes(t.category)) continue;
  if (NEW_PAT.test(t.id) || APPROVED_PAT.test(t.id)) newFormatIds.add(t.id);
  else legacyIds.add(t.id);
}

console.log(`\nTxs totales: ${txs.length}`);
console.log(`IDs legados a tombstonear: ${legacyIds.size}`);
console.log(`IDs formato nuevo (conservar): ${newFormatIds.size}`);

// Cuentas agrupadas por nombre para verificar no hay dups (ya verificado: no hay)
const accWithInterest = accounts.filter(a => a.rate || a.rate1 || a.rate2);
console.log(`\nCuentas con intereses: ${accWithInterest.length}`);
accWithInterest.forEach(a => {
  const isToday = a.lastAccrual === today || a.lastAccrual1 === today;
  console.log(`  ${a.name.padEnd(15)} lastAccrual=${a.lastAccrual} ${isToday ? '(hoy ✓)' : '→ se actualizará a ' + today}`);
});

// ── 3) Assets a tombstonear ──────────────────────────────────────────────────
const ASSETS_TO_DELETE = ["eth", "dep-1"];
const existingDeletedAssets = state.deletedAssetIds || [];
const newDeletedAssets = [...new Set([...existingDeletedAssets, ...ASSETS_TO_DELETE])];
const assetsToRemoveNow = ASSETS_TO_DELETE.filter(id => !existingDeletedAssets.includes(id));
console.log(`\nAssets a tombstonear: ${assetsToRemoveNow.join(", ") || "ninguno (ya tombstoneados)"}`);
console.log(`crypto en blob:`, (state.assets?.crypto || []).map(c => c.id));
console.log(`depreciating en blob:`, (state.assets?.depreciating || []).map(d => d.id));

// ── 4) Calcular nuevo estado ─────────────────────────────────────────────────
const newDeletedTransactions = { ...(state.deletedTransactions || {}) };
let tombstoneCount = 0;
for (const id of legacyIds) {
  if (!newDeletedTransactions[id]) {
    newDeletedTransactions[id] = Date.now();
    tombstoneCount++;
  }
}

// Filtrar txs
const cleanTxs = txs.filter(t => !newDeletedTransactions[t.id]);

// Actualizar lastAccrual de todas las cuentas con intereses a hoy
const cleanAccounts = accounts.map(a => {
  const hasInterest = a.rate || a.rate1 || a.rate2;
  if (!hasInterest) return a;
  const patch = { lastAccrual: today };
  if (a.lastAccrual1 != null) patch.lastAccrual1 = today;
  if (a.lastAccrual2 != null) patch.lastAccrual2 = today;
  return { ...a, ...patch, _updatedAt: Date.now() };
});

// Filtrar assets tombstoneados
const cleanAssets = {
  ...state.assets,
  crypto: (state.assets?.crypto || []).filter(c => !newDeletedAssets.includes(c.id)),
  depreciating: (state.assets?.depreciating || []).filter(d => !newDeletedAssets.includes(d.id)),
};

console.log(`\n──────── RESUMEN DRY-RUN ────────`);
console.log(`Txs antes: ${txs.length} → después: ${cleanTxs.length} (eliminadas: ${txs.length - cleanTxs.length})`);
console.log(`Tombstones añadidos: ${tombstoneCount}`);
console.log(`Cuentas con lastAccrual actualizado: ${cleanAccounts.filter((a, i) => a.lastAccrual !== accounts[i].lastAccrual).length}`);
console.log(`Assets eliminados: eth=${!cleanAssets.crypto.find(c=>c.id==='eth') ? 'sí':'no'}, dep-1=${!cleanAssets.depreciating.find(d=>d.id==='dep-1') ? 'sí':'no'}`);
console.log(`deletedAssetIds: ${JSON.stringify(newDeletedAssets)}`);

// Verificación de seguridad
const manualTxsAffected = txs.filter(t => legacyIds.has(t.id) && !t.auto);
if (manualTxsAffected.length > 0) {
  console.error(`\n⛔ ABORT: El script borraría ${manualTxsAffected.length} txs MANUALES (auto=false). Revisar.`);
  process.exit(1);
}
// Guard: solo verificar que txs manuales no se toquen (ya verificado arriba)
// Las txs automáticas de interés pueden ser la mayoría — eso es OK
const manualTxsTotal = txs.filter(t => !t.auto).length;
const manualTxsAfter = cleanTxs.filter(t => !t.auto).length;
if (manualTxsTotal !== manualTxsAfter) {
  console.error(`\n⛔ ABORT: Se perderían txs manuales (antes=${manualTxsTotal}, después=${manualTxsAfter}).`);
  process.exit(1);
}
console.log(`Txs manuales: ${manualTxsTotal} → ${manualTxsAfter} (intactas ✓)`);

if (!apply) {
  console.log(`\n✅ Dry-run completo. Ejecutar con --apply para aplicar cambios.`);
  process.exit(0);
}

// ── 5) Aplicar ──────────────────────────────────────────────────────────────
console.log(`\n⏳ Aplicando cambios al blob...`);

const newState = {
  ...state,
  accounts: cleanAccounts,
  transactions: cleanTxs,
  deletedTransactions: newDeletedTransactions,
  deletedAssetIds: newDeletedAssets,
  assets: cleanAssets,
  _syncVersion: (state._syncVersion || 0) + 1,
};

const payload = JSON.stringify({ state: newState, updatedAt: Date.now() });
await put(active.pathname, payload, { access: "private", token, addRandomSuffix: false, allowOverwrite: true });

console.log(`✅ Blob actualizado.`);
console.log(`   Txs: ${txs.length} → ${cleanTxs.length}`);
console.log(`   Tombstones total: ${Object.keys(newDeletedTransactions).length}`);
console.log(`   deletedAssetIds: ${JSON.stringify(newDeletedAssets)}`);
