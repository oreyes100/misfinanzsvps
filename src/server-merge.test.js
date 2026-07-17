import { describe, it, expect } from "vitest";
import { mergeById, dedupeAutoInterest, mergeStates } from "../api/_merge.js";

describe("mergeById", () => {
  it("preserva items exclusivos de cada lado", () => {
    const out = mergeById([{ id: "a" }], [{ id: "b" }]);
    expect(out.map((x) => x.id).sort()).toEqual(["a", "b"]);
  });
  it("_updatedAt mayor gana", () => {
    const out = mergeById(
      [{ id: "a", v: "old", _updatedAt: 1 }],
      [{ id: "a", v: "new", _updatedAt: 2 }],
    );
    expect(out).toEqual([{ id: "a", v: "new", _updatedAt: 2 }]);
  });
  it("mantiene local si incoming es más viejo", () => {
    const out = mergeById(
      [{ id: "a", v: "new", _updatedAt: 5 }],
      [{ id: "a", v: "old", _updatedAt: 1 }],
    );
    expect(out).toEqual([{ id: "a", v: "new", _updatedAt: 5 }]);
  });
  it("tolera arrays vacíos o inválidos", () => {
    expect(mergeById(undefined, [{ id: "a" }])).toEqual([{ id: "a" }]);
    expect(mergeById([{ id: "a" }], undefined)).toEqual([{ id: "a" }]);
    expect(mergeById(null, null)).toEqual([]);
  });
});

describe("dedupeAutoInterest", () => {
  it("colapsa duplicados de interés por clave compuesta", () => {
    const txs = [
      { id: "1", auto: true, category: "Intereses", accountId: "apple", date: "2026-07-13", description: "Intereses Apple", amount: 119.35 },
      { id: "2", auto: true, category: "Intereses", accountId: "apple", date: "2026-07-13", description: "Intereses Apple", amount: 119.35 },
      { id: "3", auto: true, category: "Intereses", accountId: "apple", date: "2026-07-13", description: "Intereses Apple", amount: 119.35 },
    ];
    expect(dedupeAutoInterest(txs)).toHaveLength(1);
  });
  it("no toca txs manuales aunque compartan clave", () => {
    const txs = [
      { id: "m1", auto: false, category: "Comida", accountId: "a", date: "2026-07-13", description: "x", amount: -10 },
      { id: "m2", auto: false, category: "Comida", accountId: "a", date: "2026-07-13", description: "x", amount: -10 },
    ];
    expect(dedupeAutoInterest(txs)).toHaveLength(2);
  });
  it("distingue por cuenta y por fecha", () => {
    const txs = [
      { id: "1", auto: true, category: "Intereses", accountId: "a", date: "2026-07-13", description: "d", amount: 1 },
      { id: "2", auto: true, category: "Intereses", accountId: "b", date: "2026-07-13", description: "d", amount: 1 },
      { id: "3", auto: true, category: "Intereses", accountId: "a", date: "2026-07-14", description: "d", amount: 1 },
    ];
    expect(dedupeAutoInterest(txs)).toHaveLength(3);
  });
});

describe("mergeStates", () => {
  it("existing null devuelve incoming", () => {
    const incoming = { transactions: [{ id: "a" }], accounts: [] };
    expect(mergeStates(null, incoming)).toEqual(incoming);
  });
  it("incoming null devuelve existing", () => {
    const existing = { transactions: [{ id: "a" }], accounts: [] };
    expect(mergeStates(existing, null)).toEqual(existing);
  });
  it("une transactions y elimina duplicados por ID", () => {
    const existing = { transactions: [{ id: "1", amount: 10, _updatedAt: 1 }], accounts: [] };
    const incoming = { transactions: [{ id: "2", amount: 20, _updatedAt: 1 }], accounts: [] };
    const out = mergeStates(existing, incoming);
    expect(out.transactions.map((t) => t.id).sort()).toEqual(["1", "2"]);
  });
  it("respeta tombstones de deletedTransactions en unión", () => {
    const existing = {
      transactions: [{ id: "gone", amount: 10 }, { id: "keep", amount: 20 }],
      deletedTransactions: { gone: 999 },
      accounts: [],
    };
    const incoming = { transactions: [{ id: "gone", amount: 10 }], accounts: [] };
    const out = mergeStates(existing, incoming);
    expect(out.transactions.map((t) => t.id).sort()).toEqual(["keep"]);
    expect(out.deletedTransactions.gone).toBe(999);
  });
  it("last-write-wins por _updatedAt en cuentas", () => {
    const existing = { accounts: [{ id: "apple", balance: 100, _updatedAt: 1 }], transactions: [] };
    const incoming = { accounts: [{ id: "apple", balance: 200, _updatedAt: 2 }], transactions: [] };
    expect(mergeStates(existing, incoming).accounts[0].balance).toBe(200);
  });
  it("no permite que incoming sin _updatedAt sobrescriba newer local", () => {
    const existing = { accounts: [{ id: "apple", balance: 42125.22, _updatedAt: 999 }], transactions: [] };
    const incoming = { accounts: [{ id: "apple", balance: 0 }], transactions: [] };
    expect(mergeStates(existing, incoming).accounts[0].balance).toBe(42125.22);
  });
  it("aplica dedupe de interés en la unión", () => {
    const existing = {
      transactions: [
        { id: "1", auto: true, category: "Intereses", accountId: "a", date: "2026-07-13", description: "d", amount: 1 },
      ],
      accounts: [],
    };
    const incoming = {
      transactions: [
        { id: "2", auto: true, category: "Intereses", accountId: "a", date: "2026-07-13", description: "d", amount: 1 },
        { id: "3", auto: true, category: "Intereses", accountId: "a", date: "2026-07-13", description: "d", amount: 1 },
      ],
      accounts: [],
    };
    expect(mergeStates(existing, incoming).transactions).toHaveLength(1);
  });
  it("une settings con incoming ganando por spread final", () => {
    const existing = { settings: { spendLimit: 1000, baseCurrency: "MXN" }, accounts: [], transactions: [] };
    const incoming = { settings: { baseCurrency: "USD" }, accounts: [], transactions: [] };
    const out = mergeStates(existing, incoming);
    expect(out.settings.spendLimit).toBe(1000);
    expect(out.settings.baseCurrency).toBe("USD");
  });
});
