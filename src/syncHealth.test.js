import { describe, expect, it, beforeEach } from "vitest";
import { diagnoseDivergence, shouldAutoReplace, recordResync, getLastResync, LAST_RESYNC_KEY, pushWithRetry, recordPush, getPushLog, getLastPush } from "./syncHealth.ts";
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

// ---------- W24: pushWithRetry + telemetría de pushes ----------

describe("syncHealth · pushWithRetry (W24 Fase 4)", () => {
  const URL = "https://x.test/api/push";
  const INIT = { method: "POST", body: "{}" };
  const noSleep = async () => {}; // backoff instantáneo en tests
  it("éxito al primer intento → 1 fetch", async () => {
    let calls = 0;
    const fetchImpl = async () => { calls++; return { ok: true, status: 200 }; };
    const r = await pushWithRetry(fetchImpl, URL, INIT, { maxRetries: 3, sleep: noSleep });
    expect(r).toEqual({ ok: true, status: 200, attempts: 1, error: null, body: null });
    expect(calls).toBe(1);
  });

  it("falla 2 veces y tiene éxito al 3er intento (retry con backoff)", async () => {
    const calls = [];
    let n = 0;
    const fetchImpl = async () => { n++; calls.push(n); if (n < 3) return { ok: false, status: 502 }; return { ok: true, status: 200 }; };
    const waits = [];
    const sleep = async (ms) => { waits.push(ms); };
    const r = await pushWithRetry(fetchImpl, URL, INIT, { maxRetries: 3, sleep });
    expect(r.ok).toBe(true);
    expect(r.attempts).toBe(3);
    expect(calls).toEqual([1, 2, 3]);
    expect(waits).toEqual([1000, 2000]); // backoff lineal
  });

  it("agota los 3 reintentos → ok:false con último error (nunca lanza)", async () => {
    let calls = 0;
    const fetchImpl = async () => { calls++; throw new Error("network down"); };
    const r = await pushWithRetry(fetchImpl, URL, INIT, { maxRetries: 3, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(r.attempts).toBe(3);
    expect(calls).toBe(3);
    expect(r.error).toBe("network down");
  });

  it("HTTP 500 persistente → ok:false con error HTTP", async () => {
    const fetchImpl = async () => ({ ok: false, status: 500 });
    const r = await pushWithRetry(fetchImpl, URL, INIT, { maxRetries: 3, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("HTTP 500");
  });
});

describe("syncHealth · recordPush telemetry (W24)", () => {
  it("registra éxitos y fallos; getLastPush devuelve el más reciente; log acotado a 20", () => {
    const storage = fakeStorage();
    const orig = globalThis.localStorage;
    globalThis.localStorage = storage;
    try {
      recordPush({ success: true, syncVersion: 284, error: null, attempts: 1 });
      recordPush({ success: false, syncVersion: 284, error: "HTTP 502", attempts: 3 });
      const log = getPushLog();
      expect(log.length).toBe(2);
      expect(log[0].success).toBe(false); // más reciente primero
      expect(log[0].error).toBe("HTTP 502");
      expect(log[1].success).toBe(true);
      expect(getLastPush().syncVersion).toBe(284);
      for (let i = 0; i < 25; i++) recordPush({ success: true, syncVersion: i, error: null, attempts: 1 });
      expect(getPushLog().length).toBe(20);
    } finally {
      globalThis.localStorage = orig;
    }
  });

  it("resyncNow aborta si el push falla (decisión W24 Fase 3): no hay reemplazo cuando pending && !pushOk", async () => {
    // Escenario del wargame: cambios locales pendientes + push con fallo de red.
    // pushWithRetry devuelve ok:false → resyncNow DEBE abortar (return sin hydrate).
    const noSleep2 = async () => {};
    const fetchImpl = async () => { throw new Error("offline"); };
    const r = await pushWithRetry(fetchImpl, "https://x.test/api/push", {}, { maxRetries: 3, sleep: noSleep2 });
    expect(r.ok).toBe(false);
    // El caller (resyncNow) interpreta ok:false como abort → estado local intacto.
  });
});
