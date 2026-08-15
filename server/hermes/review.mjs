// review.mjs — Revisión recursiva (procesos perfectos).
// Para un estado de cuenta: corre auditoría comparativa contra las transacciones
// registradas, aplica las correcciones faltantes, y vuelve a auditar hasta que no
// queden discrepancias accionables (con tope maxRounds para evitar bucles).

import { aiAudit } from "./gemini.mjs";
import { addTransaction, reconcileBalance } from "./apply.mjs";

/**
 * @param {object} opts
 * @param {object} opts.state — estado actual del sync doc.
 * @param {object} opts.account — cuenta objetivo.
 * @param {object[]} opts.movements — movimientos extraídos del extracto.
 * @param {string} opts.geminiKey
 * @param {object[]} opts.categories
 * @param {number} opts.maxRounds
 * @param {string} opts.source — nombre de archivo origen (para notas).
 * @returns {Promise<{state: object, round: number, applied: object[], remaining: object[]}>}
 */
export async function reviewStatement({ state, account, movements, geminiKey, categories = [], maxRounds = 3, source = "" }) {
  let current = state;
  const applied = [];
  const appliedKeys = new Set();
  let remaining = [];

  for (let round = 1; round <= maxRounds; round++) {
    const registered = (current.transactions || [])
      .filter((t) => t.accountId === account.id)
      .map((t) => ({
        id: t.id, date: t.date, description: t.description, amount: t.amount,
        category: t.category || null, notes: t.notes || null,
      }));

    const audit = await aiAudit(movements, registered, geminiKey, { categories });
    const actionable = (audit.items || []).filter(
      (it) => it.kind === "missing" && it.proposal && it.proposal.amount > 0
    );

    remaining = (audit.items || []).filter((it) => it.kind !== "missing");

    if (actionable.length === 0) {
      return { state: current, round: round - 1, applied, remaining };
    }

    let next = current;
    for (const it of actionable) {
      const key = `${it.direction}|${it.date}|${it.proposal.amount.toFixed(2)}`;
      if (appliedKeys.has(key)) continue; // ya aplicado en una ronda anterior
      appliedKeys.add(key);
      const amount = it.direction === "in" ? it.proposal.amount : -it.proposal.amount;
      next = addTransaction(next, {
        description: it.proposal.description || it.description || "Movimiento",
        amount,
        currency: account.currency,
        accountId: account.id,
        category: it.proposal.category || null,
        date: it.proposal.date || null,
        notes: it.proposal.notes ? `${it.proposal.notes} [${source}]` : `Ingresado por Hermes desde estado de cuenta [${source}]`,
        auto: true,
      });
      applied.push({ ...it, created: true });
    }
    current = next;
  }

  return { state: current, round: maxRounds, applied, remaining, truncated: true };
}

/**
 * Reconciliación final: ajusta el saldo de la cuenta al saldo del estado de cuenta.
 * @returns {{state: object, applied: boolean, diff: number}}
 */
export function reconcileEndingBalance({ state, accountId, statementBalance, source }) {
  if (statementBalance == null || !isFinite(+statementBalance)) {
    return { state, applied: false, diff: 0 };
  }
  return reconcileBalance(state, accountId, +statementBalance, {
    description: "Ajuste por conciliación de estado de cuenta",
    notes: `Saldo reportado por el banco: ${statementBalance} [${source}]`,
  });
}