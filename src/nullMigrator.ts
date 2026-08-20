// nullMigrator.ts — Migración en lotes no bloqueante (W4 Fase 2)
// Corrige transacciones con category null/"" mediante resolveCategory, en lotes de 100.

import { resolveCategory } from "./categoryGuard.ts";
import type { Category, Transaction } from "./types.ts";

export function isNullCategory(cat: unknown): boolean {
  if (cat == null) return true;
  const s = String(cat).trim();
  return s === "" || s === "null";
}

export interface MigrateOptions {
  batchSize?: number;
  pauseMs?: number;
  /** Resolver async: (desc, cats) => { category, confidence } ; por defecto usa resolveCategory sync */
  resolveFn?: (desc: string, cats: Category[]) => Promise<{ category: string; confidence: number }> | { category: string; confidence: number };
  onProgress?: (done: number, total: number) => void;
}

/**
 * Migra transacciones con categoría null a una categoría válida.
 * No bloquea la UI: procesa por lotes y hace pausa entre ellos.
 * @returns {migrated, errors, total}
 */
export async function migrateNullCategories(
  transactions: Transaction[],
  categories: Category[],
  opts: MigrateOptions = {}
): Promise<{ migrated: number; errors: number; total: number; patches: { id: string; category: string }[] }> {
  const batchSize = opts.batchSize ?? 100;
  const pauseMs = opts.pauseMs ?? 1000;
  const resolveFn = opts.resolveFn;
  const onProgress = opts.onProgress;

  const nullTxs = transactions.filter((t) => isNullCategory((t as any).category));
  const total = nullTxs.length;
  let migrated = 0;
  let errors = 0;
  const patches: { id: string; category: string }[] = [];

  for (let i = 0; i < nullTxs.length; i += batchSize) {
    const batch = nullTxs.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (tx) => {
        try {
          let cat: string;
          if (resolveFn) {
            const r = await resolveFn(tx.description || "", categories);
            cat = r?.category || resolveCategory(tx.description || "", categories, null, tx.amount);
          } else {
            cat = resolveCategory(tx.description || "", categories, null, (tx as any).amount);
          }
          if (!cat || isNullCategory(cat)) throw new Error("no category");
          return { id: tx.id, category: cat };
        } catch {
          return { id: tx.id, category: null as any, error: true };
        }
      })
    );

    for (const r of results) {
      if (r.category && !isNullCategory(r.category)) {
        patches.push({ id: r.id, category: r.category });
        migrated++;
      } else {
        errors++;
      }
    }

    if (onProgress) onProgress(Math.min(i + batchSize, total), total);
    if (pauseMs > 0 && i + batchSize < nullTxs.length) {
      await new Promise((res) => setTimeout(res, pauseMs));
    }
  }

  return { migrated, errors, total, patches };
}
