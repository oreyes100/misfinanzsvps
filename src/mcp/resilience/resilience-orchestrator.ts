// resilience-orchestrator.ts — Integra Circuit Breaker + Rate Limiter + Priority
// Queue en un único punto de entrada para tool calls.
//
// Flujo:
//   1. Rate Limit check        → 429 (retryAfterMs)
//   2. Circuit Breaker check   → 503 (o fallback si está configurado)
//   3. Priority Queue          → encolar según prioridad (con backpressure)
//   4. Ejecutar handler con timeout
//   5. Registrar éxito/fallo en el Circuit Breaker (+ caché si aplica)
//   6. Fallback en caso de fallo

import { CircuitBreaker } from "./circuit-breaker.ts";
import { RateLimiter } from "./rate-limiter.ts";
import { PriorityQueue, BackpressureError, QueueTimeoutError, type QueueItem } from "./priority-queue.ts";
import {
  CircuitState,
  ToolPriority,
  type ResilienceConfig,
  type ResilientToolCallResult,
  type ResilienceEvent,
  type ToolPriority as ToolPriorityType,
  type ToolResilienceConfig,
  type ToolHealthStatus,
  type FallbackConfig,
} from "./types.ts";

interface CachedValue {
  value: unknown;
  expiresAt: number;
}

/** Contexto de ejecución que el orquestador pasa al handler (MCP-03). */
export interface HandlerContext {
  clientId?: string;
  idempotencyKey?: string;
}

export class ResilienceOrchestrator {
  private config: ResilienceConfig;
  private circuitBreakers = new Map<string, CircuitBreaker>();
  private rateLimiters = new Map<string, RateLimiter>();
  private toolConfigs = new Map<string, ToolResilienceConfig>();
  private handlers = new Map<string, (args: unknown, ctx?: HandlerContext) => Promise<unknown>>();
  private cache = new Map<string, CachedValue>();
  private latencyLog = new Map<string, number[]>();
  private eventListeners: ((event: ResilienceEvent) => void)[] = [];
  private priorityQueue: PriorityQueue;
  private healthCheckTimer?: ReturnType<typeof setInterval>;

  constructor(config: ResilienceConfig) {
    this.config = config;
    this.priorityQueue = new PriorityQueue(config.priorityQueue, (event) => this.emitEvent(event));

    // Procesador único que despacha por toolName (sin race de setProcessor).
    this.priorityQueue.setProcessor(async (item: QueueItem) => {
      const handler = this.handlers.get(item.toolName);
      if (!handler) throw new Error(`Sin handler registrado para '${item.toolName}'`);
      return this.executeWithTimeout(
        () => handler(item.args, { clientId: item.clientId, idempotencyKey: item.idempotencyKey }),
        item.toolName,
        this.timeoutFor(item.toolName)
      );
    });

    if (config.metrics.healthCheckIntervalMs > 0) {
      this.healthCheckTimer = setInterval(() => this.runHealthCheck(), config.metrics.healthCheckIntervalMs);
    }
  }

  /**
   * Registrar una herramienta con su configuración de resiliencia y (opcional) handler.
   */
  registerTool(
    toolConfig: ToolResilienceConfig,
    handler?: (args: unknown, ctx?: HandlerContext) => Promise<unknown>
  ): void {
    this.toolConfigs.set(toolConfig.toolName, toolConfig);
    if (handler) this.handlers.set(toolConfig.toolName, handler);

    this.circuitBreakers.set(
      toolConfig.toolName,
      new CircuitBreaker(
        toolConfig.toolName,
        { ...this.config.circuitBreaker, ...toolConfig.circuitBreaker },
        (event) => this.emitEvent(event)
      )
    );

    this.rateLimiters.set(
      toolConfig.toolName,
      new RateLimiter(
        toolConfig.toolName,
        { ...this.config.rateLimiter, maxRequests: toolConfig.rateLimitPerMinute },
        (event) => this.emitEvent(event)
      )
    );

    console.log(
      `[Resilience] Registrado: ${toolConfig.toolName} ` +
      `(prioridad: ${toolConfig.priority}, rate: ${toolConfig.rateLimitPerMinute}/min)`
    );
  }

  /**
   * ═══ CORE: Ejecutar un tool call con resiliencia completa ═══
   */
  async executeToolCall(params: {
    toolName: string;
    clientId: string;
    args: unknown;
    idempotencyKey?: string;
    handler?: (args: unknown, ctx?: HandlerContext) => Promise<unknown>;
  }): Promise<ResilientToolCallResult> {
    const { toolName, clientId, args, handler, idempotencyKey } = params;
    const startTime = Date.now();
    const toolConfig = this.toolConfigs.get(toolName);
    const priority = toolConfig?.priority ?? ToolPriority.NORMAL;

    if (handler) this.handlers.set(toolName, handler);

    // ─── PASO 1: Rate Limiting ────────────────────────────────
    const rateLimiter = this.rateLimiters.get(toolName);
    if (rateLimiter) {
      const rateCheck = rateLimiter.canProceed(clientId);
      if (!rateCheck.allowed) {
        return {
          success: false,
          error: {
            code: "RATE_LIMITED",
            message: `Rate limit exceeded for '${toolName}'. Remaining: ${rateCheck.remaining}`,
            retryable: true,
            retryAfterMs: rateCheck.retryAfterMs,
          },
          _meta: {
            circuitState: this.circuitStateFor(toolName),
            latencyMs: Date.now() - startTime,
            attempt: 0,
            fromCache: false,
            queuedTimeMs: 0,
            priority,
          },
        };
      }
    }

    // ─── PASO 2: Circuit Breaker ──────────────────────────────
    const circuitBreaker = this.circuitBreakers.get(toolName);
    if (circuitBreaker) {
      const cbCheck = circuitBreaker.canExecute();
      if (!cbCheck.allowed) {
        const fallback = await this.tryFallback(toolName, args);
        if (fallback) {
          return this.successResult(toolName, startTime, priority, 0, fallback, CircuitState.OPEN, true);
        }
        return {
          success: false,
          error: {
            code: "CIRCUIT_OPEN",
            message: cbCheck.reason || `Circuit breaker OPEN for '${toolName}'`,
            retryable: true,
            retryAfterMs: cbCheck.retryAfterMs,
          },
          _meta: {
            circuitState: CircuitState.OPEN,
            latencyMs: Date.now() - startTime,
            attempt: 0,
            fromCache: false,
            queuedTimeMs: 0,
            priority,
          },
        };
      }
    }

    // ─── PASO 3: Priority Queue + Ejecución ───────────────────
    const queuedAt = Date.now();

    try {
      let result: unknown;
      if (toolConfig?.bypassQueue) {
        const directHandler =
          this.handlers.get(toolName) || (() => Promise.reject(new Error(`Sin handler para '${toolName}'`)));
        result = await this.executeWithTimeout(
          () => directHandler(args, { clientId, idempotencyKey }),
          toolName,
          this.timeoutFor(toolName)
        );
      } else {
        result = await this.priorityQueue.enqueue({
          id: `${toolName}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          toolName,
          priority,
          args,
          clientId,
          idempotencyKey,
        });
      }

      const queuedTimeMs = Date.now() - queuedAt;
      circuitBreaker?.recordSuccess(Date.now() - startTime);
      this.trackLatency(toolName, Date.now() - startTime);
      this.writeCache(toolName, args, result);

      return this.successResult(toolName, startTime, priority, queuedTimeMs, result, this.circuitStateFor(toolName), false);
    } catch (error) {
      circuitBreaker?.recordFailure();
      this.trackLatency(toolName, Date.now() - startTime);

      const fallback = await this.tryFallback(toolName, args);
      if (fallback) {
        return this.successResult(toolName, startTime, priority, Date.now() - queuedAt, fallback, this.circuitStateFor(toolName), true);
      }

      const isRetryable =
        error instanceof BackpressureError ||
        error instanceof QueueTimeoutError ||
        String((error as Error).message || "").includes("timeout");

      return {
        success: false,
        error: {
          code: this.classifyError(error),
          message: (error as Error).message,
          retryable: isRetryable,
          retryAfterMs: error instanceof BackpressureError ? error.retryAfterMs : undefined,
        },
        _meta: {
          circuitState: this.circuitStateFor(toolName),
          latencyMs: Date.now() - startTime,
          attempt: 1,
          fromCache: false,
          queuedTimeMs: Date.now() - queuedAt,
          priority,
        },
      };
    }
  }

  private successResult(
    toolName: string,
    startTime: number,
    priority: ToolPriorityType,
    queuedTimeMs: number,
    data: unknown,
    circuitState: CircuitState,
    fromCache: boolean
  ): ResilientToolCallResult {
    return {
      success: true,
      data,
      _meta: {
        circuitState,
        latencyMs: Date.now() - startTime,
        attempt: 1,
        fromCache,
        queuedTimeMs,
        priority,
      },
    };
  }

  private executeWithTimeout(
    fn: () => Promise<unknown>,
    toolName: string,
    timeoutMs: number
  ): Promise<unknown> {
    return Promise.race([
      fn(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Tool execution timeout after ${timeoutMs}ms`)), timeoutMs)
      ),
    ]);
  }

  private timeoutFor(toolName: string): number {
    return (
      this.toolConfigs.get(toolName)?.circuitBreaker?.requestTimeoutMs ??
      this.config.circuitBreaker.requestTimeoutMs
    );
  }

  // ─── Fallback / caché ───────────────────────────────────────

  private async tryFallback(toolName: string, args: unknown): Promise<unknown | null> {
    const fallback: FallbackConfig | undefined = this.toolConfigs.get(toolName)?.fallback ?? this.config.fallback;
    if (!fallback) return null;

    this.emitEvent({ type: "fallback_activated", tool: toolName, fallbackType: fallback.type });

    switch (fallback.type) {
      case "cache":
        return this.getFromCache(toolName, args);
      case "default_value":
        return fallback.defaultValue ?? null;
      case "queue_for_later":
        console.log(`[Fallback] '${toolName}' encolado para después`);
        return { queued: true, message: "Procesamiento diferido" };
      case "reject":
      default:
        return null;
    }
  }

  private cacheKey(toolName: string, args: unknown): string {
    return `${toolName}:${JSON.stringify(args ?? {})}`;
  }

  private writeCache(toolName: string, args: unknown, value: unknown): void {
    const fallback = this.toolConfigs.get(toolName)?.fallback ?? this.config.fallback;
    if (fallback?.type !== "cache") return;
    const ttl = fallback.cacheTtlMs ?? 60_000;
    this.cache.set(this.cacheKey(toolName, args), { value, expiresAt: Date.now() + ttl });
    // Limpieza perezosa: evitar que la caché crezca sin límite.
    if (this.cache.size > 500) {
      const now = Date.now();
      for (const [key, entry] of this.cache) {
        if (entry.expiresAt < now) this.cache.delete(key);
      }
    }
  }

  private getFromCache(toolName: string, args: unknown): unknown | null {
    const entry = this.cache.get(this.cacheKey(toolName, args));
    if (!entry || entry.expiresAt < Date.now()) return null;
    return entry.value;
  }

  // ─── Métricas ───────────────────────────────────────────────

  private trackLatency(toolName: string, latencyMs: number): void {
    const log = this.latencyLog.get(toolName) || [];
    log.push(latencyMs);
    if (log.length > 200) log.shift();
    this.latencyLog.set(toolName, log);
  }

  private p99Of(log: number[]): number {
    if (log.length === 0) return 0;
    const sorted = [...log].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99));
    return Math.round(sorted[idx]);
  }

  private classifyError(error: unknown): string {
    if (error instanceof BackpressureError) return "BACKPRESSURE";
    if (error instanceof QueueTimeoutError) return "QUEUE_TIMEOUT";
    if (String((error as Error).message || "").includes("timeout")) return "TIMEOUT";
    if (String((error as Error).message || "").includes("Circuit")) return "CIRCUIT_OPEN";
    return "EXECUTION_FAILED";
  }

  private circuitStateFor(toolName: string): CircuitState {
    return this.circuitBreakers.get(toolName)?.getStatus().state ?? CircuitState.CLOSED;
  }

  // ─── Health check ───────────────────────────────────────────

  runHealthCheck(): ToolHealthStatus[] {
    const queueStatus = this.priorityQueue.getStatus();
    const statuses: ToolHealthStatus[] = [];

    for (const [toolName, cb] of this.circuitBreakers) {
      const cbStatus = cb.getStatus();
      statuses.push({
        tool: toolName,
        circuitState: cbStatus.state,
        latencyP99Ms: this.p99Of(this.latencyLog.get(toolName) || []),
        errorRate: cbStatus.errorRate,
        requestsInWindow: cbStatus.requestsInWindow,
        queueDepth: queueStatus.queueDepth,
        isHealthy: cbStatus.state === CircuitState.CLOSED && cbStatus.errorRate < 0.1,
      });
    }

    this.emitEvent({ type: "health_check", tools: statuses });
    return statuses;
  }

  onEvent(listener: (event: ResilienceEvent) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      this.eventListeners = this.eventListeners.filter((l) => l !== listener);
    };
  }

  private emitEvent(event: ResilienceEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }

  resetAll(): void {
    for (const cb of this.circuitBreakers.values()) cb.reset();
    for (const rl of this.rateLimiters.values()) rl.reset();
    this.priorityQueue.drain();
    this.cache.clear();
  }

  destroy(): void {
    if (this.healthCheckTimer) clearInterval(this.healthCheckTimer);
    this.priorityQueue.drain();
  }
}