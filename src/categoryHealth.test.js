import { describe, expect, it } from "vitest";
import { categoryHealth } from "./selectors.js";

function state(transactions) {
  return { transactions, categories: [] };
}

describe("categoryHealth", () => {
  it("devuelve 100% categorizado con datos vacíos", () => {
    const h = categoryHealth(state([]));
    expect(h.total).toBe(0);
    expect(h.categorizedPct).toBe(100);
    expect(h.status).toBe("ok");
    expect(h.alerts).toEqual([]);
  });

  it("cuenta null y excluye Transferencia", () => {
    const h = categoryHealth(
      state([
        { id: "1", category: "Comida", amount: -10 },
        { id: "2", category: null, amount: -20 },
        { id: "3", category: "Transferencia", amount: -30 },
        { id: "4", category: "", amount: -40 },
      ])
    );
    // Transferencia no cuenta: total = 3, null = 2 (null y ""), otros = 0
    expect(h.total).toBe(3);
    expect(h.nullCount).toBe(2);
    expect(h.nullPct).toBeCloseTo(66.7, 1);
    expect(h.status).toBe("critical");
    expect(h.alerts.some((a) => a.level === "critical")).toBe(true);
  });

  it("detecta 'Otros' excesivo", () => {
    const h = categoryHealth(
      state(Array.from({ length: 10 }, (_, i) => ({ id: String(i), category: "Otros", amount: -5 })))
    );
    expect(h.otrosCount).toBe(10);
    expect(h.otrosPct).toBe(100);
    expect(h.alerts.some((a) => a.action === "reclassify_otros")).toBe(true);
  });

  it("status ok cuando null < 5% y otros < 10%", () => {
    const h = categoryHealth(
      state([
        { id: "1", category: "Comida", amount: -10 },
        { id: "2", category: "Comida", amount: -10 },
        { id: "3", category: "Comida", amount: -10 },
        { id: "4", category: "Comida", amount: -10 },
        { id: "5", category: "Comida", amount: -10 },
        { id: "6", category: "Comida", amount: -10 },
        { id: "7", category: "Comida", amount: -10 },
        { id: "8", category: "Comida", amount: -10 },
        { id: "9", category: "Comida", amount: -10 },
        { id: "10", category: "Comida", amount: -10 },
        { id: "11", category: "Comida", amount: -10 },
        { id: "12", category: "Comida", amount: -10 },
        { id: "13", category: "Comida", amount: -10 },
        { id: "14", category: "Comida", amount: -10 },
        { id: "15", category: "Comida", amount: -10 },
        { id: "16", category: "Comida", amount: -10 },
        { id: "17", category: "Comida", amount: -10 },
        { id: "18", category: "Comida", amount: -10 },
        { id: "19", category: "Comida", amount: -10 },
        { id: "20", category: "Comida", amount: -10 },
        { id: "21", category: "Comida", amount: -10 },
      ])
    );
    expect(h.nullPct).toBe(0);
    expect(h.status).toBe("ok");
  });

  it("respeta excludeFromCategoryReport", () => {
    const h = categoryHealth(
      state([
        { id: "1", category: "Comida", amount: -10 },
        { id: "2", category: null, amount: -10, excludeFromCategoryReport: true },
      ])
    );
    expect(h.total).toBe(1);
    expect(h.nullCount).toBe(0);
  });
});