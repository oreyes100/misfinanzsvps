import { describe, expect, it } from "vitest";

import { checkWindow, makeRateLimiter } from "../server/ratelimit.mjs";
import { makeCircuitBreaker } from "../server/circuit.mjs";
import { validateCategorizePayload, validateLearnPayload } from "../server/validate.mjs";
import { getRetryDelay, retryWithBackoff } from "../server/retry.mjs";
import { makeUpdateIdStore, learnDedupKey } from "../server/idempotency.mjs";
import { checkLearnAuth, checkTelegramSecret } from "../server/auth.mjs";

describe("fortress · ratelimit · checkWindow", () => {
  it("permite hasta max en ventana", () => {
    const w = 60_000, max = 3, now = 1000;
    let ts = [];
    let r = checkWindow(ts, now, w, max);
    expect(r.allowed).toBe(true); ts = r.next;
    r = checkWindow(ts, now + 10, w, max);
    expect(r.allowed).toBe(true); ts = r.next;
    r = checkWindow(ts, now + 20, w, max);
    expect(r.allowed).toBe(true); ts = r.next;
    r = checkWindow(ts, now + 30, w, max);
    expect(r.allowed).toBe(false);
  });
  it("purga entradas fuera de ventana", () => {
    const w = 60_000, max = 2, now = 100_000;
    let ts = [1000, 2000]; // muy viejos
    const r = checkWindow(ts, now, w, max);
    expect(r.allowed).toBe(true);
    expect(r.next.length).toBe(1);
  });
});

describe("fortress · ratelimit · makeRateLimiter", () => {
  it("40 requests seguidos → últimos 429", () => {
    const rl = makeRateLimiter({ windowMs: 60_000, max: 30, nowFn: () => 0 });
    let allowed = 0, blocked = 0;
    for (let i = 0; i < 40; i++) {
      const r = rl.isAllowed("1.2.3.4", 1000 + i);
      if (r.allowed) allowed++; else blocked++;
    }
    expect(allowed).toBe(30);
    expect(blocked).toBe(10);
  });
  it("aisla por IP", () => {
    const rl = makeRateLimiter({ windowMs: 60_000, max: 2 });
    rl.isAllowed("A", 1000);
    rl.isAllowed("A", 1001);
    expect(rl.isAllowed("A", 1002).allowed).toBe(false);
    expect(rl.isAllowed("B", 1002).allowed).toBe(true);
  });
});

describe("fortress · circuit breaker", () => {
  it("abre tras threshold y cae a OPEN", () => {
    const cb = makeCircuitBreaker({ threshold: 3, resetMs: 300_000, nowFn: () => 1000 });
    cb.onFailure(1000); cb.onFailure(1001); cb.onFailure(1002);
    expect(cb.getState(1003)).toBe("OPEN");
    expect(cb.canExecute(1003)).toBe(false);
  });
  it("tras resetMs pasa a HALF_OPEN y onSuccess cierra", () => {
    let now = 0;
    const cb = makeCircuitBreaker({ threshold: 2, resetMs: 1000, nowFn: () => now });
    cb.onFailure(0); cb.onFailure(1);
    expect(cb.getState(0)).toBe("OPEN");
    now = 1500;
    expect(cb.canExecute(now)).toBe(true);
    expect(cb.getState(now)).toBe("HALF_OPEN");
    cb.onSuccess();
    expect(cb.getState(now)).toBe("CLOSED");
  });
  it("en OPEN no ejecuta hasta reset", () => {
    const cb = makeCircuitBreaker({ threshold: 1, resetMs: 5000 });
    cb.onFailure(0);
    expect(cb.canExecute(100)).toBe(false);
    expect(cb.canExecute(6000)).toBe(true);
  });
});

describe("fortress · validate categorize", () => {
  it("text requerido", () => {
    expect(validateCategorizePayload({}).ok).toBe(false);
    expect(validateCategorizePayload({ text: "" }).ok).toBe(false);
    expect(validateCategorizePayload({ text: "uber" }).ok).toBe(true);
  });
  it("text de 10k chars → 400", () => {
    expect(validateCategorizePayload({ text: "a".repeat(10_000) }).ok).toBe(false);
  });
  it("text 500 ok, 501 falla", () => {
    expect(validateCategorizePayload({ text: "a".repeat(500) }).ok).toBe(true);
    expect(validateCategorizePayload({ text: "a".repeat(501) }).ok).toBe(false);
  });
  it("categories > 50 → 400", () => {
    const cats = Array.from({ length: 51 }, (_, i) => ({ name: `C${i}` }));
    expect(validateCategorizePayload({ text: "hola", categories: cats }).ok).toBe(false);
  });
});

describe("fortress · validate learn", () => {
  it("category vacía → 400", () => {
    expect(validateLearnPayload({ kind: "category", merchant: "oxxo", category: "" }).ok).toBe(false);
    expect(validateLearnPayload({ kind: "category", merchant: "oxxo", category: "Comida" }).ok).toBe(true);
  });
  it("merchant muy largo → 400", () => {
    expect(validateLearnPayload({ merchant: "a".repeat(101), accountId: "x" }).ok).toBe(false);
  });
  it("account requiere accountId", () => {
    expect(validateLearnPayload({ merchant: "oxxo" }).ok).toBe(false);
  });
  it("transfer sin from/to → 400", () => {
    expect(validateLearnPayload({ kind: "transfer" }).ok).toBe(false);
  });
});

describe("fortress · retry", () => {
  it("reintenta en errores retryables", async () => {
    let calls = 0;
    const fn = async () => { calls++; if (calls < 3) throw new Error("429"); return "ok"; };
    const res = await retryWithBackoff(fn, { maxAttempts: 3, baseMs: 0, isRetryable: () => true });
    expect(res).toBe("ok");
    expect(calls).toBe(3);
  });
  it("no reintenta si no retryable", async () => {
    let calls = 0;
    const fn = async () => { calls++; throw new Error("400 bad"); };
    await expect(retryWithBackoff(fn, { maxAttempts: 3, baseMs: 0, isRetryable: () => false })).rejects.toThrow();
    expect(calls).toBe(1);
  });
  it("getRetryDelay crece con attempt", () => {
    const d0 = getRetryDelay(0, 1000, 30_000, 0);
    const d2 = getRetryDelay(2, 1000, 30_000, 0);
    expect(d2).toBeGreaterThan(d0);
  });
});

describe("fortress · idempotency", () => {
  it("mismo update_id 2 veces → dedup", () => {
    const store = makeUpdateIdStore({ max: 10 });
    expect(store.add("123")).toBe(true);
    expect(store.add("123")).toBe(false);
    expect(store.has("123")).toBe(true);
    expect(store._size()).toBe(1);
  });
  it("learn dedup key misma regla no duplica", () => {
    const k1 = learnDedupKey({ kind: "category", merchant: "Oxxo", category: "Comida" });
    const k2 = learnDedupKey({ kind: "category", merchant: "oxxo ", category: "Comida" });
    expect(k1).toBe(k2);
  });
  it("evicción FIFO al exceder max", () => {
    const store = makeUpdateIdStore({ max: 3 });
    store.add("1"); store.add("2"); store.add("3"); store.add("4");
    expect(store.has("1")).toBe(false);
    expect(store.has("4")).toBe(true);
  });
});

describe("fortress · auth", () => {
  it("learn sin token → 401", () => {
    const req = { headers: {}, socket: { remoteAddress: "8.8.8.8" } };
    const r = checkLearnAuth(req);
    expect(r.ok).toBe(false);
    expect(r.status).toBe(401);
  });
  it("telegram sin secret configurado → ok", () => {
    const req = { headers: {} };
    const r = checkTelegramSecret(req, null);
    expect(r.ok).toBe(true);
  });
  it("telegram secret mismatch → 401", () => {
    const req = { headers: { "x-telegram-bot-api-secret-token": "wrong" } };
    const r = checkTelegramSecret(req, "correct-secret");
    expect(r.ok).toBe(false);
  });
  it("telegram secret ok → pasa", () => {
    const req = { headers: { "x-telegram-bot-api-secret-token": "s" } };
    const r = checkTelegramSecret(req, "s");
    expect(r.ok).toBe(true);
  });
});
