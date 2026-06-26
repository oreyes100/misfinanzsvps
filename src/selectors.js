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
