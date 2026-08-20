// reconcileW16.mjs — Reconciliación W16 (solo lectura): teórico vs registrado
// Reconstruye el saldo diario de cada cuenta con interés caminando las
// transacciones hacia atrás desde el saldo actual, calcula el devengo teórico
// diario y lo compara contra lo registrado. No muta la BD.
import Database from "better-sqlite3";

const DB = process.argv[2] || "/home/devops/mis-finanzas/server/data/misfinanzas.db";
const SYNC = "mf-60ec529050f44bfab1";
const DAYS = 360;

const db = new Database(DB, { readonly: true });
const doc = db.prepare("SELECT state_json FROM sync_docs WHERE sync_code = ?").get(SYNC);
const state = JSON.parse(doc.state_json).state;

const r2 = (x) => Math.round(x * 100) / 100;

// Interés teórico de un día para una cuenta según su config ACTUAL.
function dailyTheoretical(acc, balance) {
  if (acc.capped) {
    const cap1 = acc.balanceCap1 || 0;
    const base1 = cap1 > 0 ? Math.min(balance, cap1) : balance;
    const cap2 = acc.balanceCap2 || 0;
    const base2 = cap2 > 0 ? Math.min(Math.max(balance - (acc.balanceCap1 || 0), 0), cap2) : 0;
    const g1 = base1 * (acc.rate1 || 0) / DAYS;
    const g2 = base2 * (acc.rate2 || 0) / DAYS;
    return r2(g1 + g2);
  }
  return acc.rate ? r2(balance * acc.rate / DAYS) : 0;
}

// Fechas de transición CONFIRMADAS por el usuario (cambio 13%→12% solo en ML, 01-ago).
// El resto de cuentas mantiene su config vigente todo el periodo → transición automática.
const TRANS_EXPLICIT = { vscgxf8c: "2026-08-01", "14035tdz": "2026-08-01" };

// Transición simple→capped: explícita si existe, si no primer día con abono determinista `int-`.
function transitionDate(accId, txs) {
  if (TRANS_EXPLICIT[accId]) return TRANS_EXPLICIT[accId];
  const det = txs
    .filter((t) => t.accountId === accId && t.category === "Intereses" && /^int-/.test(t.id))
    .map((t) => t.date)
    .sort();
  return det[0] || null;
}

// Reconstruye saldo diario caminando hacia atrás desde el balance actual.
function dailyBalances(accId, balance, txs) {
  const sorted = txs
    .filter((t) => t.accountId === accId)
    .sort((a, b) => b.date.localeCompare(a.date) || (b.rowid || 0) - (a.rowid || 0));
  const map = new Map(); // date -> balance EOD
  let bal = balance;
  let curDate = null;
  for (const t of sorted) {
    if (curDate === null || t.date !== curDate) {
      map.set(t.date, bal);
      curDate = t.date;
    }
    bal = r2(bal - t.amount);
  }
  return map;
}

const txs = state.transactions.map((t, i) => ({ ...t, rowid: i }));
const report = [];
let totalDelta = 0;

for (const acc of state.accounts) {
  if (!acc.rate && !(acc.capped && (acc.rate1 || acc.rate2))) continue;
  const accTxs = txs.filter((t) => t.accountId === acc.id && t.category === "Intereses");
  const trans = transitionDate(acc.id, txs);
  const balances = dailyBalances(acc.id, acc.balance, txs);
  const intDays = new Map();
  for (const t of accTxs) intDays.set(t.date, (intDays.get(t.date) || 0) + t.amount);

  // Días que debieron devengar: desde transición (o primer interés) hasta hoy.
  const start = trans || [...intDays.keys()].sort()[0];
  const end = new Date().toISOString().slice(0, 10);
  if (!start) continue;

  let theoretical = 0, registered = 0;
  const d = new Date(start + "T12:00:00");
  const endD = new Date(end + "T12:00:00");
  while (d <= endD) {
    const iso = d.toISOString().slice(0, 10);
    const bal = balances.get(iso) ?? acc.balance;
    theoretical += dailyTheoretical(acc, bal);
    registered += intDays.get(iso) || 0;
    d.setDate(d.getDate() + 1);
  }
  theoretical = r2(theoretical);
  registered = r2(registered);
  const delta = r2(theoretical - registered);

  const doubleDays = [];
  for (const [date, amt] of intDays) {
    const hasSimple = accTxs.some((t) => t.date === date && !/^int-/.test(t.id) && /% TAE\)$/.test(t.description));
    const hasCapped = accTxs.some((t) => t.date === date && /^int-/.test(t.id));
    if (hasSimple && hasCapped) doubleDays.push(date);
  }
  const staleTxs = accTxs
    .filter((t) => t.date > (trans || "0000") && !/^int-/.test(t.id))
    .map((t) => ({ date: t.date, amount: t.amount, id: t.id }));

  report.push({ accountId: acc.id, name: acc.name, balance: acc.balance, trans, days: theoretical / Math.max(dailyTheoretical(acc, acc.balance), 0.01), theoretical, registered, delta, doubleDays, staleTxs });
  totalDelta += delta;
}

for (const r of report) {
  console.log(`\n=== ${r.name} (${r.accountId}) balance=${r.balance}`);
  console.log(`  transición a capped: ${r.trans || "simple"} | días teóricos ≈ ${r.days.toFixed(0)}`);
  console.log(`  teórico ${r.theoretical.toFixed(2)} vs registrado ${r.registered.toFixed(2)} → delta ${r.delta.toFixed(2)}`);
  if (r.doubleDays.length) console.log(`  ⚠️ DOBLE devengo (mismo día simple+capped): ${r.doubleDays.join(", ")}`);
  if (r.staleTxs.length) console.log(`  ⚠️ TASA STALE (13% simple tras transición): ${r.staleTxs.map((t) => `${t.date}=${t.amount.toFixed(2)}`).join(", ")}`);
}
console.log(`\n=== TOTAL DELTA (Σ teórico - Σ registrado) = ${r2(totalDelta).toFixed(2)}`);