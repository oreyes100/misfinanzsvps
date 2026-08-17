// retry-orchestrator.ts — Orquestador de retry completo (MCP-03).
//
// Integra todos los componentes del paraguas anti-storm:
//   1. Idempotency Manager  → deduplicación por Idempotency-Key
//   2. Storm Detector       → detección de amplificación + cooldown
//   3. Retry Budget         → límite de ejecuciones por cliente
//   4. Retry Engine         → backoff exponencial + jitter
//   5. Fallback             → cuando se agotan los retries
//
// Flujo:
//   Request → Idempotency check → Storm check → Budget check
//   → Retry Engine (backoff) → Success/Fallback

import { RetryEngine } from "./retry-engine.ts";
import { IdempotencyManager } from "./idempotency-manager.ts";
import { RetryBudgetManager, StormDetector } from "./retry-budget.ts";
import type { RetrySystemConfig, RetryResult, RetryEvent } from "./retry-types.ts";

export class RetryOrchestrator {
  private readonly config: RetrySystemConfig;
  private retryEngine: RetryEngine;
  private idempotency: IdempotencyManager;
  private budget: RetryBudgetManager;
  private stormDetector: StormDetector;
  private eventListeners: ((event: RetryEvent) => void)[] = [];

  constructor(config: RetrySystemConfig) {
    // Sin parameter property: Node native TS (strip-only) no lo soporta.
    this.config = config;
    this.retryEngine = new RetryEngine(config.retryPolicy, (event) => this.emitEvent(event));
    this.idempotency = new IdempotencyManager(config.idempotency, (event) => this.emitEvent(event));
    this.budget = new RetryBudgetManager(config.retryBudget, (event) => this.emitEvent(event));
    this.stormDetector = new StormDetector(config.stormDetection, (event) => this.emitEvent(event));
  }

  /**
   * ═══ CORE: Ejecutar un tool call con retry completo ═══
   */
  async executeWithFullResilience<T>(params: {
    toolName: string;
    clientId: string;
    args: unknown;
    idempotencyKey?: string;
    isCritical?: boolean;
    handler: (args: unknown) => Promise<T>;
    fallback?: () => Promise<T | null>;
  }): Promise<RetryResult> {
    const { toolName, clientId, args, idempotencyKey, isCritical, handler } = params;
    const fallback = this.resolveFallback<T>(params.fallback);
    const rejectedMeta = (reason: { code: string; message: string; condition: "never"; retryable: false }, stormDetected: boolean) => ({
      attempt: 0,
      maxAttempts: this.config.retryPolicy.maxAttempts,
      totalDelayMs: 0,
      backoffDelays: [],
      idempotencyHit: false,
      idempotencyKey,
      retryBudgetRemaining: 0,
      stormDetected,
      fallbackUsed: false,
    });

    // ─── PASO 0: Registrar request original ───────────────────
    this.stormDetector.recordOriginalRequest();

    // ─── PASO 1: Idempotency check ────────────────────────────
    const idemCheck = this.idempotency.check(idempotencyKey, toolName);
    if (idemCheck.hit) {
      return {
        success: true,
        data: idemCheck.cachedResult,
        _meta: {
          attempt: 0,
          maxAttempts: this.config.retryPolicy.maxAttempts,
          totalDelayMs: 0,
          backoffDelays: [],
          idempotencyHit: true,
          idempotencyKey,
          retryBudgetRemaining: this.config.retryBudget.maxRetriesPerWindow,
          stormDetected: false,
          fallbackUsed: false,
        },
      };
    }

    // ─── PASO 2: Storm check ──────────────────────────────────
    const stormStatus = this.stormDetector.getStatus();
    if (stormStatus.isStormActive) {
      if (this.config.stormDetection.degradeToFallback && fallback) {
        const fallbackResult = await fallback();
        if (fallbackResult !== null) {
          return {
            success: true,
            data: fallbackResult,
            _meta: {
              attempt: 0,
              maxAttempts: this.config.retryPolicy.maxAttempts,
              totalDelayMs: 0,
              backoffDelays: [],
              idempotencyHit: false,
              idempotencyKey,
              retryBudgetRemaining: 0,
              stormDetected: true,
              fallbackUsed: true,
            },
          };
        }
      }

      return {
        success: false,
        error: {
          code: "STORM_ACTIVE",
          message: `Retry storm detectado. Cooldown: ${Math.ceil(stormStatus.stormRemainingMs / 1000)}s`,
          condition: "never",
          retryable: false,
        },
        _meta: rejectedMeta(
          { code: "STORM_ACTIVE", message: "", condition: "never", retryable: false },
          true
        ),
      };
    }

    // ─── PASO 3: Retry Budget check ───────────────────────────
    const budgetCheck = this.budget.canRetry({ clientId, toolName, isCritical });
    if (!budgetCheck.allowed) {
      return {
        success: false,
        error: {
          code: "BUDGET_EXHAUSTED",
          message: budgetCheck.reason || "Retry budget agotado",
          condition: "never",
          retryable: false,
        },
        _meta: rejectedMeta(
          { code: "BUDGET_EXHAUSTED", message: budgetCheck.reason || "", condition: "never", retryable: false },
          false
        ),
      };
    }

    // ─── PASO 4: Ejecutar con Retry Engine ────────────────────
    const result = await this.retryEngine.executeWithRetry(
      () => handler(args),
      {
        toolName,
        idempotencyKey,
        onRetry: (attempt, delayMs, error) => {
          const stormCheck = this.stormDetector.recordRetry(toolName, clientId);
          if (stormCheck.isStorm) {
            console.warn(`[RetryOrchestrator] Storm detectado durante retry ${attempt} de ${toolName}`);
          }
        },
      }
    );

    // ─── PASO 5: Post-procesamiento ───────────────────────────
    if (result.success) {
      this.idempotency.store(idempotencyKey, toolName, result.data);
    } else if (result.error?.code === "RETRY_EXHAUSTED" && fallback) {
      const fallbackResult = await fallback();
      if (fallbackResult !== null) {
        return {
          ...result,
          success: true,
          data: fallbackResult,
          _meta: { ...result._meta, fallbackUsed: true },
        };
      }
    }

    return result;
  }

  /**
   * Resolver el fallback: el del llamador, o el default_value de configuración.
   */
  private resolveFallback<T>(explicit?: () => Promise<T | null>): (() => Promise<T | null>) | undefined {
    if (explicit) return explicit;
    if (this.config.exhaustedFallback.type === "default_value") {
      const value = (this.config.exhaustedFallback.defaultValue ?? null) as T | null;
      return async () => value;
    }
    return undefined;
  }

  /** Suscribir a eventos de retry. */
  onEvent(listener: (event: RetryEvent) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      this.eventListeners = this.eventListeners.filter((l) => l !== listener);
    };
  }

  private emitEvent(event: RetryEvent): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  /** Obtener estado completo del sistema de retry. */
  getFullStatus(): {
    retryEngine: { strategy: string; maxAttempts: number };
    idempotency: { totalKeys: number; maxKeys: number };
    storm: { isStormActive: boolean; concurrentRetries: number; amplification: number };
  } {
    const engineConfig = this.retryEngine.getConfig();
    const idemStats = this.idempotency.getStats();
    const stormStatus = this.stormDetector.getStatus();

    return {
      retryEngine: {
        strategy: engineConfig.backoffStrategy,
        maxAttempts: engineConfig.maxAttempts,
      },
      idempotency: {
        totalKeys: idemStats.totalKeys,
        maxKeys: idemStats.maxKeys,
      },
      storm: {
        isStormActive: stormStatus.isStormActive,
        concurrentRetries: stormStatus.concurrentRetries,
        amplification: stormStatus.amplificationFactor,
      },
    };
  }

  /** Reset completo del sistema. */
  resetAll(): void {
    this.budget.resetAll();
    this.stormDetector.reset();
    this.idempotency.clear();
  }

  /** Cleanup. */
  destroy(): void {
    this.idempotency.destroy();
  }
}