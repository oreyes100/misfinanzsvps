// diagnose-w29.mjs — Auditoría forense de la BD + estado sincronizado.
// CORRER EN EL VPS: node /home/devops/mis-finanzas/scripts/diagnose-w29.mjs [--search TEXTO] [--code SYNC_CODE]
// Read-only: no modifica nada.
import Database from "/home/devops/mis-finanzas/server/node_modules/better-sqlite3/lib/index.js";

const DB_PATH = "/home/devops/mis-finanzas/server/data/misfinanzas.db";
const args = process.argv.slice(2);
const searchIdx = args.indexOf("--search");
const SEARCH = searchIdx >= 0 ? args[searchIdx + 1] : null;
const codeIdx = args.indexOf("--code");
const CODE = codeIdx >= 0 ? args[codeIdx + 1] : "mf-60ec529050f44bfab1";

const db = new Database(DB_PATH, { readonly: true });
console.log(`=== DIAGNÓSTICO W29 — ${new Date().toISOString()} ===`);
console.log(`BD: ${DB_PATH} | sync_code: ${CODE}\n`);

// 1. Cuentas en state sincronizado
const doc = db.prepare("SELECT state_json, sync_version, updated_at, doc_size FROM sync_docs WHERE sync_code = ?").get(CODE);
if (!doc) {
  console.error(`❌ sync doc ${CODE} no existe`);
  process.exit(1);
}
const wrap = JSON.parse(doc.state_json);
const st = wrap.state || wrap;
const accs = st.accounts || [];
const txs = st.transactions || [];
console.log(`1. sync doc: v${st._syncVersion} (col sync_version=${doc.sync_version}) | actualizado ${new Date(doc.updated_at).toISOString()} | ${doc.doc_size} bytes`);
console.log(`2. cuentas en state: ${accs.length} | txs: ${txs.length}`);

// 2. Cuentas listadas
console.log(`\n3. CUENTAS:`);
for (const a of [...accs].sort((x, y) => (x.name || "").localeCompare(y.name || ""))) {
  console.log(`   ${a.name}: ${a.balance} ${a.currency || ""} [${a.id}]`);
}

// 3. PlataInv
const pi = accs.filter((a) => /platainv/i.test(a.name || ""));
console.log(`\n4. PlataInv en state: ${pi.length ? "✅ " + JSON.stringify(pi.map((a) => ({ name: a.name, balance: a.balance }))) : "❌ NO"}`);

// 4. Búsqueda de transacciones
if (SEARCH) {
  const hits = txs.filter((t) => (t.description || "").toLowerCase().includes(SEARCH.toLowerCase()));
  console.log(`\n5. txs con "${SEARCH}": ${hits.length}`);
  for (const t of hits.slice(0, 10)) console.log(`   ${t.date} ${t.description} ${t.amount} [${t.accountId}] auto:${!!t.auto}`);
}

// 5. Últimas transacciones por _updatedAt
console.log(`\n6. ÚLTIMAS 10 txs (por _updatedAt):`);
for (const t of [...txs].sort((a, b) => (b._updatedAt || 0) - (a._updatedAt || 0)).slice(0, 10)) {
  console.log(`   ${t.date} ${String(t.description || "").slice(0, 45)} ${t.amount} [${t.accountId || "SIN-CUENTA"}]${t._needsCategoryReview ? " ⚠️CONFLICTO" : ""}`);
}

// 6. Conflictos pendientes
const conflicts = txs.filter((t) => t._needsCategoryReview);
console.log(`\n7. conflictos OCR pendientes: ${conflicts.length}`);
for (const t of conflicts.slice(0, 10)) console.log(`   ${t.date} ${String(t.description || "").slice(0, 45)} ${t.amount} evidence=${t.evidenceUrl || "-"}`);

// 7. Tombstones
const dt = Object.keys(st.deletedTransactions || {});
const da = st.deletedAccountIds || [];
console.log(`\n8. tombstones: ${dt.length} txs borradas, ${da.length} cuentas borradas`);
if (da.length) console.log(`   cuentas borradas: ${JSON.stringify(da)}`);

// 8. Totales
console.log(`\n9. suma balances: ${accs.reduce((s, a) => s + (a.balance || 0), 0).toFixed(2)}`);
console.log(`\n=== FIN ===`);
db.close();
