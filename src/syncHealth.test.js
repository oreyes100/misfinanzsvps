import { describe, expect, it, beforeEach } from "vitest";
import { diagnoseDivergence, shouldAutoReplace, recordResync, getLastResync, LAST_RESYNC_KEY } from "./syncHealth.ts";
import { reducer, SEED } from "./reducer.ts";

function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

describe("syncHealth · diagnoseDivergence", () => {
  it("local demo + server real → local_is_demo", () => {
    const local = { _isDemo: true, _syncVersion: 1 };
    const snap = { state: { _isDemo: false, _syncVersion: 5 }, syncVersion: 5, hash: "abc" };
    const r = diagnoseDivergence(local, snap);
    expect(r).toContain("local_is_demo");
  });
  it("missing version → missing_sync_version", () => {
    const r = diagnoseDivergence({ _syncVersion: undefined }, { state: { _syncVersion: 1 }, syncVersion: 1 });
    expect(r).toContain("missing_sync_version");
  });
  it("version mismatch → version_mismatch", () => {
    const r = diagnoseDivergence({ _syncVersion: 1 }, { state: { _syncVersion: 2 }, syncVersion: 2, hash: "h" });
    expect(r).toContain("version_mismatch");
  });
});

describe("syncHealth · shouldAutoReplace", () => {
  it("demo + real → true", () => {
    expect(shouldAutoReplace({ _isDemo: true }, { _isDemo: false })).toBe(true);
    expect(shouldAutoReplace({ _isDemo: true }, {})).toBe(true); // snapshot sin flag = real
  });
  it("real + real → false", () => {
    expect(shouldAutoReplace({ _isDemo: false }, { _isDemo: false })).toBe(false);
  });
  it("sin demo → false", () => {
    expect(shouldAutoReplace({}, { _isDemo: false })).toBe(false);
  });
});

describe("syncHealth · recordResync + getLastResync", () => {
  it("persiste y recupera", () => {
    const storage = fakeStorage();
    const orig = globalThis.localStorage;
    globalThis.localStorage = storage;
    recordResync({ reason: "heartbeat", fromVersion: 1, toVersion: 2, hash: "abc", motivos: ["hash_mismatch"] });
    const last = getLastResync();
    expect(last?.reason).toBe("heartbeat");
    expect(last?.fromVersion).toBe(1);
    expect(last?.motivos).toContain("hash_mismatch");
    globalThis.localStorage = orig;
    try { localStorage.removeItem(LAST_RESYNC_KEY); } catch {}
  });
});

describe("Convergencia (W21) — reducer demo flag", () => {
  it("cliente demo + server real → reemplaza demo automáticamente (hydrate)", () => {
    const demoState = { ...SEED, _isDemo: true, _demoSeededAt: Date.now() };
    const realState = { ...SEED, _isDemo: false, _syncVersion: 5, transactions: [{ id: "real-1", description: "Real", amount: -10, currency: "EUR", category: "Comida", accountId: "acc-corriente", date: "2026-08-20" }] };
    // simula resync que haría hydrate con server real
    const next = reducer(demoState, { type: "hydrate", state: realState });
    expect(next._isDemo).toBeFalsy();
    expect(next.transactions.some((t) => t.id === "real-1")).toBe(true);
  });
  it("datos reales divergentes → server gana (hydrate reemplaza)", () => {
    const local = { ...SEED, _isDemo: false, _syncVersion: 10, transactions: [{ id: "a", description: "Local", amount: -5, currency: "EUR", category: "Comida", accountId: "acc-corriente", date: "2026-08-20" }] };
    const server = { ...SEED, _isDemo: false, _syncVersion: 12, transactions: [{ id: "b", description: "Server", amount: -20, currency: "EUR", category: "Comida", accountId: "acc-corriente", date: "2026-08-20" }] };
    const next = reducer(local, { type: "hydrate", state: server });
    expect(next.transactions.some((t) => t.id === "b")).toBe(true);
  });
  it("cualquier dato real limpia _isDemo", () => {
    const demo = { ...SEED, _isDemo: true };
    const next = reducer(demo, { type: "add_transaction", tx: { description: "Compra real", amount: -10, currency: "EUR", accountId: "acc-corriente" } });
    expect(next._isDemo).toBe(false);
    expect(next._demoSeededAt).toBeUndefined();
  });
});
