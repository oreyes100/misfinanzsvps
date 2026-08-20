// othersAnalyzer.ts — Reclasificación de "Otros" (W4 Fase 3)
import { categorize } from "./utils.ts";
import type { Category, Transaction } from "./types.ts";

function normMerchant(s: string): string {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ");
}

export interface OthersGroup {
  merchant: string;
  count: number;
  totalAmount: number;
  suggestedCategory: string;
  exampleIds: string[];
}

/**
 * Agrupa transacciones en "Otros" por merchant normalizado.
 * Solo patrones recurrentes (count >= 3) se sugieren.
 */
export function analyzeOthers(
  transactions: Transaction[],
  categories: Category[]
): OthersGroup[] {
  const others = transactions.filter((t) => t.category === "Otros");
  const map = new Map<string, { count: number; total: number; ids: string[] }>();

  for (const tx of others) {
    const merchant = normMerchant(tx.description);
    if (!merchant) continue;
    const e = map.get(merchant) || { count: 0, total: 0, ids: [] };
    e.count += 1;
    e.total += Math.abs(tx.amount || 0);
    if (e.ids.length < 3) e.ids.push(tx.id);
    map.set(merchant, e);
  }

  const out: OthersGroup[] = [];
  for (const [merchant, v] of map.entries()) {
    if (v.count < 3) continue;
    const suggestion = categorize(merchant, categories).category;
    // si ya sugiere "Otros", no aporta valor → saltar
    if (suggestion === "Otros") continue;
    out.push({
      merchant,
      count: v.count,
      totalAmount: Math.round(v.total * 100) / 100,
      suggestedCategory: suggestion,
      exampleIds: v.ids,
    });
  }

  return out.sort((a, b) => b.count - a.count);
}
