// ---------- Migraciones de estado (módulo puro, sin React) ----------
// Idempotentes: se aplican al cargar local y al bajar de la nube. Mantener
// libre de React/DOM para poder testearlas en Node (scripts/test-migrations.mjs).

import { DEFAULT_CATEGORIES, uid } from "./utils.js";

const r2 = (x) => Math.round(x * 100) / 100;
const byDateDesc = (x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0);

/**
 * Migra categorías de estados antiguos:
 *  - Agrega categorías de sistema nuevas (ej. Impuestos) que falten.
 *  - Rellena `subcategories` y `keywords` desde DEFAULT_CATEGORIES en las
 *    categorías que coinciden por nombre y aún no las tienen. Las subcategorías
 *    son globales (aplican a todas las cuentas); estados guardados antes de que
 *    existieran quedaban sin ellas, por eso no aparecían en el selector.
 *    Solo rellena cuando faltan: respeta personalizaciones del usuario.
 */
export function migrateCategories(categories) {
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

/**
 * Elimina cargos de ISR mal registrados en SOFIPOs. Regla del proyecto: las
 * SOFIPOs NO pagan ISR; cualquier "Impuesto intereses" en una cuenta sofipo es
 * un error de deploys anteriores. Borra esas transacciones y devuelve el importe
 * al saldo. Idempotente: si no quedan, no hace nada.
 */
export function stripSofipoISR(state) {
  const sofipo = new Set((state.accounts || []).filter((a) => a.type === "sofipo").map((a) => a.id));
  if (!sofipo.size) return state;

  const bad = (state.transactions || []).filter(
    (t) => t.category === "Impuestos" && sofipo.has(t.accountId) && (t.description || "").startsWith("Impuesto intereses")
  );
  if (!bad.length) return state;

  const refund = {};
  for (const t of bad) refund[t.accountId] = (refund[t.accountId] || 0) - t.amount; // t.amount<0 → suma al reembolsar
  const badIds = new Set(bad.map((t) => t.id));
  const accounts = state.accounts.map((a) => (refund[a.id] ? { ...a, balance: r2(a.balance + refund[a.id]) } : a));
  const transactions = state.transactions.filter((t) => !badIds.has(t.id));
  return { ...state, accounts, transactions };
}

/**
 * Backfill idempotente del ISR faltante en cuentas de INVERSIÓN en pesos (MXN).
 * Las SOFIPOs NO pagan ISR — se excluyen. Por cada transacción de intereses de
 * una cuenta de inversión MXN sin su impuesto pareja (mismo accountId + fecha +
 * descripción esperada), crea el cargo de ISR (0,9 % anual) derivado de la tasa
 * embebida en la descripción y ajusta el saldo. La verificación de existencia
 * evita duplicados aunque corra en cada arranque/pull.
 */
export function backfillInvestmentISR(state) {
  const invMXN = new Set(
    (state.accounts || []).filter((a) => a.type === "investment" && a.currency === "MXN").map((a) => a.id)
  );
  if (!invMXN.size) return state;

  const existingISR = new Set(
    (state.transactions || [])
      .filter((t) => t.category === "Impuestos")
      .map((t) => `${t.accountId}|${t.date}|${t.description}`)
  );

  const added = [];
  const balanceDelta = {};

  for (const t of state.transactions || []) {
    if (t.category !== "Intereses" || !invMXN.has(t.accountId) || !(t.amount > 0)) continue;
    const m = /\(([\d.]+)\s*%\s*TAE\)/.exec(t.description || ""); // "… (13.00 % TAE)"
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

/** Migraciones idempotentes aplicadas al cargar local y al bajar de la nube. */
export function migrate(state) {
  let s = { ...state, categories: migrateCategories(state.categories) };
  s = stripSofipoISR(s);        // quita ISR erróneo en sofipos (regla: no pagan ISR)
  s = backfillInvestmentISR(s); // agrega ISR faltante en inversión MXN
  return s;
}
