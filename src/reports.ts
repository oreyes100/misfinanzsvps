// reports.ts — Motor puro de reportes estilo Copilot (sin React, sin DOM)
import type { Account, Currency, Transaction } from "./types.ts";
import { ACCOUNT_TYPES, BASE_FX } from "./utils.ts";

/** Convierte un monto de cualquier divisa a la divisa base usando fx real (fallback BASE_FX). */
export function toBase(amount: number, currency: Currency, fx: Partial<Record<Currency, number>>, base: Currency): number {
  const from = fx[currency] ?? BASE_FX[currency] ?? 1;
  const to = fx[base] ?? BASE_FX[base] ?? 1;
  return (amount * from) / to;
}

/** Una transacción es transferencia interna si su categoría lo marca (convención del proyecto). */
export function isTransferTx(t: Transaction): boolean {
  return t.category === "Transferencia";
}

const STOPWORDS = new Set([
  "a", "al", "de", "del", "el", "la", "los", "las", "en", "y", "o", "por", "para",
  "con", "sin", "desde", "hasta", "su", "sus", "mi", "mis", "un", "una", "unos", "unas", "mes", "dia", "día", "los",
]);

/** Normaliza la descripción para agrupar comercios recurrentes. */
export function normalizeMerchant(description: string): string {
  return (description || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(pago|cargo|cobro|compra|recibo|abono|spei|transferencia|traspaso|pago de|pago a favor|pago para|importe)\b/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .join(" ")
    .trim();
}

export interface CashflowMonth {
  key: string;
  label: string;
  income: number;
  expense: number;
  net: number;
}

/** Ingresos vs gastos por mes (últimos N meses), excluyendo transferencias internas. */
export function cashflowByMonth(
  transactions: Transaction[],
  fx: Partial<Record<Currency, number>>,
  base: Currency,
  months = 6
): CashflowMonth[] {
  const out: CashflowMonth[] = [];
  const now = new Date();
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
      label: d.toLocaleDateString("es-ES", { month: "short", year: "2-digit" }),
      income: 0,
      expense: 0,
      net: 0,
    });
  }
  const idx = Object.fromEntries(out.map((m, i) => [m.key, i]));
  for (const t of transactions) {
    if (!t || !t.date || isTransferTx(t)) continue;
    const k = t.date.slice(0, 7);
    if (!(k in idx)) continue;
    const value = toBase(t.amount, t.currency, fx, base);
    const m = out[idx[k]];
    if (value >= 0) m.income += value;
    else m.expense -= value;
  }
  for (const m of out) m.net = m.income - m.expense;
  return out;
}

export interface AllocationSlice {
  type: string;
  label: string;
  value: number;
  pct: number;
}

const LIABILITY_TYPES = new Set(["credit", "auto_loan"]);

/** Paleta estable para slices de allocation (índice determinista por tipo). */
export const ALLOC_COLORS = ["#5b8cff", "#2ee6a8", "#f5c451", "#8f63ff", "#ff5c7a", "#4dd6e8", "#ff7ad9"];

/** Diversificación de activos por tipo de cuenta, en divisa base. */
export function allocationByType(
  accounts: Account[],
  fx: Partial<Record<Currency, number>>,
  base: Currency
): AllocationSlice[] {
  const byType: Record<string, number> = {};
  for (const a of accounts) {
    if (!a || LIABILITY_TYPES.has(a.type)) continue;
    const value = toBase(a.balance || 0, a.currency, fx, base);
    if (Math.abs(value) < 0.005) continue;
    byType[a.type] = (byType[a.type] || 0) + value;
  }
  const total = Object.values(byType).reduce((s, v) => s + v, 0);
  return Object.entries(byType)
    .map(([type, value]) => ({
      type,
      label: ACCOUNT_TYPES[type as Account["type"]] || type,
      value,
      pct: total > 0 ? value / total : 0,
    }))
    .sort((a, b) => b.value - a.value);
}

export interface Subscription {
  merchant: string;
  amount: number;
  currency: Currency;
  freq: "semanal" | "mensual" | "anual" | "irregular";
  lastDate: string;
  count: number;
}

const DAY_MS = 86400000;

function classifyFreq(medianGap: number): Subscription["freq"] {
  if (medianGap <= 10) return "semanal";
  if (medianGap <= 45) return "mensual";
  if (medianGap <= 380) return "anual";
  return "irregular";
}

/** Detecta recurrentes: misma descripción normalizada con ≥2 ocurrencias. */
export function detectSubscriptions(
  transactions: Transaction[],
  fx: Partial<Record<Currency, number>>,
  base: Currency
): Subscription[] {
  const groups: Record<string, Transaction[]> = {};
  for (const t of transactions) {
    if (!t || !t.date || t.amount >= 0 || isTransferTx(t)) continue;
    const m = normalizeMerchant(t.description);
    if (!m) continue;
    (groups[m] = groups[m] || []).push(t);
  }
  const now = Date.now();
  const subs: Subscription[] = [];
  for (const [merchant, txs] of Object.entries(groups)) {
    if (txs.length < 2) continue;
    const sorted = [...txs].sort((a, b) => a.date.localeCompare(b.date));
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      gaps.push(Math.round((Date.parse(sorted[i].date) - Date.parse(sorted[i - 1].date)) / DAY_MS));
    }
    gaps.sort((a, b) => a - b);
    const median = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
    const last = sorted[sorted.length - 1];
    // Ignora recurrentes que llevan > 3 ciclos sin repetir (cadencias viejas).
    if (median > 0 && now - Date.parse(last.date) > median * 3 * DAY_MS) continue;
    subs.push({
      merchant,
      amount: toBase(Math.abs(last.amount), last.currency, fx, base),
      currency: base,
      freq: classifyFreq(median),
      lastDate: last.date,
      count: sorted.length,
    });
  }
  return subs.sort((a, b) => b.amount - a.amount);
}

export interface DailySpend {
  date: string;
  day: number;
  value: number;
}

/** Gasto diario de un mes (excluye transferencias), en divisa base. */
export function spendingLine(
  transactions: Transaction[],
  fx: Partial<Record<Currency, number>>,
  base: Currency,
  year: number,
  month: number
): DailySpend[] {
  const days = new Date(year, month, 0).getDate();
  const prefix = `${year}-${String(month).padStart(2, "0")}-`;
  const perDay: Record<string, number> = {};
  for (const t of transactions) {
    if (!t || !t.date || t.amount >= 0 || isTransferTx(t)) continue;
    if (!t.date.startsWith(prefix)) continue;
    perDay[t.date] = (perDay[t.date] || 0) + toBase(Math.abs(t.amount), t.currency, fx, base);
  }
  const out: DailySpend[] = [];
  for (let d = 1; d <= days; d++) {
    const date = `${prefix}${String(d).padStart(2, "0")}`;
    out.push({ date, day: d, value: perDay[date] || 0 });
  }
  return out;
}

/** Última etiqueta formateada de un mes (YYYY-MM → "ago. 26"). Reutilizado por el dashboard. */
export function monthLabel(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return new Date(y, (m || 1) - 1, 1).toLocaleDateString("es-ES", { month: "short", year: "2-digit" });
}