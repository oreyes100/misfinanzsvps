// splitW17.mjs — Wargame 17 "Normalización" (DRY-RUN por defecto, --apply escribe)
// Descompone bulks de intereses en movimientos diarios conservando la SUMA TOTAL
// (Δ saldo = 0, neutro). No borra dinero real: solo legibilidad + consistencia.
//
// Clasificación (verificada contra timeline real en BD):
//   bulk    = txn `int-{acc}-t{tier}-{fecha}-k{n}` multi-día (amount >= MIN_AMOUNT)
//   oldrate = txn 08-04 sin par rv-w16- (motor simple viejo, tasa==config) con
//             N>=15 días (los catch-ups capped del 08-04 son ~8 días y se excluyen)
//
// Uso: node splitW17.mjs [ruta_bd] [--apply]
import Database from "better-sqlite3";

const DB = process.argv[2] || "/home/devops/mis-finanzas/server/data/misfinanzas.db";
const APPLY = process.argv.includes("--apply");
const SYNC = "mf-60ec529050f44bfab1";
const MIN_AMOUNT = 15; // por debajo: ruido de redondeo 2dp, no vale la pena
const MIN_N_BULK = 10; // agrupaciones de fin de semana (N=2-4) NO se parten
const MIN_N_OLD = 15; // catch-ups capped del 08-04 son ~8 días → se excluyen
const OLD_RATE_DATE = "2026-08-04"; // día del doble devengo del motor simple viejo

const db = new Database(DB, APPLY ? {} : { readonly: true });
const row = db.prepare("SELECT state_json FROM sync_docs WHERE sync_code = ?").get(SYNC);
const payload = JSON.parse(row.state_json);
const state = payload.state;

const accMap = Object.fromEntries(state.accounts.map((a) => [a.id, a]));
const txById = new Map(state.transactions.map((t) => [t.id, t]));

// Base diaria idéntica al motor capped (src/interest.ts:99-102) con balance actual.
function dailyFor(acc, tier) {
  const rate = tier === 1 ? acc.rate1 || 0 : acc.rate2 || 0;
  if (!(rate > 0)) return 0;
  const cap1 = acc.balanceCap1 || 0;
  const cap2 = acc.balanceCap2 || 0;
  const base = tier === 1
    ? (cap1 > 0 ? Math.min(acc.balance, cap1) : acc.balance)
    : (cap2 > 0 ? Math.min(Math.max(acc.balance - cap1, 0), cap2) : 0);
  return base * rate / 360;
}

const addDaysISO = (iso, n) =>
  new Date(new Date(iso).getTime() + n * 86400000).toISOString().slice(0, 10);

const r2 = (x) => Math.round(x * 100) / 100;

function candidates() {
  const out = [];
  for (const t of state.transactions) {
    if (t.category !== "Intereses" || !(t.amount > 0)) continue;
    if (/ajuste/i.test(t.description || "")) continue;
    const acc = accMap[t.accountId];
    if (!acc || !acc.capped) continue;
    const isInt = /^int-/.test(t.id);
    let tier = 1;
    if (isInt) {
      const m = t.id.match(/-t(\d)-/);
      if (m) tier = parseInt(m[1], 10);
    } else {
      if (t.date !== OLD_RATE_DATE) continue;
      if (txById.has(`rv-w16-${t.id}`)) continue; // par W16 ya revertido
      if (/tasa secundaria/i.test(t.description || "")) tier = 2; // viejo simple en t2
    }
    const daily = dailyFor(acc, tier);
    if (!(daily > 0)) continue;
    const N = Math.round(t.amount / daily);
    if (isInt) {
      if (N < MIN_N_BULK) continue;
    } else {
      if (tier !== 1) continue; // old simple distinguible = t1 (set W17/W16)
      if (N < MIN_N_OLD) continue; // los catch-ups capped del 08-04 son ~8 días
    }
    if (t.amount < MIN_AMOUNT) continue;
    out.push({ t, acc, tier, daily, N, kind: isInt ? "bulk" : "oldrate" });
  }
  return out;
}

const cands = candidates();
const byKind = { bulk: [], oldrate: [] };
for (const c of cands) byKind[c.kind].push(c);

let totalSplits = 0;
let removedSum = 0;

function show(rows, title) {
  if (!rows.length) return;
  console.log(`\n${title}`);
  for (const c of rows) {
    const { t, acc, tier, daily, N, kind } = c;
    const base = r2(daily);
    const last = r2(t.amount - (N - 1) * base);
    const start = addDaysISO(t.date, -(N - 1));
    const rate = (tier === 1 ? acc.rate1 : acc.rate2) * 100;
    console.log(
      `  ${acc.name.padEnd(11)} t${tier}  ${String(t.amount).padStart(8)} → ${String(N).padStart(2)} días × ${base.toFixed(2)} (últ. ${last.toFixed(2)})  [${start} → ${t.date}]  (${rate.toFixed(2)}% TAE)`
    );
    totalSplits += N;
    removedSum += t.amount;
  }
}

show(byKind.bulk, "BULKS (int- catch-up real, 08-12):");
show(byKind.oldrate, `OLD-RATE (${OLD_RATE_DATE} sin reversa, N≥15 días):`);

const tombstones = byKind.bulk.length + byKind.oldrate.length;
console.log(`\n  Total candidatos: ${cands.length} · splits: ${totalSplits}`);
console.log(`  Suma removida: ${removedSum.toFixed(2)} MXN · Δ saldo: 0.00 MXN (neutro)`);
console.log(`  deletedTransactions: +${tombstones} tombstones (bulk → clientes la sueltan)`);
console.log(`  lastAccrual: sin cambio (forward-only; ya 2026-08-20 > fecha split)`);

if (!APPLY) {
  console.log("\n(dry-run: no se escribió. Usar --apply para escribir)");
  process.exit(0);
}

// ── Aplicar ──
const deleted = state.deletedTransactions || {};
let inserted = 0;
for (const c of cands) {
  const { t, acc, tier, daily, N } = c;
  const base = r2(daily);
  let last = r2(t.amount - (N - 1) * base);
  if (last <= 0) {
    const baseU = r2(t.amount / N);
    last = r2(t.amount - (N - 1) * baseU);
  }
  const rate = tier === 1 ? acc.rate1 : acc.rate2;
  const now = Date.now();
  for (let i = 0; i < N; i++) {
    const amt = i === N - 1 ? last : base;
    if (amt <= 0) continue;
    state.transactions.push({
      id: `sp-w17-${t.id}-${i + 1}`,
      date: addDaysISO(t.date, -(N - 1 - i)),
      description: `Intereses ${acc.name} · día ${i + 1} de ${N} (${(rate * 100).toFixed(2)} % TAE)`,
      amount: amt,
      currency: t.currency || "MXN",
      category: "Intereses",
      accountId: acc.id,
      auto: true,
      counterpartId: undefined,
      notes: `split W17 de ${t.id}`,
      _updatedAt: now,
      _w17_splitFrom: t.id,
      _w17_kind: c.kind,
      _w17_days: N,
    });
    inserted++;
  }
  // quitar la bulk + tombstone para que los clientes la suelten
  state.transactions = state.transactions.filter((x) => x.id !== t.id);
  deleted[t.id] = now;
}
state.deletedTransactions = deleted;
state._syncVersion = (state._syncVersion || 0) + 1;

// Verificación asertiva: neutralidad exacta
const sums = cands.map((c) => c.t.amount).reduce((a, b) => a + b, 0);
const splitsSum = state.transactions
  .filter((x) => /^sp-w17-/.test(x.id))
  .reduce((a, x) => a + x.amount, 0);
if (Math.abs(sums - splitsSum) > 0.01) {
  throw new Error(`Neutralidad violada: removido ${sums} vs splits ${splitsSum}`);
}

const payloadNew = JSON.stringify({ state, updatedAt: Date.now() });
db.prepare("DELETE FROM sync_docs WHERE sync_code = ?").run(SYNC);
db.prepare(
  "INSERT INTO sync_docs (sync_code, state_json, updated_at, sync_version, doc_size) VALUES (?,?,?,?,?)"
).run(SYNC, payloadNew, Date.now(), state._syncVersion ?? null, payloadNew.length);

const delTx = db.prepare("DELETE FROM transactions WHERE sync_code = ?");
const insTx = db.prepare(
  `INSERT OR REPLACE INTO transactions
     (sync_code, id, date, description, amount, currency, category, subcategory, account_id, auto, counterpart_id, notes, _updated_at, extra_json)
   VALUES (@sync_code, @id, @date, @description, @amount, @currency, @category, @subcategory, @account_id, @auto, @counterpart_id, @notes, @_updated_at, @extra_json)`
);
const delAc = db.prepare("DELETE FROM accounts WHERE sync_code = ?");
const insAc = db.prepare(
  `INSERT OR REPLACE INTO accounts
     (sync_code, id, name, type, currency, balance, rate, accrual, isr_rate, last_accrual, extra_json)
   VALUES (@sync_code, @id, @name, @type, @currency, @balance, @rate, @accrual, @isr_rate, @last_accrual, @extra_json)`
);
const KNOWN_TX = new Set(["id", "date", "description", "amount", "currency", "category", "subcategory", "accountId", "auto", "counterpartId", "notes", "_updatedAt"]);
const KNOWN_AC = new Set(["id", "name", "type", "currency", "balance", "rate", "accrual", "isrRate", "lastAccrual"]);

db.transaction(() => {
  delTx.run(SYNC);
  for (const t of state.transactions || []) {
    if (!t || t.id === undefined) continue;
    const extra = {};
    for (const k of Object.keys(t)) if (!KNOWN_TX.has(k)) extra[k] = t[k];
    insTx.run({
      sync_code: SYNC, id: String(t.id), date: t.date ?? null, description: t.description ?? null,
      amount: typeof t.amount === "number" ? t.amount : parseFloat(t.amount ?? 0) || 0,
      currency: t.currency ?? null, category: t.category ?? null, subcategory: t.subcategory ?? null,
      account_id: t.accountId ?? null, auto: t.auto ? 1 : 0, counterpart_id: t.counterpartId ?? null,
      notes: t.notes ?? null, _updated_at: t._updatedAt ?? null,
      extra_json: Object.keys(extra).length ? JSON.stringify(extra) : null,
    });
  }
  delAc.run(SYNC);
  for (const a of state.accounts || []) {
    if (!a || a.id === undefined) continue;
    const extra = {};
    for (const k of Object.keys(a)) if (!KNOWN_AC.has(k)) extra[k] = a[k];
    insAc.run({
      sync_code: SYNC, id: String(a.id), name: a.name ?? null, type: a.type ?? null, currency: a.currency ?? null,
      balance: typeof a.balance === "number" ? a.balance : parseFloat(a.balance ?? 0) || 0,
      rate: typeof a.rate === "number" ? a.rate : parseFloat(a.rate ?? 0), accrual: a.accrual ?? null,
      isr_rate: typeof a.isrRate === "number" ? a.isrRate : parseFloat(a.isrRate ?? 0),
      last_accrual: a.lastAccrual ?? null, extra_json: Object.keys(extra).length ? JSON.stringify(extra) : null,
    });
  }
})();

console.log(`\n✓ BD actualizada: ${inserted} splits insertados, ${tombstones} tombstones, syncVersion ${state._syncVersion}`);