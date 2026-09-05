// storeReducer.test.js — W37g: prueba el reducer REAL que usa React en producción
// (store.jsx). GAP descubierto: reducer.ts era solo para tests; los fixes W35/W36
// se aplicaron al archivo equivocado y las ediciones se revertían en prod.
import { describe, it, expect, beforeEach } from "vitest";
import { reducer } from "./store.jsx";

function cleanState(overrides = {}) {
  return {
    _syncVersion: 5,
    _dirty: false,
    settings: { baseCurrency: "MXN" },
    accounts: [
      { id: "a1", name: "Wallet", balance: 100, currency: "MXN", type: "checking" },
      { id: "a2", name: "Ahorro", balance: 500, currency: "MXN", type: "savings" },
    ],
    transactions: [],
    assets: { crypto: [], gold: { grams: 0, costBasisEUR: 0 }, realEstate: [], depreciating: [] },
    scheduled: [],
    categories: [],
    transferAliases: {},
    categoryAliases: {},
    statementPatterns: [],
    reviewQueue: [],
    deletedTransactions: {},
    deletedAccountIds: [],
    deletedAssetIds: [],
    fx: { EUR: 1, USD: 0.92, MXN: 0.05, GBP: 1.17 },
    goldPriceEUR: 68.4,
    priceHistory: {},
    ...overrides,
  };
}

function addTx(state, over = {}) {
  return reducer(state, {
    type: "add_transaction",
    tx: { description: "Café", amount: -10, currency: "MXN", accountId: "a1", date: "2026-09-04", ...over },
  });
}

describe("store.jsx reducer (PRODUCCIÓN) · W37g", () => {
  let state;
  beforeEach(() => { state = cleanState(); });

  it("update_transaction bump-ea _updatedAt del tx (el fix que faltaba en prod)", async () => {
    const created = addTx(state);
    const txId = created.transactions[0].id;
    await new Promise((r) => setTimeout(r, 5)); // T1 > T0 (Date.now() en el mismo ms)
    const edited = reducer(created, { type: "update_transaction", id: txId, patch: { amount: -25 } });
    const tx = edited.transactions.find((t) => t.id === txId);
    expect(tx.amount).toBe(-25);
    expect(tx._updatedAt).toBeGreaterThan(created.transactions[0]._updatedAt);
  });

  it("update_transaction bump-ea _updatedAt de las cuentas movidas", () => {
    const created = addTx(state); // -10 en a1 → a1=90
    const txId = created.transactions[0].id;
    const edited = reducer(created, { type: "update_transaction", id: txId, patch: { accountId: "a2", amount: -30 } });
    const a1 = edited.accounts.find((a) => a.id === "a1");
    const a2 = edited.accounts.find((a) => a.id === "a2");
    expect(a1.balance).toBe(100); // el -10 se revierte de a1
    expect(a2.balance).toBe(470); // el -30 se acredita en a2
    expect(a1._updatedAt).toBeGreaterThan(0);
    expect(a2._updatedAt).toBeGreaterThan(0);
  });

  it("add_transaction bump-ea _updatedAt del account", () => {
    const created = addTx(state);
    const a1 = created.accounts.find((a) => a.id === "a1");
    expect(a1.balance).toBe(90);
    expect(a1._updatedAt).toBeGreaterThan(0);
  });

  it("delete_transaction bump-ea _updatedAt del account y crea tombstone", () => {
    const created = addTx(state);
    const txId = created.transactions[0].id;
    const del = reducer(created, { type: "delete_transaction", id: txId });
    expect(del.transactions.length).toBe(0);
    expect(del.accounts.find((a) => a.id === "a1")._updatedAt).toBeGreaterThan(0);
    expect(del.deletedTransactions[txId]).toBeDefined();
  });

  it("transfer bump-ea _updatedAt de ambas cuentas", () => {
    const tr = reducer(state, { type: "transfer", fromId: "a1", toId: "a2", amount: 40 });
    expect(tr.accounts.find((a) => a.id === "a1")._updatedAt).toBeGreaterThan(0);
    expect(tr.accounts.find((a) => a.id === "a2")._updatedAt).toBeGreaterThan(0);
    expect(tr.transactions.length).toBe(2);
    expect(tr.transactions[0]._updatedAt).toBeGreaterThan(0);
  });

  it("marcar dirty en las mutaciones + mark_clean lo limpia sin bump de versión", () => {
    const created = addTx(state);
    expect(created._dirty).toBe(true);
    expect(created._lastChangeAt).toBeGreaterThan(0);
    const cleaned = reducer(created, { type: "mark_clean" });
    expect(cleaned._dirty).toBe(false);
    expect(cleaned._syncVersion).toBe(created._syncVersion); // sin bump extra
  });

  it("hydrate limpia _dirty y NO bump-ea la versión entrante", () => {
    const created = addTx(state); // v6
    const hyd = reducer(created, { type: "hydrate", state: cleanState({ _syncVersion: 9 }) });
    expect(hyd._dirty).toBe(false);
    expect(hyd._syncVersion).toBe(9); // adopta la entrante, sin bump a 10
  });
});