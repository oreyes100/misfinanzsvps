// budgets.ts — Presupuestos con rollover (regla estilo YNAB/Copilot)
import type { Settings } from "./types.ts";

export interface BudgetSettings {
  monthly: number;
}

export interface RolloverResult {
  month: string;
  openingBudget: number;
  expenses: number;
  carry: number;
  closed: boolean;
}

/**
 * Rollover de presupuesto: el sobrante del mes anterior se suma al del mes nuevo.
 * `openingBudget` = presupuesto del mes (incluye carry del mes anterior).
 * Devuelve el carry: lo que no se gastó (clamp a 0, nunca negativo).
 */
export function rolloverBudget(month: string, expenses: number, openingBudget: number): RolloverResult {
  const carry = Math.max(0, openingBudget - Math.max(0, expenses));
  return {
    month,
    openingBudget,
    expenses: Math.max(0, expenses),
    carry,
    closed: true,
  };
}

/**
 * Proyecta el presupuesto del siguiente mes: asignación mensual + carry del mes actual.
 * `monthlyAllocation` = monto que se asigna cada mes al presupuesto (nuevo + carry).
 */
export function nextMonthBudget(month: string, monthlyAllocation: number, carry: number): number {
  return monthlyAllocation + carry;
}

/** Lee el presupuesto mensual persistido (null si aún no se ha configurado). */
export function monthlyBudgetOf(settings: Settings | undefined): number | null {
  return typeof settings?.budgets?.monthly === "number" && Number.isFinite(settings.budgets.monthly)
    ? settings.budgets.monthly
    : null;
}

/** Patch de settings para guardar el presupuesto mensual (persiste vía update_settings). */
export function withMonthlyBudget(settings: Settings | undefined, monthly: number): { budgets: BudgetSettings } {
  return { budgets: { monthly: Math.max(0, monthly || 0) } };
}