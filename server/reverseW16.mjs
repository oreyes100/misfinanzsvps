// reverseW16.mjs — Wargame 16 "Libro Limpio" (ESCRITURA, tras respaldo)
// Reversa trazable del doble devengo del motor simple viejo: crea una
// transacción de ajuste NEGATIVA por cada abono con tasa != config actual
// (rate1/rate2), con la misma fecha, y ajusta el balance de la cuenta.
// NO borra las transacciones originales.
// Uso: node reverseW16.mjs [ruta_bd] [--apply]
import Database from "better-sqlite3";

const DB = process.argv[2] || "/home/devops/mis-finanzas/server/data/misfinanzas.db";
const APPLY = process.argv.includes("--apply");
const SYNC = "mf-60ec529050f44bfab1";

const db = new Database(DB);
const row = db.prepare("SELECT state_json FROM sync_docs WHERE sync_code = ?").get(SYNC);
const payload = JSON.parse(row.state_json);
const state = payload.state;

// Criterio verificado en BD: abono "Intereses" DE LA PROPIA CUENTA, sin ID
// determinista `int-` (motor capped actual), cuya tasa (de la descripción) NO
// coincide con rate1/rate2 actuales = motor simple viejo en paralelo = stale.
function isStale(t, acc) {
  if (t.accountId !== acc.id) return false;
  if (t.category !== "Intereses") return false;
  if (/^int-/.test(t.id)) return false;
  if (/ajuste/i.test(t.description || "")) return false;
  const m = t.description.match(/\(([\d.]+) % TAE\)/);
  if (!m) return false;
  const rate = parseFloat(m[1]) / 100;
  const r1 = acc.rate1 || 0;
  const r2 = acc.rate2 || 0;
  return Math.abs(rate - r1) > 0.0005 && Math.abs(rate - r2) > 0.0005;
}

const knownTxIds = new Set(state.transactions.map((t) => t.id));
let reversals = 0;
let total = 0;

for (const acc of state.accounts) {
  if (!acc.capped) continue;
  const stale = state.transactions.filter((t) => isStale(t, acc));
  if (!stale.length) continue;
  let subtotal = 0;
  for (const t of stale) {
    const revId = `rv-w16-${t.id}`;
    if (knownTxIds.has(revId)) { console.warn(`⚠️ reversa ya existe: ${revId}`); continue; }
    const rev = {
      id: revId,
      date: t.date,
      description: `Ajuste W16 · reversa devengo duplicado (motor viejo)`,
      amount: -Math.round(t.amount * 100) / 100,
      currency: t.currency || "MXN",
      category: "Intereses",
      accountId: acc.id,
      auto: false,
      counterpartId: undefined,
      notes: `reversa de ${t.id} (${t.date} ${t.description})`,
      _updatedAt: Date.now(),
    };
    state.transactions.push(rev);
    knownTxIds.add(revId);
    subtotal += t.amount;
    reversals++;
  }
  acc.balance = Math.round((acc.balance - subtotal) * 100) / 100;
  acc._updatedAt = Date.now();
  total += subtotal;
  console.log(`✓ ${acc.name.padEnd(12)} reversas ${stale.length} · -${subtotal.toFixed(2)} · balance nuevo ${acc.balance.toFixed(2)}`);
}

state._syncVersion = (state._syncVersion || 0) + 1;
console.log(`\nTotal reversas: ${reversals} · ${total.toFixed(2)} MXN`);

if (!APPLY) {
  console.log("\n(dry-run: no se escribió. Usar --apply para escribir)");
  process.exit(0);
}

const payloadNew = JSON.stringify({ state, updatedAt: Date.now() });
db.prepare("DELETE FROM sync_docs WHERE sync_code = ?").run(SYNC);
db.prepare(
  "INSERT INTO sync_docs (sync_code, state_json, updated_at, sync_version, doc_size) VALUES (?,?,?,?,?)"
).run(SYNC, payloadNew, Date.now(), state._syncVersion ?? null, payloadNew.length);

// Re-normalizar tablas relacionales igual que putSyncDoc.
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

console.log("✓ BD actualizada + tablas normalizadas");