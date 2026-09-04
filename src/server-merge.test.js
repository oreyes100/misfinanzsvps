import { describe, it, expect } from "vitest";
import { mergeById, dedupeAutoInterest, mergeStates, consolidateAndBump } from "../api/_merge.js";

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

  it("filtra cuentas borradas en merge (tombstone de cuenta real)", () => {
    const existing = {
      accounts: [{ id: "real-inv", balance: 5000, _updatedAt: 1 }],
      transactions: [],
      deletedAccountIds: ["real-inv"],
    };
    const incoming = {
      accounts: [{ id: "real-inv", balance: 5000, _updatedAt: 2 }, { id: "other", balance: 100, _updatedAt: 1 }],
      transactions: [],
      deletedAccountIds: [],
    };
    const out = mergeStates(existing, incoming);
    expect(out.accounts.find((a) => a.id === "real-inv")).toBeUndefined();
    expect(out.accounts.find((a) => a.id === "other")).toBeDefined();
    expect(out.deletedAccountIds).toContain("real-inv");
  });

  it("une deletedAccountIds de ambos lados y los aplica", () => {
    const existing = { accounts: [{ id: "a1" }, { id: "a2" }], transactions: [], deletedAccountIds: ["a1"] };
    const incoming = { accounts: [{ id: "a1" }, { id: "a2" }], transactions: [], deletedAccountIds: ["a2"] };
    const out = mergeStates(existing, incoming);
    expect(out.deletedAccountIds).toContain("a1");
    expect(out.deletedAccountIds).toContain("a2");
    expect(out.accounts).toHaveLength(0);
  });
});

describe("consolidateAndBump (W23 convergencia fuerte)", () => {
  it("dos clientes con deltas distintos → server consolida → ambos reciben lo mismo", () => {
    // Laptop tiene la cuenta A; Android tiene la cuenta B. El server los une
    // de forma determinista en un solo estado autoritativo.
    const server = { transactions: [], accounts: [{ id: "laptop-only", balance: 100, _updatedAt: 1 }], _syncVersion: 5 };
    const clientA = { transactions: [], accounts: [{ id: "android-only", balance: 200, _updatedAt: 1 }], _syncVersion: 4 };
    const outA = consolidateAndBump(server, clientA);
    // El segundo cliente push con el estado consolidado (o su propio delta).
    const clientB = { transactions: [], accounts: [{ id: "android-only", balance: 200, _updatedAt: 1 }, { id: "third", balance: 50, _updatedAt: 2 }], _syncVersion: 4 };
    const outB = consolidateAndBump(outA, clientB);
    expect(outB.accounts.map((a) => a.id).sort()).toEqual(["android-only", "laptop-only", "third"]);
    expect(outB._syncVersion).toBeGreaterThan(5);
  });

  it("avanza _syncVersion en +1 sobre el máximo (todos los clientes convergen)", () => {
    const existing = { accounts: [], transactions: [], _syncVersion: 10 };
    const incoming = { accounts: [], transactions: [], _syncVersion: 7 };
    const out = consolidateAndBump(existing, incoming);
    expect(out._syncVersion).toBe(11);
  });

  it("sin estado previo, el incoming se vuelve la base y se normaliza versión", () => {
    const out = consolidateAndBump(null, { accounts: [], transactions: [], _syncVersion: 3 });
    expect(out._syncVersion).toBe(3);
  });

  it("consolidación determinista: orden de llegada no cambia el resultado", () => {
    const server = { transactions: [], accounts: [{ id: "a", balance: 100, _updatedAt: 1 }], _syncVersion: 1 };
    const incoming = { transactions: [], accounts: [{ id: "a", balance: 250, _updatedAt: 2 }], _syncVersion: 1 };
    const out = consolidateAndBump(server, incoming);
    // _updatedAt mayor gana independientemente del orden
    expect(out.accounts.find((x) => x.id === "a").balance).toBe(250);
  });

  it("reemplazo total: el snapshot consolidado del server es adoptado tal cual", () => {
    const existing = { accounts: [{ id: "x", balance: 1, _updatedAt: 1 }], transactions: [], _syncVersion: 2 };
    const incoming = { accounts: [{ id: "y", balance: 2, _updatedAt: 1 }], transactions: [], _syncVersion: 1 };
    const out = consolidateAndBump(existing, incoming);
    // El cliente adopta `out` completo (sin re-merge) → hash local == hash server
    expect(out.accounts.map((a) => a.id).sort()).toEqual(["x", "y"]);
    expect(out._syncVersion).toBe(3);
  });
});

// ---------- W37: dedupe de intereses SIN la descripción en la clave ----------
import { dedupeAutoInterest } from "../api/_merge.js";
describe("W37 · dedupeAutoInterest normalizado", () => {
  it("3 copias EXACTAS (mismo acc+fecha+importe 10.42) → 1 sobreviviente", () => {
    const copies = [
      { id: "a", category: "Intereses", accountId: "8hyhvr89", date: "2026-07-28", description: "Intereses Kraken · 5.00 % TAE", amount: 10.42 },
      { id: "b", category: "Intereses", accountId: "8hyhvr89", date: "2026-07-28", description: "Intereses Kraken · 5.00 % TAE (depósito 1/2)", amount: 10.42 },
      { id: "c", category: "Intereses", accountId: "8hyhvr89", date: "2026-07-28", description: "Intereses Kraken · 5.00 % TAE ISR", amount: 10.42 },
    ];
    const out = dedupeAutoInterest(copies);
    expect(out.length).toBe(1);
  });
  it("legacy SIN flag auto EXACTAS dedupan igual (W37b)", () => {
    const legacy = [
      { id: "a", category: "Intereses", accountId: "x", date: "2026-07-28", description: "I", amount: 10.42 },
      { id: "b", category: "Intereses", accountId: "x", date: "2026-07-28", description: "I ISR", amount: 10.42 },
    ];
    expect(dedupeAutoInterest(legacy).length).toBe(1);
  });
  it("intereses LEGÍTIMOS distinta fecha o cuenta → sobreviven", () => {
    const legit = [
      { id: "a", category: "Intereses", accountId: "8hyhvr89", date: "2026-07-28", description: "I", amount: 10.42 },
      { id: "b", category: "Intereses", accountId: "8hyhvr89", date: "2026-08-28", description: "I", amount: 10.42 },
      { id: "c", category: "Intereses", accountId: "otra", date: "2026-07-28", description: "I", amount: 10.42 },
    ];
    expect(dedupeAutoInterest(legit).length).toBe(3);
  });
});

describe("W37d · el dedupe conserva la edición (max _updatedAt)", () => {
  it("hermana EPOC (upd 0) + edición del usuario (upd reciente) → la EDICIÓN sobrevive", () => {
    const now = Date.now();
    const copies = [
      { id: "sib", category: "Intereses", accountId: "w", date: "2026-09-01", description: "Intereses Wallet", amount: 10.42, _updatedAt: 0 },
      { id: "edit", category: "Intereses", accountId: "w", date: "2026-09-01", description: "Intereses › Rendimiento", amount: 10.42, _updatedAt: now },
    ];
    const out = dedupeAutoInterest(copies);
    expect(out.length).toBe(1);
    expect(out[0].id).toBe("edit");
  });
  it("la sobreviviente conserva la posición original (los vecinos intactos)", () => {
    const now = Date.now();
    const copies = [
      { id: "n1", category: "Comida", description: "vecino", amount: -5, _updatedAt: now },
      { id: "sib", category: "Intereses", accountId: "w", date: "2026-09-01", description: "I", amount: 10.42, _updatedAt: 0 },
      { id: "edit", category: "Intereses", accountId: "w", date: "2026-09-01", description: "I › R", amount: 10.42, _updatedAt: now },
      { id: "n2", category: "Hogar", description: "vecino2", amount: -9, _updatedAt: now },
    ];
    const out = dedupeAutoInterest(copies);
    expect(out.map((t) => t.id)).toEqual(["n1", "edit", "n2"]);
  });
});
