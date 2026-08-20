import { describe, expect, it } from "vitest";
import { analyzeOthers } from "./othersAnalyzer.ts";
import { DEFAULT_CATEGORIES } from "./utils.ts";

describe("othersAnalyzer · analyzeOthers", () => {
  it("agrupa por merchant y sugiere categoría", () => {
    const txs = [
      { id: "1", description: "OXXO compra", amount: -50, category: "Otros" },
      { id: "2", description: "OXXO compra", amount: -30, category: "Otros" },
      { id: "3", description: "OXXO compra", amount: -20, category: "Otros" },
      { id: "4", description: "Uber trip", amount: -15, category: "Otros" },
      { id: "5", description: "Uber trip", amount: -15, category: "Otros" },
      { id: "6", description: "Uber trip", amount: -15, category: "Otros" },
      { id: "7", description: "Compra única", amount: -10, category: "Otros" },
    ];
    const res = analyzeOthers(txs, DEFAULT_CATEGORIES);
    // solo grupos con >=3 y sugerencia != Otros
    expect(res.length).toBe(2);
    const oxxo = res.find((r) => r.merchant.includes("oxxo"));
    expect(oxxo.count).toBe(3);
    expect(oxxo.totalAmount).toBe(100);
    expect(oxxo.suggestedCategory).toBe("Supermercado");
    const uber = res.find((r) => r.merchant.includes("uber"));
    expect(uber.suggestedCategory).toBe("Transporte");
  });

  it("ignora grupos con <3 transacciones", () => {
    const txs = [
      { id: "1", description: "Tienda X", amount: -10, category: "Otros" },
      { id: "2", description: "Tienda X", amount: -10, category: "Otros" },
    ];
    expect(analyzeOthers(txs, DEFAULT_CATEGORIES).length).toBe(0);
  });

  it("ignora sugerencia Otros", () => {
    const txs = Array.from({ length: 3 }, (_, i) => ({ id: String(i), description: "Misterio xyz123", amount: -10, category: "Otros" }));
    const res = analyzeOthers(txs, DEFAULT_CATEGORIES);
    // xyz123 no matchea keywords → sugiere Otros → se filtra
    expect(res.length).toBe(0);
  });

  it("ordena por count descendente", () => {
    const txs = [
      ...Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, description: "OXXO", amount: -10, category: "Otros" })),
      ...Array.from({ length: 3 }, (_, i) => ({ id: `b${i}`, description: "Uber", amount: -10, category: "Otros" })),
    ];
    const res = analyzeOthers(txs, DEFAULT_CATEGORIES);
    expect(res[0].merchant).toContain("oxxo");
    expect(res[0].count).toBe(5);
  });

  it("no analiza si no hay Otros", () => {
    expect(analyzeOthers([{ id: "1", description: "Mercadona", amount: -10, category: "Supermercado" }], DEFAULT_CATEGORIES).length).toBe(0);
  });
});
