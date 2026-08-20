// budgets.ts — Presupuestos con rollover (regla estilo YNAB/Copilot)
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