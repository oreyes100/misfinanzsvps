// interest.ts — Devengo de intereses (módulo puro, sin React)
import type { Account, AppState, Transaction, AccrualFrequency } from "./types.ts";
import { DAY_MS, daysBetween, todayISO, uid } from "./utils.ts";

const r2 = (x: number): number => Math.round(x * 100) / 100;

export function addDaysISO(iso: string, n: number): string {
  return new Date(new Date(iso).getTime() + n * DAY_MS).toISOString().slice(0, 10);
}

function depositDate(iso: string): string {
  const dow = new Date(iso + "T12:00:00").getDay();
  if (dow === 6) return addDaysISO(iso, 2);
  if (dow === 0) return addDaysISO(iso, 1);
  return iso;
}

interface AccrueTier {
  n: 1 | 2;
  rate: number;
  accrual: AccrualFrequency;
  base: number;
  gainCap: number;
  gainAcc: number;
  last: string;
  label: string;
}

interface AccrueCappedResult {
  account: Account;
  txs: Transaction[];
}

function accrueCapped(acc: Account, now: string): AccrueCappedResult {
  const txs: Transaction[] = [];
  let balance = acc.balance;
  const startBalance = acc.balance;
  const cap1 = acc.balanceCap1 || 0;
  const cap2 = acc.balanceCap2 || 0;
  const isrRate = acc.isrRate || 0;
  const DAYS_PER_YEAR = 360;

  const base1 = cap1 > 0 ? Math.min(startBalance, cap1) : startBalance;
  const base2 = cap2 > 0 ? Math.min(Math.max(startBalance - cap1, 0), cap2) : 0;

  const tiers: AccrueTier[] = [
    { n: 1, rate: acc.rate1 || 0, accrual: acc.accrual1 || "none", base: base1, gainCap: acc.gainCap1 || 0, gainAcc: acc.gainAccrued1 || 0, last: acc.lastAccrual1 || acc.lastAccrual, label: "tasa principal" },
    { n: 2, rate: acc.rate2 || 0, accrual: acc.accrual2 || "none", base: base2, gainCap: acc.gainCap2 || 0, gainAcc: acc.gainAccrued2 || 0, last: acc.lastAccrual2 || acc.lastAccrual, label: "tasa secundaria" },
  ];

  const out: Record<string, string | number> = {
    lastAccrual1: tiers[0].last, lastAccrual2: tiers[1].last,
    gainAccrued1: tiers[0].gainAcc, gainAccrued2: tiers[1].gainAcc,
  };

  for (const t of tiers) {
    if (!t.rate || t.accrual === "none") continue;
    const days = daysBetween(t.last, now);
    if (days <= 0) continue;
    const periodDays = t.accrual === "daily" ? 1 : 30;
    const periods = t.accrual === "daily" ? days : Math.floor(days / 30);
    if (periods <= 0) continue;

    const newLast = addDaysISO(t.last, periods * periodDays);
    const room = t.gainCap > 0 ? Math.max(0, t.gainCap - t.gainAcc) : Infinity;

    if (room <= 0 || t.base <= 0) continue;

    const periodicRate = t.accrual === "daily" ? t.rate / DAYS_PER_YEAR : t.rate / 12;
    let gain = t.base * (Math.pow(1 + periodicRate, periods) - 1);
    if (gain > room) gain = room;
    gain = r2(gain);

    const taxDivisor = t.accrual === "daily" ? DAYS_PER_YEAR : 12;
    const tax = r2(isrRate > 0 ? t.base * (isrRate / taxDivisor) * periods : 0);

    const date = depositDate(now);
    if (gain > 0.005) {
      txs.push({
        id: uid(), date,
        description: `Intereses ${acc.name} · ${t.label} (${(t.rate * 100).toFixed(2)} % TAE)`,
        amount: gain, currency: acc.currency, category: "Intereses", accountId: acc.id, auto: true,
      });
      balance = r2(balance + gain);
      out[`gainAccrued${t.n}`] = r2(t.gainAcc + gain);
    }
    if (isrRate > 0 && tax > 0.005) {
      txs.push({
        id: uid(), date,
        description: `Impuesto intereses ${acc.name} · ${t.label} (${(isrRate * 100).toFixed(4)} % anual)`,
        amount: -tax, currency: acc.currency, category: "Impuestos", accountId: acc.id, auto: true,
      });
      balance = r2(balance - tax);
    }
    out[`lastAccrual${t.n}`] = newLast;
  }

  return { account: { ...acc, balance, lastAccrual: now, ...out } as Account, txs };
}

export const isCappedAccount = (a: Account): boolean =>
  !!a.capped && a.currency === "MXN" && (a.type === "investment" || a.type === "sofipo");

export function accrueInterest(state: AppState): AppState {
  const now = todayISO();

  const dow = new Date(now + "T12:00:00").getDay();
  if (dow === 6 || dow === 0) return state;

  const accounts: Account[] = [];
  const newTx: Transaction[] = [];

  for (const acc of state.accounts) {
    if (isCappedAccount(acc)) {
      const { account, txs } = accrueCapped(acc, now);
      accounts.push(account);
      newTx.push(...txs);
      continue;
    }

    if (!acc.rate || acc.accrual === "none") { accounts.push(acc); continue; }
    const days = daysBetween(acc.lastAccrual, now);
    if (days <= 0) { accounts.push(acc); continue; }

    const startBalance = acc.balance;
    let balance = acc.balance;
    let gained = 0;
    let periods = 0;

    if (acc.accrual === "daily") {
      periods = days;
      const grown = balance * Math.pow(1 + acc.rate / 365, days);
      gained = grown - balance;
      balance = grown;
    } else if (acc.accrual === "monthly") {
      periods = Math.floor(days / 30);
      if (periods > 0) {
        const grown = balance * Math.pow(1 + acc.rate / 12, periods);
        gained = grown - balance;
        balance = grown;
      }
    }

    if (gained > 0.005) {
      const date = depositDate(now);
      newTx.push({
        id: uid(), date,
        description: `Intereses ${acc.name} (${(acc.rate * 100).toFixed(2)} % TAE)`,
        amount: r2(gained), currency: acc.currency, category: "Intereses", accountId: acc.id, auto: true,
      });
      let finalBalance = r2(balance);
      const isrRate = acc.isrRate || 0;
      if (isrRate > 0) {
        const taxDivisor = acc.accrual === "daily" ? 365 : 12;
        const tax = r2(startBalance * (isrRate / taxDivisor) * periods);
        if (tax > 0.005) {
          newTx.push({
            id: uid(), date,
            description: `Impuesto intereses ${acc.name} (${(isrRate * 100).toFixed(4)} % anual)`,
            amount: -tax, currency: acc.currency, category: "Impuestos", accountId: acc.id, auto: true,
          });
          finalBalance = r2(finalBalance - tax);
        }
      }
      accounts.push({ ...acc, balance: finalBalance, lastAccrual: now });
    } else {
      accounts.push(acc);
    }
  }

  if (!newTx.length) return state;
  return { ...state, accounts, transactions: [...newTx, ...state.transactions] };
}
