// migrations.ts — Migraciones de estado (módulo puro, sin React)
import type { AppState, Category } from "./types.ts";
import { DEFAULT_CATEGORIES, uid } from "./utils.ts";

const r2 = (x: number): number => Math.round(x * 100) / 100;
const byDateDesc = (x: { date: string }, y: { date: string }): number =>
  x.date < y.date ? 1 : x.date > y.date ? -1 : 0;

export function migrateCategories(categories: Category[] | undefined): Category[] {
  const cats = Array.isArray(categories) ? categories : DEFAULT_CATEGORIES;
  const byName = new Map(DEFAULT_CATEGORIES.map((c) => [c.name, c]));
  const merged = cats.map((c) => {
    const def = byName.get(c.name);
    if (!def) return c;
    const next = { ...c };
    if ((!Array.isArray(c.subcategories) || c.subcategories.length === 0) && def.subcategories?.length) {
      next.subcategories = [...def.subcategories];
    }
    if ((!Array.isArray(c.keywords) || c.keywords.length === 0) && def.keywords?.length) {
      next.keywords = [...def.keywords];
    }
    return next;
  });
  const names = new Set(merged.map((c) => c.name));
  const missing = DEFAULT_CATEGORIES.filter((c) => c.system && !names.has(c.name));
  return missing.length ? [...merged, ...missing] : merged;
}

export function stripSofipoISR(state: AppState): AppState {
  const sofipo = new Set((state.accounts || []).filter((a) => a.type === "sofipo").map((a) => a.id));
  if (!sofipo.size) return state;

  const bad = (state.transactions || []).filter(
    (t) => t.category === "Impuestos" && sofipo.has(t.accountId) && (t.description || "").startsWith("Impuesto intereses")
  );
  if (!bad.length) return state;

  const refund: Record<string, number> = {};
  for (const t of bad) refund[t.accountId] = (refund[t.accountId] || 0) - t.amount;
  const badIds = new Set(bad.map((t) => t.id));
  const accounts = state.accounts.map((a) => (refund[a.id] ? { ...a, balance: r2(a.balance + refund[a.id]) } : a));
  const transactions = state.transactions.filter((t) => !badIds.has(t.id));
  return { ...state, accounts, transactions };
}

export function backfillInvestmentISR(state: AppState): AppState {
  const invMXN = new Set(
    (state.accounts || []).filter((a) => a.type === "investment" && a.currency === "MXN").map((a) => a.id)
  );
  if (!invMXN.size) return state;

  const existingISR = new Set(
    (state.transactions || [])
      .filter((t) => t.category === "Impuestos")
      .map((t) => `${t.accountId}|${t.date}|${t.description}`)
  );

  const added: AppState["transactions"] = [];
  const balanceDelta: Record<string, number> = {};

  for (const t of state.transactions || []) {
    if (t.category !== "Intereses" || !invMXN.has(t.accountId) || !(t.amount > 0)) continue;
    const m = /\(([\d.]+)\s*%\s*TAE\)/.exec(t.description || "");
    if (!m) continue;
    const rateFrac = parseFloat(m[1]) / 100;
    if (!(rateFrac > 0)) continue;

    const isrDesc = t.description
      .replace(/^Intereses /, "Impuesto intereses ")
      .replace(/\([\d.]+\s*%\s*TAE\)/, "(0.90 % anual)");
    const key = `${t.accountId}|${t.date}|${isrDesc}`;
    if (existingISR.has(key)) continue;

    const isr = r2((t.amount * 0.009) / rateFrac);
    if (!(isr > 0.005)) continue;

    existingISR.add(key);
    added.push({
      id: uid(), date: t.date, description: isrDesc,
      amount: -isr, currency: t.currency, category: "Impuestos", accountId: t.accountId, auto: true,
    });
    balanceDelta[t.accountId] = (balanceDelta[t.accountId] || 0) - isr;
  }

  if (!added.length) return state;
  const accounts = state.accounts.map((a) =>
    balanceDelta[a.id] ? { ...a, balance: r2(a.balance + balanceDelta[a.id]) } : a
  );
  const transactions = [...added, ...state.transactions].sort(byDateDesc);
  return { ...state, accounts, transactions };
}

function migrateIsrRate(state: AppState): AppState {
  const accounts = (state.accounts || []).map((a) => {
    if (a.isrRate != null) return a;
    if (a.type === "investment" && a.currency === "MXN") return { ...a, isrRate: 0.000524 };
    return { ...a, isrRate: 0 };
  });
  return { ...state, accounts };
}

export function migrate(state: AppState): AppState {
  let s: AppState = { ...state, categories: migrateCategories(state.categories) };
  s = stripSofipoISR(s);
  s = migrateIsrRate(s);
  return s;
}
