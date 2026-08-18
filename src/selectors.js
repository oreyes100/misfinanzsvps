import { todayISO } from "./utils.js";

export function netWorthEUR(state) {
  const { accounts, assets, fx, goldPriceEUR } = state;
  const autoLoan = accounts
    .filter((a) => a.type === "auto_loan")
    .reduce((s, a) => s + a.balance * (fx[a.currency] ?? 1), 0);
  const cash = accounts
    .filter((a) => a.type !== "auto_loan")
    .reduce((s, a) => s + a.balance * (fx[a.currency] ?? 1), 0);
  const crypto = assets.crypto.reduce((s, c) => s + c.qty * (fx[c.symbol] ?? 0), 0);
  const gold = assets.gold.grams * goldPriceEUR;
  const re = assets.realEstate.reduce((s, r) => s + r.valueEUR, 0);
  const depreciating = (assets.depreciating || []).reduce((s, d) => s + d.valueEUR, 0);
  return { cash, crypto, gold, realEstate: re, depreciating, autoLoan, total: cash + crypto + gold + re + depreciating };
}

export function monthSpend(state) {
  const month = todayISO().slice(0, 7);
  return state.transactions
    .filter((t) => t.date.startsWith(month) && t.amount < 0 && t.category !== "Transferencia")
    .reduce((s, t) => s + Math.abs(t.amount) * (state.fx[t.currency] ?? 1), 0);
}

export function currentCycle(payDay, ref = new Date()) {
  const d = new Date(ref);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function pendingCardPayments(state, ref = new Date()) {
  const today = new Date(ref);
  const dom = today.getDate();
  return state.accounts
    .filter((a) => a.type === "credit" && a.balance < 0 && a.payDay)
    .map((a) => {
      const cycle = currentCycle(a.payDay, today);
      const paid = a.lastPaidCycle === cycle;
      const due = dom >= a.payDay;
      const daysToDue = a.payDay - dom;
      return { account: a, cycle, paid, due, daysToDue, debt: Math.abs(a.balance) };
    })
    .filter((p) => !p.paid && (p.due || p.daysToDue <= 5));
}

// ---------- Calidad de categorías (Operación NULL HUNTER) ----------

const NULL_CRITICAL_PCT = 5;
const OTROS_WARNING_PCT = 10;

/**
 * Salud de la clasificación por categorías. Report parity con Reports.jsx:
 * excluye "Transferencia" (movimientos internos no son gasto/ingreso) y las
 * transacciones marcadas para excluir del reporte de categorías.
 * @returns {{total, nullCount, nullPct, otrosCount, otrosPct, categorizedPct, status, alerts: object[]}}
 */
export function categoryHealth(state) {
  const txs = (state.transactions || []).filter(
    (t) => t.category !== "Transferencia" && !t.excludeFromCategoryReport
  );
  const total = txs.length;
  if (total === 0) return { total: 0, nullCount: 0, nullPct: 0, otrosCount: 0, otrosPct: 0, categorizedPct: 100, status: "ok", alerts: [] };

  const nullCount = txs.filter((t) => !t.category || String(t.category).trim() === "" || String(t.category) === "null").length;
  const otrosCount = txs.filter((t) => t.category === "Otros").length;
  const nullPct = (nullCount / total) * 100;
  const otrosPct = (otrosCount / total) * 100;
  const alerts = [];

  if (nullPct > NULL_CRITICAL_PCT) {
    alerts.push({ level: "critical", action: "send_to_mcp", message: `${nullPct.toFixed(1)}% de transacciones sin categoría` });
  } else if (nullPct > 0) {
    alerts.push({ level: "warning", action: "review", message: `${nullPct.toFixed(1)}% sin categoría` });
  }
  if (otrosPct > OTROS_WARNING_PCT) {
    alerts.push({ level: "warning", action: "reclassify_otros", message: `${otrosPct.toFixed(1)}% en "Otros", considera reclasificar` });
  }

  return {
    total,
    nullCount,
    nullPct,
    otrosCount,
    otrosPct,
    categorizedPct: 100 - nullPct,
    status: nullPct > NULL_CRITICAL_PCT ? "critical" : alerts.length ? "warning" : "ok",
    alerts,
  };
}
