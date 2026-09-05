// reconcile-balances-w38.mjs — recalcula balances de cuentas corruptas.
// CORRER EN EL VPS: node scripts/reconcile-balances-w38.mjs [--list] [accId=accId2...]
// - Sin args con IDs: recalcula balance = Σtx para las cuentas listadas (opening 0).
// - --list: muestra cuentas con balance≠Σtx y su opening implícito (auditoría).
// Contexto W37g: el gap del merge descartó créditos de balance (p. ej. PlataInv
// perdió el +25000 → balance 52.10 en vez de 25020.84).
import { openDb } from "../server/db.mjs";
import * as apply from "../server/hermes/apply.mjs";

const CODE = "mf-60ec529050f44bfab1";
const args = process.argv.slice(2);
const LIST = args.includes("--list");
const targets = args.filter((a) => !a.startsWith("--"));

const db = openDb();
const st = await apply.loadState(db, CODE);
const txs = st.transactions || [];
const accs = st.accounts || [];

const sumByAcc = {};
for (const t of txs) if (t.accountId) sumByAcc[t.accountId] = (sumByAcc[t.accountId] || 0) + (t.amount || 0);

const r2 = (n) => Math.round((n || 0) * 100) / 100;

if (LIST) {
  console.log("=== AUDITORÍA balance vs Σtx ===");
  for (const a of [...accs].sort((x, y) => (x.balance || 0) - (y.balance || 0))) {
    const sum = r2(sumByAcc[a.id] || 0);
    const bal = r2(a.balance || 0);
    const open = r2(bal - sum);
    const n = txs.filter((t) => t.accountId === a.id).length;
    if (Math.abs(open) > 5) console.log(`  ${a.name} | bal ${bal} | Σtx ${sum} | opening ${open} | ${n} txs`);
  }
  console.log("=== FIN ===");
  process.exit(0);
}

if (!targets.length) {
  console.error("Uso: reconcile-balances-w38.mjs [--list] accId1 accId2 ...");
  process.exit(1);
}

const next = { ...st, accounts: accs.map((a) => {
  if (!targets.includes(a.id)) return a;
  const sum = r2(sumByAcc[a.id] || 0);
  const old = r2(a.balance || 0);
  const fixed = { ...a, balance: sum, _updatedAt: Date.now() };
  console.log(`  ✅ ${a.name}: balance ${old} → ${sum} (Σtx, opening 0)`);
  return fixed;
}) };

const res = await apply.saveState(db, CODE, next);
console.log(`guardado | _syncVersion ${res._syncVersion} — los devices convergen en ≤60s`);
db.close?.();