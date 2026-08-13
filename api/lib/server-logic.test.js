// server-logic.test.js — Tests de la lógica pura de los módulos nuevos de api/lib/
// (state-store, accounts, ai). El I/O de Blob NO se ejercita (requiere credenciales);
// se prueban las funciones puras que sustentan importación y bot de Telegram.
import { describe, it, expect } from "vitest";
import { validSyncCode, classifyCategory, addProposedTransactions, learnAccountAliases } from "./state-store.js";
import { resolveAccountByHint, suggestAccountForImage } from "./accounts.js";
import { normalizeProvider, modelsFor, classifyAiError } from "./ai.js";

describe("state-store · validSyncCode", () => {
  it("acepta códigos UUID/minúsculas con guiones", () => {
    expect(validSyncCode("6c1f6e95-3cc4-4a3d-999a-5eded8789c52")).toBe(true);
  });
  it("acepta 16-64 caracteres [a-z0-9-] sin importar mayúsculas", () => {
    expect(validSyncCode("ABCDEFGHIJKLMNOP")).toBe(true);
  });
  it("rechaza códigos cortos, espacios o símbolos", () => {
    expect(validSyncCode("")).toBe(false);
    expect(validSyncCode("abc")).toBe(false);
    expect(validSyncCode("1234 5678")).toBe(false);
    expect(validSyncCode("a".repeat(80))).toBe(false);
    expect(validSyncCode("a b c d e f g h")).toBe(false);
  });
});

describe("state-store · classifyCategory", () => {
  const categories = [
    { name: "Comida", keywords: ["restaurante", "cafe"] },
    { name: "Transporte", keywords: ["uber"] },
  ];
  it("matchea por keyword del usuario", () => {
    expect(classifyCategory("Uber viaje", categories)).toBe("Transporte");
  });
  it("cae a Otros si no hay keyword", () => {
    expect(classifyCategory("tienda random", categories)).toBe("Otros");
  });
});

describe("state-store · addProposedTransactions", () => {
  const base = {
    accounts: [{ id: "a1", name: "Corriente", currency: "EUR", balance: 1000 }],
    transactions: [],
    categories: [{ name: "Comida", keywords: ["dominos"] }, { name: "Otros", keywords: [] }],
    transferAliases: {},
  };

  it("registra out como salida y ajusta saldo", () => {
    const next = addProposedTransactions(base, [{
      description: "Dominos Pizza", amount: 18.4, direction: "out",
      currency: "EUR", category: "Comida", accountId: "a1", date: "2026-08-01",
    }]);
    expect(next.accounts[0].balance).toBeCloseTo(981.6);
    expect(next.transactions).toHaveLength(1);
    expect(next.transactions[0].amount).toBe(-18.4);
    expect(next.transactions[0].category).toBe("Comida");
  });

  it("registra in como entrada", () => {
    const next = addProposedTransactions(base, [{
      description: "Nómina", amount: 2100, direction: "in", currency: "EUR", accountId: "a1",
    }]);
    expect(next.accounts[0].balance).toBeCloseTo(3100);
    expect(next.transactions[0].amount).toBe(2100);
  });

  it("salta cuentas inexistentes", () => {
    const next = addProposedTransactions(base, [{
      description: "x", amount: 1, direction: "out", currency: "EUR", accountId: "no-existe",
    }]);
    expect(next).toBe(base);
    expect(next.transactions).toHaveLength(0);
  });

  it("usa la divisa de la cuenta cuando la propuesta no trae una válida", () => {
    const next = addProposedTransactions(base, [{
      description: "x", amount: 5, direction: "out", currency: "XXX", accountId: "a1",
    }]);
    expect(next.transactions[0].currency).toBe("EUR");
  });

  it("normaliza la categoría a 'Otros' cuando no matchea", () => {
    const next = addProposedTransactions(base, [{
      description: "misterioso", amount: 5, direction: "out", currency: "EUR", accountId: "a1",
    }]);
    expect(next.transactions[0].category).toBe("Otros");
  });
});

describe("state-store · learnAccountAliases", () => {
  it("aprende alias normalizados (minúsculas) hacia la cuenta", () => {
    const next = learnAccountAliases({ transferAliases: {} }, ["BBVA *1234", "  Santander  "], "a1");
    expect(next.transferAliases["bbva *1234"]).toBe("a1");
    expect(next.transferAliases["santander"]).toBe("a1");
  });
  it("ignora hints vacíos", () => {
    const next = learnAccountAliases({ transferAliases: {} }, [""], "a1");
    expect(next.transferAliases).toEqual({});
  });
});

describe("accounts · resolveAccountByHint / suggestAccountForImage", () => {
  const accounts = [
    { id: "a1", name: "Corriente Santander", currency: "EUR" },
    { id: "a2", name: "Ahorro", currency: "EUR" },
  ];
  const aliases = { "bbva *1234": "a1" };

  it("resuelve por nombre de cuenta en el hint", () => {
    expect(resolveAccountByHint("Santander", accounts, aliases)?.id).toBe("a1");
  });
  it("resuelve por alias aprendido", () => {
    expect(resolveAccountByHint("BBVA *1234", accounts, aliases)?.id).toBe("a1");
  });
  it("resuelve por últimos dígitos presentes en el nombre", () => {
    expect(resolveAccountByHint("Tarjeta *1234", [{ id: "x", name: "Visa 1234" }], {})?.id).toBe("x");
  });
  it("sugiere cuenta cuando el hint matchea", () => {
    const r = suggestAccountForImage({ merchant: null, accountHints: ["santander"] }, accounts, aliases);
    expect(r.confident).toBe(true);
    expect(r.account.id).toBe("a1");
  });
  it("no sugiere nada si no hay pista (recibo de comercio)", () => {
    const r = suggestAccountForImage({ merchant: "Mercadona", accountHints: [] }, accounts, aliases);
    expect(r.account).toBeNull();
    expect(r.confident).toBe(false);
  });
});

describe("ai · clasificación de errores y proveedores", () => {
  it("mapea status HTTP a códigos accionables", () => {
    expect(classifyAiError(400)).toBe("invalid_key");
    expect(classifyAiError(401)).toBe("forbidden");
    expect(classifyAiError(403)).toBe("forbidden");
    expect(classifyAiError(429)).toBe("quota");
    expect(classifyAiError(404)).toBe("model_missing");
    expect(classifyAiError(502)).toBe("overloaded");
    expect(classifyAiError(0)).toBe("network");
  });
  it("normaliza proveedor con fallback a gemini", () => {
    expect(normalizeProvider("OPENAI")).toBe("openai");
    expect(normalizeProvider("nope")).toBe("gemini");
  });
  it("modelsFor prioriza el pedido y completa con defaults", () => {
    const models = modelsFor("gemini", "gemini-2.5-flash");
    expect(models[0]).toBe("gemini-2.5-flash");
    expect(models).toContain("gemini-2.0-flash");
  });
});
