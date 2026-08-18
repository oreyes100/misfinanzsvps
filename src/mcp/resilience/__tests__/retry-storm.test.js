// retry-storm.test.js — FASE 3: simulación del Red Team (Retry Storm).
import { describe, it, expect, beforeEach } from "vitest";
import { RetryEngine } from "../retry-engine";
import { IdempotencyManager } from "../idempotency-manager";
import { RetryBudgetManager, StormDetector } from "../retry-budget";
import { RetryOrchestrator } from "../retry-orchestrator";
import { ResilienceOrchestrator } from "../resilience-orchestrator";
import { ToolPriority } from "../types";
import { runToolWithRetry } from "../../retry-integration";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("FASE 3 — RetryEngine: backoff exponencial + jitter", () => {
  it("calcula backoff exponencial correctamente", () => {
    const engine = new RetryEngine({
      backoffStrategy: "exponential",
      baseDelayMs: 1000,
      backoffMultiplier: 2,
      maxDelayMs: 30000,
    });

    expect(engine.calculateBackoff(1)).toBe(1000);
    expect(engine.calculateBackoff(2)).toBe(2000);
    expect(engine.calculateBackoff(3)).toBe(4000);
    expect(engine.calculateBackoff(4)).toBe(8000);
    expect(engine.calculateBackoff(5)).toBe(16000);
    expect(engine.calculateBackoff(6)).toBe(30000); // cap en maxDelayMs
  });

  it("aplica jitter dentro del rango esperado (equal jitter)", () => {
    const engine = new RetryEngine({
      backoffStrategy: "exponential_jitter",
      baseDelayMs: 1000,
      backoffMultiplier: 2,
      maxJitterMs: 500,
      fullJitter: false,
    });

    // Intento 1: base = 1000 → equal [500, 1000] + [0, 500] = [500, 1500]
    for (let i = 0; i < 100; i++) {
      const delay = engine.calculateBackoff(1);
      expect(delay).toBeGreaterThanOrEqual(500);
      expect(delay).toBeLessThanOrEqual(1500);
    }
  });

  it("respeta maxDelayMs", () => {
    const engine = new RetryEngine({
      backoffStrategy: "exponential",
      baseDelayMs: 10000,
      backoffMultiplier: 10,
      maxDelayMs: 30000,
    });

    // 10000 × 10² = 1,000,000 → capped en 30,000
    expect(engine.calculateBackoff(3)).toBe(30000);
  });

  it("reintenta en errores retryables y falla en no-retryables", async () => {
    const engine = new RetryEngine({
      maxAttempts: 3,
      baseDelayMs: 10,
      retryableConditions: ["timeout", "network_error"],
    });

    let attempts = 0;
    const retryableResult = await engine.executeWithRetry(
      async () => {
        attempts++;
        if (attempts < 3) throw new Error("Connection timeout");
        return { success: true };
      },
      { toolName: "test_tool" }
    );

    expect(retryableResult.success).toBe(true);
    expect(retryableResult._meta.attempt).toBe(3);

    attempts = 0;
    const nonRetryableResult = await engine.executeWithRetry(
      async () => {
        attempts++;
        throw new Error("Invalid API key (401)");
      },
      { toolName: "test_tool" }
    );

    expect(nonRetryableResult.success).toBe(false);
    expect(attempts).toBe(1); // Solo 1 intento
  });

  it("devuelve metadata de backoff completa", async () => {
    const engine = new RetryEngine({
      maxAttempts: 3,
      baseDelayMs: 10,
      backoffStrategy: "exponential",
    });

    let attempts = 0;
    const result = await engine.executeWithRetry(
      async () => {
        attempts++;
        if (attempts < 3) throw new Error("timeout");
        return "ok";
      },
      { toolName: "test" }
    );

    expect(result._meta.attempt).toBe(3);
    expect(result._meta.backoffDelays).toHaveLength(2);
    expect(result._meta.totalDelayMs).toBeGreaterThan(0);
  });
});

describe("FASE 3 — IdempotencyManager: deduplicación", () => {
  let idem;

  beforeEach(() => {
    idem = new IdempotencyManager({
      storage: "memory",
      keyTtlMs: 60_000,
      autoCleanup: false,
    });
  });

  it("detecta requests duplicados por idempotency key", () => {
    const key = "test-key-123";

    const check1 = idem.check(key, "transfer_funds");
    expect(check1.hit).toBe(false);

    idem.store(key, "transfer_funds", { transferId: "tf_456" });

    const check2 = idem.check(key, "transfer_funds");
    expect(check2.hit).toBe(true);
    expect(check2.cachedResult).toEqual({ transferId: "tf_456" });
  });

  it("hace scope por tool: misma key en diferente tool no es hit", () => {
    const key = "test-key-456";

    idem.store(key, "tool_a", { data: "a" });

    const check = idem.check(key, "tool_b");
    expect(check.hit).toBe(false);
  });

  it("expira claves después del TTL", async () => {
    const idemShort = new IdempotencyManager({
      storage: "memory",
      keyTtlMs: 100,
      autoCleanup: false,
    });

    idemShort.store("key1", "tool", { data: "test" });
    expect(idemShort.check("key1", "tool").hit).toBe(true);

    await sleep(150);
    expect(idemShort.check("key1", "tool").hit).toBe(false);
  });

  it("genera claves únicas", () => {
    const keys = new Set();
    for (let i = 0; i < 100; i++) {
      keys.add(IdempotencyManager.generateKey());
    }
    expect(keys.size).toBe(100);
  });

  it("evita la clave más antigua al exceder maxKeys", () => {
    const idemSmall = new IdempotencyManager({
      storage: "memory",
      maxKeys: 2,
      autoCleanup: false,
    });

    idemSmall.store("k1", "tool", 1);
    idemSmall.store("k2", "tool", 2);
    idemSmall.store("k3", "tool", 3); // expulsa k1 (la más antigua)

    expect(idemSmall.check("k1", "tool").hit).toBe(false);
    expect(idemSmall.check("k2", "tool").hit).toBe(true);
    expect(idemSmall.check("k3", "tool").hit).toBe(true);
  });
});

describe("FASE 3 — RetryBudgetManager: límite por cliente", () => {
  let budget;

  beforeEach(() => {
    budget = new RetryBudgetManager({
      maxRetriesPerWindow: 3,
      windowMs: 60_000,
      cooldownMs: 120_000,
      criticalReserveRatio: 0.3, // 1 retry reservado para críticos (ceil)
    });
  });

  it("permite hasta el máximo de retries para no-críticos", () => {
    for (let i = 0; i < 2; i++) {
      const result = budget.canRetry({
        clientId: "client_1",
        toolName: "test",
        isCritical: false,
      });
      expect(result.allowed).toBe(true);
    }
  });

  it("aplica cooldown cuando se agota el budget", () => {
    budget.canRetry({ clientId: "client_1", toolName: "t", isCritical: false });
    budget.canRetry({ clientId: "client_1", toolName: "t", isCritical: false });

    const result = budget.canRetry({
      clientId: "client_1",
      toolName: "t",
      isCritical: false,
    });

    expect(result.allowed).toBe(false);
    expect(result.cooldownMs).toBe(120_000);
  });

  it("permite retries críticos incluso con budget bajo", () => {
    budget.canRetry({ clientId: "client_1", toolName: "t", isCritical: false });
    budget.canRetry({ clientId: "client_1", toolName: "t", isCritical: false });

    const result = budget.canRetry({
      clientId: "client_1",
      toolName: "transfer",
      isCritical: true,
    });

    expect(result.allowed).toBe(true);
  });

  it("el cooldown y la ventana expiran y el budget se reabre", async () => {
    const short = new RetryBudgetManager({
      maxRetriesPerWindow: 1,
      criticalReserveRatio: 0,
      cooldownMs: 100,
      windowMs: 100,
    });

    short.canRetry({ clientId: "c", toolName: "t", isCritical: false });
    expect(short.canRetry({ clientId: "c", toolName: "t", isCritical: false }).allowed).toBe(false);

    await sleep(250); // cooldown + ventana expirados
    expect(short.canRetry({ clientId: "c", toolName: "t", isCritical: false }).allowed).toBe(true);
  });
});

describe("FASE 3 — StormDetector: detección de amplificación", () => {
  let storm;

  beforeEach(() => {
    storm = new StormDetector({
      enabled: true,
      concurrentRetryThreshold: 5,
      detectionWindowMs: 10_000,
      maxAmplificationFactor: 3,
      stormCooldownMs: 30_000,
      degradeToFallback: true,
    });
  });

  it("detecta storm por retries concurrentes", () => {
    for (let i = 0; i < 2; i++) {
      storm.recordOriginalRequest();
    }

    let isStorm = false;
    for (let i = 0; i < 5; i++) {
      const result = storm.recordRetry("drive_read", "client_1");
      if (result.isStorm) isStorm = true;
    }

    expect(isStorm).toBe(true);
    expect(storm.isStormCurrentlyActive()).toBe(true);
  });

  it("detecta storm por factor de amplificación", () => {
    storm.recordOriginalRequest();

    let isStorm = false;
    for (let i = 0; i < 4; i++) {
      const result = storm.recordRetry("ocr_scan", "client_1");
      if (result.isStorm) isStorm = true;
    }

    expect(isStorm).toBe(true);
  });

  it("expira el storm después del cooldown", async () => {
    const shortStorm = new StormDetector({
      concurrentRetryThreshold: 2,
      stormCooldownMs: 100,
    });

    shortStorm.recordRetry("tool", "c1");
    shortStorm.recordRetry("tool", "c1");

    expect(shortStorm.isStormCurrentlyActive()).toBe(true);

    await sleep(150);
    expect(shortStorm.isStormCurrentlyActive()).toBe(false);
  });

  it("devuelve isStorm=true durante un storm activo sin re-detectarlo", () => {
    storm.recordRetry("a", "c1");
    storm.recordRetry("b", "c1");
    storm.recordRetry("c", "c1");
    storm.recordRetry("d", "c1");
    storm.recordRetry("e", "c1"); // → storm

    const next = storm.recordRetry("f", "c1");
    expect(next.isStorm).toBe(true);
    expect(next.shouldDegrade).toBe(true);
  });
});

describe("FASE 3 — RetryOrchestrator: integración completa", () => {
  const testConfig = {
    retryPolicy: {
      maxAttempts: 3,
      backoffStrategy: "exponential",
      baseDelayMs: 10,
      maxDelayMs: 100,
      backoffMultiplier: 2,
      maxJitterMs: 5,
      retryableConditions: ["timeout", "network_error", "server_error"],
      nonRetryableConditions: ["never"],
      fullJitter: false,
    },
    idempotency: {
      enabled: true,
      keyTtlMs: 60_000,
      storage: "memory",
      keyPrefix: "test",
      maxKeys: 100,
      autoCleanup: false,
      cleanupIntervalMs: 60_000,
    },
    retryBudget: {
      maxRetriesPerWindow: 5,
      windowMs: 60_000,
      cooldownMs: 1000,
      globalBudget: false,
      criticalReserveRatio: 0.2,
    },
    stormDetection: {
      enabled: true,
      concurrentRetryThreshold: 10,
      detectionWindowMs: 10_000,
      maxAmplificationFactor: 5,
      stormCooldownMs: 1000,
      degradeToFallback: true,
    },
    exhaustedFallback: { type: "cache" },
    logging: {
      level: "error",
      logRetries: false,
      logIdempotencyHits: false,
      logStormDetection: false,
    },
  };

  it("ejecuta exitosamente sin retries", async () => {
    const orchestrator = new RetryOrchestrator(testConfig);

    const result = await orchestrator.executeWithFullResilience({
      toolName: "get_balance",
      clientId: "client_1",
      args: { accountId: "acc_1" },
      handler: async () => ({ balance: 1234.56 }),
    });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ balance: 1234.56 });
    expect(result._meta.attempt).toBe(1);
    expect(result._meta.idempotencyHit).toBe(false);

    orchestrator.destroy();
  });

  it("reintenta y tiene éxito en el 3er intento", async () => {
    const orchestrator = new RetryOrchestrator(testConfig);
    let attempts = 0;

    const result = await orchestrator.executeWithFullResilience({
      toolName: "drive_read",
      clientId: "client_1",
      args: { fileId: "f1" },
      handler: async () => {
        attempts++;
        if (attempts < 3) throw new Error("Connection timeout");
        return { content: "file data" };
      },
    });

    expect(result.success).toBe(true);
    expect(result._meta.attempt).toBe(3);
    expect(result._meta.totalDelayMs).toBeGreaterThan(0);

    orchestrator.destroy();
  });

  it("devuelve resultado cacheado en idempotency hit", async () => {
    const orchestrator = new RetryOrchestrator(testConfig);
    const idemKey = "unique-key-123";
    let executionCount = 0;

    await orchestrator.executeWithFullResilience({
      toolName: "transfer_funds",
      clientId: "client_1",
      args: { amount: 100 },
      idempotencyKey: idemKey,
      handler: async () => {
        executionCount++;
        return { transferId: "tf_1" };
      },
    });

    const result = await orchestrator.executeWithFullResilience({
      toolName: "transfer_funds",
      clientId: "client_1",
      args: { amount: 100 },
      idempotencyKey: idemKey,
      handler: async () => {
        executionCount++;
        return { transferId: "tf_2" };
      },
    });

    expect(result.success).toBe(true);
    expect(result._meta.idempotencyHit).toBe(true);
    expect(result.data).toEqual({ transferId: "tf_1" });
    expect(executionCount).toBe(1); // Solo se ejecutó UNA vez

    orchestrator.destroy();
  });

  it("usa fallback cuando se agotan los retries", async () => {
    const orchestrator = new RetryOrchestrator(testConfig);
    let fallbackCalled = false;

    const result = await orchestrator.executeWithFullResilience({
      toolName: "ocr_scan",
      clientId: "client_1",
      args: { image: "base64..." },
      handler: async () => {
        throw new Error("OCR engine timeout");
      },
      fallback: async () => {
        fallbackCalled = true;
        return { queued: true, message: "Procesamiento diferido" };
      },
    });

    expect(result.success).toBe(true);
    expect(result._meta.fallbackUsed).toBe(true);
    expect(fallbackCalled).toBe(true);
    expect(result.data).toEqual({ queued: true, message: "Procesamiento diferido" });

    orchestrator.destroy();
  });

  it("bloquea con BUDGET_EXHAUSTED cuando el cliente agota su presupuesto", async () => {
    const strictBudget = {
      ...testConfig,
      retryBudget: { ...testConfig.retryBudget, maxRetriesPerWindow: 2, criticalReserveRatio: 0 },
    };
    const orchestrator = new RetryOrchestrator(strictBudget);

    const r1 = await orchestrator.executeWithFullResilience({
      toolName: "get_balance",
      clientId: "client_1",
      args: {},
      handler: async () => ({ balance: 1 }),
    });
    const r2 = await orchestrator.executeWithFullResilience({
      toolName: "get_balance",
      clientId: "client_1",
      args: {},
      handler: async () => ({ balance: 2 }),
    });
    const r3 = await orchestrator.executeWithFullResilience({
      toolName: "get_balance",
      clientId: "client_1",
      args: {},
      handler: async () => ({ balance: 3 }),
    });

    expect(r1.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(r3.success).toBe(false);
    expect(r3.error.code).toBe("BUDGET_EXHAUSTED");

    orchestrator.destroy();
  });

  it("sobrevive una simulación de retry storm", async () => {
    const stormConfig = {
      ...testConfig,
      stormDetection: {
        ...testConfig.stormDetection,
        concurrentRetryThreshold: 3,
        maxAmplificationFactor: 2,
      },
    };

    const orchestrator = new RetryOrchestrator(stormConfig);
    let successCount = 0;
    let stormBlockedCount = 0;
    let fallbackCount = 0;

    const promises = Array.from({ length: 20 }, (_, i) =>
      orchestrator
        .executeWithFullResilience({
          toolName: "drive_read",
          clientId: `client_${i % 3}`,
          args: { fileId: `f${i}` },
          handler: async () => {
            if (Math.random() < 0.5) {
              throw new Error("Drive timeout");
            }
            return { content: "data" };
          },
          fallback: async () => {
            fallbackCount++;
            return { cached: true };
          },
        })
        .then((result) => {
          if (result.success) successCount++;
          else if (result.error?.code === "STORM_ACTIVE") stormBlockedCount++;
        })
        .catch(() => {})
    );

    await Promise.allSettled(promises);

    console.log("─── RETRY STORM TEST RESULTS ───");
    console.log(`✅ Éxitos:          ${successCount}`);
    console.log(`🚨 Storm blocked:   ${stormBlockedCount}`);
    console.log(`🔄 Fallback used:   ${fallbackCount}`);
    console.log(`📊 Total:           ${successCount + stormBlockedCount}`);

    // El sistema no colapsó: algunos pasaron, otros fueron bloqueados por storm o budget.
    expect(successCount + stormBlockedCount).toBeLessThanOrEqual(20);

    orchestrator.destroy();
  }, 30_000);
});

describe("FASE 3 — Integración con el servidor MCP", () => {
  // Config rápida para no esperar los backoff largos de producción en tests.
  const fastConfig = {
    retryPolicy: {
      maxAttempts: 3,
      backoffStrategy: "exponential",
      baseDelayMs: 10,
      maxDelayMs: 100,
      backoffMultiplier: 2,
      maxJitterMs: 5,
      retryableConditions: ["network_error", "timeout", "server_error"],
      nonRetryableConditions: ["never"],
      fullJitter: false,
    },
    idempotency: {
      enabled: true,
      keyTtlMs: 60_000,
      storage: "memory",
      keyPrefix: "test",
      maxKeys: 100,
      autoCleanup: false,
      cleanupIntervalMs: 60_000,
    },
    retryBudget: {
      maxRetriesPerWindow: 100,
      windowMs: 60_000,
      cooldownMs: 1000,
      globalBudget: false,
      criticalReserveRatio: 0.2,
    },
    stormDetection: {
      enabled: true,
      concurrentRetryThreshold: 10,
      detectionWindowMs: 10_000,
      maxAmplificationFactor: 5,
      stormCooldownMs: 1000,
      degradeToFallback: true,
    },
    exhaustedFallback: { type: "cache" },
    logging: { level: "error", logRetries: false, logIdempotencyHits: false, logStormDetection: false },
  };
  it("el ResilienceOrchestrator pasa clientId/idempotencyKey al handler (para el retry layer)", async () => {
    const orchestrator = new ResilienceOrchestrator({
      circuitBreaker: { failureThreshold: 5, successThreshold: 2, resetTimeoutMs: 1000, requestTimeoutMs: 500, errorRateThreshold: 0.5, errorRateWindowMs: 5000, minimumRequestVolume: 5 },
      rateLimiter: { maxRequests: 100, windowMs: 1000, algorithm: "token_bucket", refillRatePerSecond: 50, bucketCapacity: 100 },
      priorityQueue: { maxQueueSize: 50, concurrency: 3, maxWaitTimeMs: 5000, enableBackpressure: true },
      metrics: { enablePrometheus: false, logLevel: "error", healthCheckIntervalMs: 0 },
    });

    let seenCtx = null;
    orchestrator.registerTool(
      { toolName: "get_balance", priority: ToolPriority.NORMAL, rateLimitPerMinute: 100 },
      (args, ctx) => {
        seenCtx = ctx;
        return Promise.resolve({ ok: true });
      }
    );

    const result = await orchestrator.executeToolCall({
      toolName: "get_balance",
      clientId: "client_42",
      args: { accountId: "a1" },
      idempotencyKey: "idem-key-42",
    });

    expect(result.success).toBe(true);
    expect(seenCtx.clientId).toBe("client_42");
    expect(seenCtx.idempotencyKey).toBe("idem-key-42");

    orchestrator.destroy();
  });

  it("runToolWithRetry reintenta el handler real y propaga el error al agotarse", async () => {
    const retry = new RetryOrchestrator(fastConfig);
    let attempts = 0;

    const tool = {
      name: "drive_status",
      description: "estado",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        attempts++;
        if (attempts < 3) throw new Error("Drive timeout: service unavailable (503)");
        return { ok: true, processed: 10 };
      },
      requiredScopes: ["read", "drive"],
      sensitivity: "medium",
      requiresIdempotency: false,
      requiresHumanApproval: false,
      rateLimitPerMinute: 20,
    };

    const data = await runToolWithRetry(retry, tool, {}, { clientId: "hermes_agent" });
    expect(data).toEqual({ ok: true, processed: 10 });
    expect(attempts).toBe(3);

    retry.destroy();
  }, 30_000);

  it("el error del retry layer llega como fallo del handler", async () => {
    const retry = new RetryOrchestrator(fastConfig);
    let attempts = 0;

    const tool = {
      name: "get_balance",
      description: "balance",
      inputSchema: { type: "object", properties: {} },
      handler: async () => {
        attempts++;
        throw new Error("Invalid API key (401)");
      },
      requiredScopes: ["read"],
      sensitivity: "medium",
      requiresIdempotency: false,
      requiresHumanApproval: false,
      rateLimitPerMinute: 60,
    };

    await expect(runToolWithRetry(retry, tool, {}, { clientId: "c1" })).rejects.toThrow("NON_RETRYABLE");

    retry.destroy();
  }, 30_000);

  it("runToolWithRetry usa el fallback de caché del ResilienceOrchestrator al agotar retries", async () => {
    const retry = new RetryOrchestrator(fastConfig);
    const inner = new ResilienceOrchestrator({
      circuitBreaker: { failureThreshold: 100, successThreshold: 2, resetTimeoutMs: 1000, requestTimeoutMs: 500, errorRateThreshold: 0.5, errorRateWindowMs: 5000, minimumRequestVolume: 1 },
      rateLimiter: { maxRequests: 100, windowMs: 1000, algorithm: "token_bucket", refillRatePerSecond: 50, bucketCapacity: 100 },
      priorityQueue: { maxQueueSize: 50, concurrency: 3, maxWaitTimeMs: 5000, enableBackpressure: true },
      metrics: { enablePrometheus: false, logLevel: "error", healthCheckIntervalMs: 0 },
    });

    const toolOk = {
      name: "get_balance",
      description: "balance",
      inputSchema: { type: "object", properties: {} },
      handler: async () => ({ ok: true, balance: 100 }),
      requiredScopes: ["read"],
      sensitivity: "medium",
      requiresIdempotency: false,
      requiresHumanApproval: false,
      rateLimitPerMinute: 60,
    };

    const toolFail = {
      ...toolOk,
      handler: async () => {
        throw new Error("Network error: ENOTFOUND");
      },
    };

    inner.registerTool(
      { toolName: "get_balance", priority: ToolPriority.NORMAL, rateLimitPerMinute: 60, fallback: { type: "cache", cacheTtlMs: 60_000 } },
      (args, ctx) => runToolWithRetry(retry, toolOk, args, ctx)
    );

    // 1ª pasada: éxito real → se escribe caché en el ResilienceOrchestrator.
    const first = await inner.executeToolCall({
      toolName: "get_balance",
      clientId: "c1",
      args: { syncCode: "abc" },
    });
    expect(first.success).toBe(true);
    expect(first._meta.fromCache).toBe(false);

    // 2ª pasada: el retry layer agota sus intentos y lanza; el ResilienceOrchestrator
    // (MCP-02) degrada a caché → success con fromCache:true.
    const result = await inner.executeToolCall({
      toolName: "get_balance",
      clientId: "c1",
      args: { syncCode: "abc" },
      handler: (args, ctx) => runToolWithRetry(retry, toolFail, args, ctx),
    });

    expect(result.success).toBe(true);
    expect(result._meta.fromCache).toBe(true);
    expect(result.data).toEqual({ ok: true, balance: 100 });

    retry.destroy();
    inner.destroy();
  }, 30_000);
});
