// backfill-null-categories.mjs — Operación NULL HUNTER, fase 3/5.
// Corrige transacciones con categoría null/''/'null' en la DB del server
// aplicando el guardián de categorías (categoryGuard.mjs). Idempotente: solo
// toca transacciones sin categoría. Usa el mismo path de persistencia que el
// server (putSyncDoc) para que el estado en sync_docs y las tablas normalizadas
// queden coherentes y el cliente las reciba vía sync.
//
// Uso:  node backfill-null-categories.mjs [dbPath] [--dry-run]
// Ej:   node backfill-null-categories.mjs data/misfinanzas.db
//       node backfill-null-categories.mjs data/misfinanzas.db --dry-run

import { openDb, getSyncDoc, putSyncDoc } from "./db.mjs";
import { ensureCategory } from "./hermes/categoryGuard.mjs";

const dbPath = process.argv[2] || "data/misfinanzas.db";
const dryRun = process.argv.includes("--dry-run");

const db = openDb(dbPath);
const codes = db.prepare("SELECT sync_code FROM sync_docs").all().map((r) => r.sync_code);

let totalFixed = 0;
const perSource = {};

for (const code of codes) {
  const doc = getSyncDoc(db, code);
  if (!doc || !doc.state) continue;
  const state = doc.state;
  const txs = state.transactions || [];
  const nullIds = new Set(
    txs
      .filter((t) => !t.category || String(t.category).trim() === "" || String(t.category) === "null")
      .map((t) => t.id)
  );
  if (nullIds.size === 0) continue;

  let changed = false;
  const next = txs.map((t) => {
    if (!nullIds.has(t.id)) return t;
    const guard = ensureCategory({ category: t.category, description: t.description });
    changed = true;
    totalFixed++;
    perSource[guard.category] = (perSource[guard.category] || 0) + 1;
    return {
      ...t,
      category: guard.category,
      _updatedAt: Date.now(),
      _categorySource: guard.categorySource,
      _categoryConfidence: guard.categoryConfidence,
      ...(guard.needsCategoryReview ? { _needsCategoryReview: true } : {}),
    };
  });

  console.log(`[backfill] ${code}: ${nullIds.size} null -> ${dryRun ? "DRY (no escribe)" : "escribe"}`);
  if (changed && !dryRun) {
    putSyncDoc(db, code, { ...state, transactions: next }, Date.now());
  }
}

console.log("\n=== RESULTADO ===");
console.log("transacciones corregidas:", totalFixed);
if (dryRun) {
  console.log("distribución propuesta:", JSON.stringify(perSource, null, 2));
} else {
  const remaining = db
    .prepare("SELECT COUNT(*) c FROM transactions WHERE category IS NULL OR category='' OR category='null'")
    .get().c;
  console.log("null restantes en DB:", remaining);
  console.log("distribución aplicada:", JSON.stringify(perSource, null, 2));
}
db.close();