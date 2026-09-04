// clean-interests-w37.mjs — Limpieza de duplicados de intereses + normalización EPOC.
// CORRER EN EL VPS: node /home/devops/mis-finanzas/scripts/clean-interests-w37.mjs
// 1. Stamp: TODAS las txs sin _updatedAt (EPOC) reciben un stamp derivado del
//    campo date (legitimiza los merges futuros).
// 2. Dedupe: Intereses/Impuestos auto por (cuenta, fecha, importe) — la clave
//    SIN descripción (las 3 rutas de interés describen lo mismo con textos
//    distintos). Sobrevive UNA por grupo (la de _updatedAt más reciente).
// 3. saveState (bump de versión) → todos los devices resincronizan en ≤60s.
import { openDb } from "../server/db.mjs";
import * as apply from "../server/hermes/apply.mjs";

const CODE = "mf-60ec529050f44bfab1";
const db = openDb();

const st = await apply.loadState(db, CODE);
const before = (st.transactions || []).length;
const AUTO = new Set(["Intereses", "Impuestos"]);
let stamped = 0;
const seen = new Set();
const kept = [];
let removed = 0;

for (const t of st.transactions || []) {
  // 1. normalización EPOC: stamp derivado del campo date
  if (!t._updatedAt || t._updatedAt <= 0) {
    const d = t.date ? new Date(t.date + "T23:59:59").getTime() : 0;
    t._updatedAt = Number.isFinite(d) ? d : 0;
    stamped++;
  }
  // 2. dedupe de intereses/taxes auto por (cuenta, fecha, importe)
  if (AUTO.has(t.category)) { // W37b: por categoría SIN el requisito auto (los legacy dedupan igual)
    const key = `${t.accountId || ""}|${t.date}`; // W37c: sin el importe (centavos ISR bloqueaban)
    if (seen.has(key)) { removed++; continue; }
    seen.add(key);
  }
  kept.push(t);
}

console.log(`=== LIMPIEZA W37 ===`);
console.log(`txs antes: ${before} | después: ${kept.length} | removidos (dedupe): ${removed} | EPOC normalizados: ${stamped}`);
if (removed === 0 && stamped === 0) {
  console.log("Nada que limpiar — estado ya limpio.");
  db.close?.();
  process.exit(0);
}

const next = { ...st, transactions: kept };
const res = await apply.saveState(db, CODE, next);
console.log(`✅ guardado | _syncVersion: ${res._syncVersion}`);
console.log(`Todos los devices resincronizarán en ≤60s con el estado limpio.`);
db.close?.();
