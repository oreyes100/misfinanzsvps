import { describe, expect, it, vi } from "vitest";
import { isNullCategory, migrateNullCategories } from "./nullMigrator.ts";
import { DEFAULT_CATEGORIES } from "./utils.ts";

describe("nullMigrator · isNullCategory", () => {
  it("detecta null, undefined, '', 'null'", () => {
    expect(isNullCategory(null)).toBe(true);
    expect(isNullCategory(undefined)).toBe(true);
    expect(isNullCategory("")).toBe(true);
    expect(isNullCategory("null")).toBe(true);
    expect(isNullCategory("Comida")).toBe(false);
    expect(isNullCategory("Otros")).toBe(false);
  });
});

describe("nullMigrator · migrateNullCategories", () => {
  it("migra lotes de 100 con pausa no bloqueante", async () => {
    const txs = Array.from({ length: 250 }, (_, i) => ({
      id: `tx-${i}`,
      description: i % 2 === 0 ? "Uber trip" : "Compra xyz123",
      amount: -10,
      category: null,
    }));
    const onProgress = vi.fn();
    const start = Date.now();
    const res = await migrateNullCategories(txs, DEFAULT_CATEGORIES, {
      batchSize: 100,
      pauseMs: 10,
      onProgress,
    });
    const elapsed = Date.now() - start;
    expect(res.total).toBe(250);
    expect(res.migrated).toBe(250);
    expect(res.errors).toBe(0);
    expect(res.patches.length).toBe(250);
    // 3 lotes → 2 pausas de 10ms → al menos 20ms
    expect(elapsed).toBeGreaterThanOrEqual(15);
    expect(onProgress).toHaveBeenCalledTimes(3);
    expect(onProgress).toHaveBeenNthCalledWith(1, 100, 250);
    expect(onProgress).toHaveBeenNthCalledWith(3, 250, 250);
    // verifica categorías asignadas: Uber→Transporte, xyz→Otros
    const uberPatch = res.patches.find((p) => p.id === "tx-0");
    expect(uberPatch.category).toBe("Transporte");
    const otrosPatch = res.patches.find((p) => p.id === "tx-1");
    expect(otrosPatch.category).toBe("Otros");
  });

  it("usa resolveFn async si se proporciona", async () => {
    const txs = [{ id: "1", description: "Hola mundo", amount: -5, category: null }];
    const resolveFn = async () => ({ category: "Comida", confidence: 0.9 });
    const res = await migrateNullCategories(txs, DEFAULT_CATEGORIES, {
      batchSize: 100,
      pauseMs: 0,
      resolveFn,
    });
    expect(res.migrated).toBe(1);
    expect(res.patches[0].category).toBe("Comida");
  });

  it("no hace nada si no hay nulls", async () => {
    const txs = [{ id: "1", description: "Mercadona", amount: -10, category: "Supermercado" }];
    const res = await migrateNullCategories(txs, DEFAULT_CATEGORIES, { pauseMs: 0 });
    expect(res.total).toBe(0);
    expect(res.migrated).toBe(0);
  });

  it("no bloquea event loop (permite microtasks entre lotes)", async () => {
    const txs = Array.from({ length: 200 }, (_, i) => ({ id: `tx-${i}`, description: "x", amount: -1, category: null }));
    let ticked = false;
    setTimeout(() => { ticked = true; }, 5);
    await migrateNullCategories(txs, DEFAULT_CATEGORIES, { batchSize: 100, pauseMs: 10 });
    expect(ticked).toBe(true);
  });
});
