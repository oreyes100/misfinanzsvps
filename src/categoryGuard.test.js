import { describe, expect, it } from "vitest";
import { resolveCategory, ensureCategory } from "./categoryGuard.ts";
import { DEFAULT_CATEGORIES } from "./utils.ts";

describe("categoryGuard · resolveCategory", () => {
  it("usa sugerencia semántica si confianza >=0.7 y existe", () => {
    const r = resolveCategory("algo", DEFAULT_CATEGORIES, { category: "Transporte", confidence: 0.8 });
    expect(r).toBe("Transporte");
  });
  it("ignora sugerencia con confianza <0.7 y usa reglas", () => {
    const r = resolveCategory("Uber a casa", DEFAULT_CATEGORIES, { category: "Transporte", confidence: 0.6 });
    expect(r).toBe("Transporte"); // por regla Uber → Transporte
  });
  it("Uber → Transporte por reglas", () => {
    expect(resolveCategory("Uber trip", DEFAULT_CATEGORIES)).toBe("Transporte");
  });
  it("fallback a Otros si no hay match", () => {
    expect(resolveCategory("Compra misteriosa xyz123", DEFAULT_CATEGORIES)).toBe("Otros");
  });
  it("nunca devuelve null si existe Otros", () => {
    const r = resolveCategory("", DEFAULT_CATEGORIES);
    expect(r).toBe("Otros");
  });
  it("ignora sugerencia inexistente y cae a reglas", () => {
    const r = resolveCategory("Mercadona compra", DEFAULT_CATEGORIES, { category: "Inexistente", confidence: 0.9 });
    expect(r).toBe("Supermercado");
  });
});

describe("categoryGuard · ensureCategory", () => {
  it("mantiene categoría válida existente", () => {
    expect(ensureCategory("Comida", "Uber", DEFAULT_CATEGORIES)).toBe("Comida");
  });
  it("resuelve null → Otros o regla", () => {
    expect(ensureCategory(null, "Uber", DEFAULT_CATEGORIES)).toBe("Transporte");
    expect(ensureCategory("", "xyz", DEFAULT_CATEGORIES)).toBe("Otros");
    expect(ensureCategory("null", "xyz", DEFAULT_CATEGORIES)).toBe("Otros");
  });
  it("resuelve undefined con descripción vacía → Otros", () => {
    expect(ensureCategory(undefined, "", DEFAULT_CATEGORIES)).toBe("Otros");
  });
});

describe("categoryGuard · reducer guardian (integración)", () => {
  it("add_transaction sin categoría asigna Otros (no null) vía reducer", async () => {
    const { reducer } = await import("./reducer.ts");
    const { SEED } = await import("./reducer.ts");
    const state = { ...SEED, transactions: [] };
    // @ts-ignore
    const next = reducer(state, { type: "add_transaction", tx: { description: "Compra xyz123", amount: -10, currency: "EUR", accountId: "acc-corriente" } });
    expect(next.transactions[0].category).toBe("Otros");
    expect(next.transactions[0].category).not.toBeNull();
  });
  it("add_transaction con Uber asigna Transporte", async () => {
    const { reducer, SEED } = await import("./reducer.ts");
    const state = { ...SEED, transactions: [] };
    const next = reducer(state, { type: "add_transaction", tx: { description: "Uber", amount: -12, currency: "EUR", accountId: "acc-corriente" } });
    expect(next.transactions[0].category).toBe("Transporte");
  });
});
