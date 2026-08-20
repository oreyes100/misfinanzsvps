// categoryGuard.ts — Guardianes de categoría (W4 Fase 1)
// Garantiza que ninguna transacción entre con category = null/"".
// Usa sugerencia semántica si conf>=0.7, si no reglas por substring (categorize), si no "Otros".
import { categorize } from "./utils.ts";
import type { Category } from "./types.ts";

export function resolveCategory(
  description: string,
  categories: Category[],
  semanticSuggestion?: { category: string; confidence: number } | null,
  _amount?: number
): string {
  const cats = Array.isArray(categories) ? categories : [];
  // 1. Semántica ≥0.7 y categoría existe
  if (semanticSuggestion && semanticSuggestion.confidence >= 0.7 && semanticSuggestion.category) {
    const hit = cats.find((c) => c.name === semanticSuggestion.category);
    if (hit) return hit.name;
  }
  // 2. Reglas por substring (reusa motor categorize)
  const r = categorize(description || "", cats);
  if (r && r.category && cats.some((c) => c.name === r.category)) return r.category;
  // 3. Fallback a "Otros" si existe, si no primera categoría o "Otros"
  const otros = cats.find((c) => c.name === "Otros");
  if (otros) return otros.name;
  return cats[0]?.name || "Otros";
}

/** Asegura que patch/category nunca sea null; si patch trae null/"" lo resuelve. */
export function ensureCategory(
  rawCategory: string | null | undefined,
  description: string,
  categories: Category[],
  semanticSuggestion?: { category: string; confidence: number } | null,
  amount?: number
): string {
  if (rawCategory && String(rawCategory).trim() !== "" && String(rawCategory) !== "null") {
    // si ya es válida y existe en el catálogo, mantenerla
    if (categories.some((c) => c.name === rawCategory)) return String(rawCategory);
    // si no existe en catálogo pero no es vacía, mantener tal cual (no forzar)
    return String(rawCategory);
  }
  return resolveCategory(description, categories, semanticSuggestion, amount);
}
