// interestAudit.ts — Auditoría pura del historial de intereses (Wargame 15)
import type { Account, Transaction } from "./types.ts";

const DAYS_PER_YEAR = 360;

/** Interés diario teórico de un tramo capped (base 360, igual que el motor). */
export function dailyTierExpected(acc: Account, tier: 1 | 2): number {
  const rate = tier === 1 ? acc.rate1 || 0 : acc.rate2 || 0;
  const cap = tier === 1 ? acc.balanceCap1 || 0 : acc.balanceCap2 || 0;
  if (rate <= 0) return 0;
  const base = tier === 1
    ? (cap > 0 ? Math.min(acc.balance, cap) : acc.balance)
    : (cap > 0 ? Math.min(Math.max(acc.balance - (acc.balanceCap1 || 0), 0), cap) : 0);
  return base * rate / DAYS_PER_YEAR;
}

/** Interés diario teórico total de la cuenta (suma de tramos). */
export function dailyExpected(acc: Account): number {
  return dailyTierExpected(acc, 1) + dailyTierExpected(acc, 2);
}

export interface InterestAnomalyRow {
  accountId: string;
  accountName: string;
  date: string;
  amount: number;
  kind: "bulk_accrual" | "stale_rate" | "double_count";
  detail: string;
}

/** Máximo de días que un abono único puede cubrir antes de considerarse bulk. */
const MAX_SINGLE_DAYS = 4;

/**
 * Audita el historial de una cuenta capped: detecta abonos > MAX_SINGLE_DAYS,
 * tasas que no coinciden con la config actual y doble devengo el mismo día.
 * Pura: no muta nada.
 */
export function auditInterestHistory(account: Account, txs: Transaction[]): InterestAnomalyRow[] {
  const rows: InterestAnomalyRow[] = [];
  if (!account.capped) return rows;

  const perDay = new Map<string, { total: number; descs: string[] }>();
  for (const t of txs) {
    if (t.category !== "Intereses") continue;
    const cur = perDay.get(t.date) || { total: 0, descs: [] };
    cur.total += t.amount;
    cur.descs.push(t.description);
    perDay.set(t.date, cur);
  }

  const exp = dailyExpected(account);
  for (const [date, { total, descs }] of perDay) {
    const days = exp > 0 ? total / exp : 0;

    // Doble devengo: mismo día con descripciones de tramo y sin tramo (transición simple→capped)
    const cappedStyle = descs.some((d) => d.includes("tasa principal") || d.includes("tasa secundaria"));
    const simpleStyle = descs.some((d) => d.includes("% TAE") && !d.includes("tasa "));
    if (cappedStyle && simpleStyle) {
      rows.push({ accountId: account.id, accountName: account.name, date, amount: total, kind: "double_count", detail: `mismo día con configs simple y capped (${descs.join(" | ")})` });
    }

    // Bulk: excede 4 días de interés teórico
    if (exp > 0 && days > MAX_SINGLE_DAYS) {
      rows.push({ accountId: account.id, accountName: account.name, date, amount: total, kind: "bulk_accrual", detail: `~${Math.round(days)} días en un solo abono (teórico diario ${r2(exp)})` });
    }

    // Tasa stale: alguna descripción cita una tasa distinta a la config actual
    for (const d of descs) {
      const m = d.match(/\(([\d.]+) % TAE\)/);
      if (!m) continue;
      const cited = parseFloat(m[1]) / 100;
      const current = [account.rate1 || 0, account.rate2 || 0];
      if (current.every((r) => r > 0 && Math.abs(r - cited) > 0.001)) {
        rows.push({ accountId: account.id, accountName: account.name, date, amount: total, kind: "stale_rate", detail: `descripción cita ${(cited * 100).toFixed(1)}% pero config actual es ${current.map((r) => (r * 100).toFixed(1) + "%").join("/")}` });
      }
    }
  }

  return rows;
}

/** Suma total de intereses de una cuenta. */
export function totalInterest(txs: Transaction[], accountId: string): number {
  return txs.filter((t) => t.accountId === accountId && t.category === "Intereses").reduce((s, t) => s + t.amount, 0);
}

const r2 = (x: number): number => Math.round(x * 100) / 100;