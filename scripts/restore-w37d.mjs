// restore-w37d.mjs — RESTAURA las entradas borradas por la sobre-corrección W37d.
// CORRER EN EL VPS: node /home/devops/mis-finanzas/scripts/restore-w37d.mjs
// mergeById(estado del backup W29 (v721, 1481 txs), estado actual (v756, 290))
// — la unión: las borradas vuelven (sus stamps viejos) y las ediciones recientes
// (stamps nuevos) ganan. Luego: normalización EPOC + dedupe EXACTO (acc|fecha|importe).
import Database from "/home/devops/mis-finanzas/server/node_modules/better-sqlite3/lib/index.js";
import { openDb } from "../server/db.mjs";
import * as apply from "../server/hermes/apply.mjs";

const CODE = "mf-60ec529050f44bfab1";
const BAK = "/home/devops/mis-finanzas/server/data/misfinanzas.db.bak-w29";

// 1. el estado del backup W29 (readonly)
const bakDb = new Database(BAK, { readonly: true });
const bakWrap = JSON.parse(bakDb.prepare("SELECT state_json FROM sync_docs WHERE sync_code = ?").get(CODE).state_json);
const bak = bakWrap.state || bakWrap;
bakDb.close();

// 2. el estado actual
const db = openDb();
const cur = await apply.loadState(db, CODE);
console.log(`bak: txs ${(bak.transactions || []).length} | actual: txs ${(cur.transactions || []).length} (v${cur._syncVersion})`);

// 3. mergeById por ID (la unión; el stamp más nuevo gana)
function mergeById(a, b) {
  const list = Array.isArray(a) ? [...a] : [];
  const map = new Map(list.map((x) => [x.id, x]));
  for (const item of Array.isArray(b) ? b : []) {
    const prev = map.get(item.id);
    if (!prev || (item._updatedAt || 0) > (prev._updatedAt || 0)) map.set(item.id, item);
  }
  return [...map.values()];
}
const transactions = mergeById(bak.transactions, cur.transactions);
const accounts = mergeById(bak.accounts, cur.accounts);
const restored = (cur.transactions || []).length + (cur.accounts || []).length - transactions.length - accounts.length;
console.log(`unión: txs ${transactions.length} | cuentas ${accounts.length} | restauradas: ${restored}`);

// 4. normalización EPOC + dedupe EXACTO (cuenta, fecha, IMPORTE)
let stamped = 0;
const seen = new Set();
const kept = [];
let removed = 0;
for (const t of transactions) {
  if (!t._updatedAt || t._updatedAt <= 0) {
    const d = t.date ? new Date(t.date + "T23:59:59").getTime() : 0;
    t._updatedAt = Number.isFinite(d) ? d : 0;
    stamped++;
  }
  if (t.category === "Intereses" || t.category === "Impuestos") {
    const key = `${t.accountId || ""}|${t.date}|${t.amount}`;
    if (seen.has(key)) { removed++; continue; }
    seen.add(key);
  }
  kept.push(t);
}
console.log(`EPOC normalizados: ${stamped} | dedupe exacto removió: ${removed}`);

// 5. el balance de las cuentas: recalculado desde las transacciones restauradas
//    NO — los balances viajan con las cuentas (el stamp más nuevo gana); el
//    recalculo manual arriesgaría doble-contar los intereses aplazados.
const next = { ...cur, transactions: kept, accounts };
const AUTO = new Set(["Intereses", "Impuestos"]);
// tombstones: ninguno nuevo (sin borrados documentados en el daño)

const AUTOCHK = kept.filter((t) => AUTO.has(t.category));
console.log(`clase interés final: ${AUTOCHK.length} | +10.42: ${kept.filter((t) => t.category === "Intereses" && Math.abs(t.amount - 10.42) < 0.01).length}`);

const res = await apply.saveState(db, CODE, next);
console.log(`✅ guardado | _syncVersion: ${res._syncVersion} | los devices convergen en ≤60s`);
db.close?.();
