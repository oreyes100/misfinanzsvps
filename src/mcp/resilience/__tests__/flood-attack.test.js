// flood-attack.test.js — FASE 2: simulación de ataques de carga (Red Team).
import { describe, it, expect } from "vitest";
import { CircuitBreaker } from "../circuit-breaker";
import { RateLimiter } from "../rate-limiter";
import { PriorityQueue } from "../priority-queue";
import { ResilienceOrchestrator } from "../resilience-orchestrator";
import { CircuitState, ToolPriority } from "../types";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("FASE 2 — Circuit Breaker bajo carga", () => {
  it("abre el circuito después de 5 fallos consecutivos", () => {
    const cb = new CircuitBreaker("drive_read", { failureThreshold: 5 });
    for (let i = 0; i < 5; i++) cb.recordFailure();
    expect(cb.getStatus().state).toBe(CircuitState.OPEN);
  });

  it("rechaza requests con retryAfterMs cuando está OPEN", () => {
    const cb = new CircuitBreaker("drive_read", { failureThreshold: 2, resetTimeoutMs: 60_000 });
    cb.recordFailure();
    cb.recordFailure();
    const check = cb.canExecute();
    expect(check.allowed).toBe(false);
    expect(check.retryAfterMs).toBeGreaterThan(0);
  });

  it("transiciona a HALF_OPEN después del timeout", async () => {
    const cb = new CircuitBreaker("drive_read", { failureThreshold: 1, resetTimeoutMs: 100 });
    cb.recordFailure();
    await sleep(150);
    expect(cb.canExecute().allowed).toBe(true);
    expect(cb.getStatus().state).toBe(CircuitState.HALF_OPEN);
  });

  it("cierra el circuito tras éxitos en HALF_OPEN", async () => {
    const cb = new CircuitBreaker("drive_read", { failureThreshold: 1, successThreshold: 2, resetTimeoutMs: 50 });
    cb.recordFailure();
    await sleep(60);
    cb.canExecute(); // → HALF_OPEN
    cb.recordSuccess(100);
    cb.recordSuccess(100);
    expect(cb.getStatus().state).toBe(CircuitState.CLOSED);
  });

  it("abre por error rate alto aunque no haya fallos consecutivos", () => {
    const cb = new CircuitBreaker("drive_read", {
      failureThreshold: 100,
      errorRateThreshold: 0.5,
      errorRateWindowMs: 60_000,
      minimumRequestVolume: 10,
    });
    for (let i = 0; i < 5; i++) {
      cb.recordSuccess(50);
      cb.recordFailure();
    }
    expect(cb.getStatus().state).toBe(CircuitState.OPEN);
  });
});

describe("FASE 2 — Rate Limiter bajo flood", () => {
  it("permite hasta maxRequests y luego rechaza (sliding)", () => {
    const rl = new RateLimiter("ocr_scan", { maxRequests: 5, windowMs: 60_000, algorithm: "sliding" });
    for (let i = 0; i < 5; i++) expect(rl.canProceed("client_1").allowed).toBe(true);
    const r = rl.canProceed("client_1");
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBeGreaterThan(0);
  });

  it("permite bursts con token bucket y luego rechaza", () => {
    const rl = new RateLimiter("get_balance", { maxRequests: 10, algorithm: "token_bucket", bucketCapacity: 10, refillRatePerSecond: 1 });
    for (let i = 0; i < 10; i++) expect(rl.canProceed("client_1").allowed).toBe(true);
    expect(rl.canProceed("client_1").allowed).toBe(false);
  });

  it("recarga tokens con el tiempo", async () => {
    const rl = new RateLimiter("get_balance", { maxRequests: 5, algorithm: "token_bucket", bucketCapacity: 5, refillRatePerSecond: 10 });
    for (let i = 0; i < 5; i++) rl.canProceed("client_1");
    expect(rl.canProceed("client_1").allowed).toBe(false);
    await sleep(200); // ~2 tokens recargados
    expect(rl.canProceed("client_1").allowed).toBe(true);
  });

  it("limita por cliente de forma independiente", () => {
    const rl = new RateLimiter("ocr_scan", { maxRequests: 2, algorithm: "sliding", windowMs: 60_000 });
    rl.canProceed("client_1");
    rl.canProceed("client_1");
    expect(rl.canProceed("client_1").allowed).toBe(false);
    expect(rl.canProceed("client_2").allowed).toBe(true);
    expect(rl.canProceed("client_2").allowed).toBe(true);
  });
});

describe("FASE 2 — Priority Queue bajo flood", () => {
  it("procesa CRITICAL antes que BACKGROUND/NORMAL", async () => {
    const pq = new PriorityQueue({ maxQueueSize: 10, concurrency: 1 });
    const order = [];
    pq.setProcessor(async (item) => {
      await sleep(30);
      order.push(item.toolName);
      return item.toolName;
    });

    // Ocupar el único worker con un item inicial: los siguientes se encolan
    // mientras está ocupado y quedan ordenados por prioridad.
    const first = pq.enqueue({ id: "x", toolName: "filler", priority: ToolPriority.NORMAL, args: {}, clientId: "c1" });
    const jobs = [
      pq.enqueue({ id: "a", toolName: "background", priority: ToolPriority.BACKGROUND, args: {}, clientId: "c1" }),
      pq.enqueue({ id: "b", toolName: "normal", priority: ToolPriority.NORMAL, args: {}, clientId: "c1" }),
      pq.enqueue({ id: "c", toolName: "critical", priority: ToolPriority.CRITICAL, args: {}, clientId: "c1" }),
      pq.enqueue({ id: "d", toolName: "high", priority: ToolPriority.HIGH, args: {}, clientId: "c1" }),
    ];
    await Promise.allSettled([first, ...jobs]);

    const tail = order.filter((t) => t !== "filler");
    expect(tail).toEqual(["critical", "high", "normal", "background"]);
  });

  it("aplica backpressure cuando la cola está llena", async () => {
    const pq = new PriorityQueue({ maxQueueSize: 2, concurrency: 1, enableBackpressure: true });
    pq.setProcessor(async () => {
      await sleep(50);
      return { ok: true };
    });

    const p1 = pq.enqueue({ id: "1", toolName: "t1", priority: ToolPriority.NORMAL, args: {}, clientId: "c1" });
    const p2 = pq.enqueue({ id: "2", toolName: "t2", priority: ToolPriority.NORMAL, args: {}, clientId: "c1" });
    const p3 = pq.enqueue({ id: "3", toolName: "t3", priority: ToolPriority.NORMAL, args: {}, clientId: "c1" });

    await expect(
      pq.enqueue({ id: "4", toolName: "t4", priority: ToolPriority.NORMAL, args: {}, clientId: "c1" })
    ).rejects.toThrow("Cola llena");

    await Promise.allSettled([p1, p2, p3]);
  });
});

describe("FASE 2 — Orquestador completo", () => {
  it("sobrevive a un flood de 1000 requests sin colapsar", async () => {
    const orchestrator = new ResilienceOrchestrator({
      circuitBreaker: { failureThreshold: 5, successThreshold: 2, resetTimeoutMs: 1000, requestTimeoutMs: 500, errorRateThreshold: 0.5, errorRateWindowMs: 5000, minimumRequestVolume: 5 },
      rateLimiter: { maxRequests: 100, windowMs: 1000, algorithm: "token_bucket", refillRatePerSecond: 50, bucketCapacity: 100 },
      priorityQueue: { maxQueueSize: 50, concurrency: 3, maxWaitTimeMs: 5000, enableBackpressure: true },
      metrics: { enablePrometheus: false, logLevel: "error", healthCheckIntervalMs: 0 },
    });

    orchestrator.registerTool({ toolName: "flood_target", priority: ToolPriority.NORMAL, rateLimitPerMinute: 100 });

    const counts = { success: 0, rateLimited: 0, circuitOpen: 0, backpressure: 0, other: 0 };

    const promises = Array.from({ length: 1000 }, (_, i) =>
      orchestrator
        .executeToolCall({
          toolName: "flood_target",
          clientId: `client_${i % 10}`,
          args: { requestId: i },
          handler: async () => ({ success: true }),
        })
        .then((r) => {
          if (r.success) counts.success++;
          else if (r.error?.code === "RATE_LIMITED") counts.rateLimited++;
          else if (r.error?.code === "CIRCUIT_OPEN") counts.circuitOpen++;
          else if (r.error?.code === "BACKPRESSURE") counts.backpressure++;
          else counts.other++;
        })
        .catch(() => counts.other++)
    );

    await Promise.allSettled(promises);

    const total = counts.success + counts.rateLimited + counts.circuitOpen + counts.backpressure + counts.other;
    expect(counts.success).toBeGreaterThan(0);
    expect(total).toBe(1000);
    expect(counts.other).toBe(0); // nada colapsa: todo se degrada con código explícito

    orchestrator.destroy();
  }, 30_000);

  it("sirve fallback de caché cuando el circuito está abierto", async () => {
    const orchestrator = new ResilienceOrchestrator({
      circuitBreaker: { failureThreshold: 1, successThreshold: 2, resetTimeoutMs: 60_000, requestTimeoutMs: 500, errorRateThreshold: 0.5, errorRateWindowMs: 60_000, minimumRequestVolume: 1 },
      rateLimiter: { maxRequests: 100, windowMs: 60_000, algorithm: "token_bucket", refillRatePerSecond: 10, bucketCapacity: 100 },
      priorityQueue: { maxQueueSize: 10, concurrency: 2, maxWaitTimeMs: 5000, enableBackpressure: true },
      metrics: { enablePrometheus: false, logLevel: "error", healthCheckIntervalMs: 0 },
    });

    orchestrator.registerTool({
      toolName: "get_balance",
      priority: ToolPriority.NORMAL,
      rateLimitPerMinute: 100,
      fallback: { type: "cache", cacheTtlMs: 60_000 },
    });

    // 1º éxito → se escribe en caché
    const ok = await orchestrator.executeToolCall({
      toolName: "get_balance",
      clientId: "c1",
      args: { syncCode: "abc" },
      handler: async () => ({ balance: 100 }),
    });
    expect(ok.success).toBe(true);

    // Fallo → circuito abre
    await orchestrator.executeToolCall({
      toolName: "get_balance",
      clientId: "c1",
      args: { syncCode: "abc" },
      handler: async () => {
        throw new Error("boom");
      },
    });

    // Siguiente llamada → CIRCUIT_OPEN + fallback de caché
    const r = await orchestrator.executeToolCall({
      toolName: "get_balance",
      clientId: "c1",
      args: { syncCode: "abc" },
      handler: async () => {
        throw new Error("boom");
      },
    });
    expect(r.success).toBe(true);
    expect(r._meta.fromCache).toBe(true);
    expect(r._meta.circuitState).toBe(CircuitState.OPEN);
    expect(r.data).toEqual({ balance: 100 });

    orchestrator.destroy();
  });
});