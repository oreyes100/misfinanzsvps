// retry-engine.ts — Motor de retry con backoff exponencial + jitter (MCP-03).
//
// Implementa múltiples estrategias de backoff con jitter para evitar la
// sincronización de retries (thundering herd):
//   - exponential:        delay = base × multiplier^attempt
//   - exponential_jitter: delay = base × multiplier^attempt + jitter
//   - linear:             delay = base × attempt
//   - fibonacci:          delay = base × fib(attempt)
//   - constant:           delay = base
//
// Jitter:
//   - "equal": delay/2 + random(0, delay/2)  → menos varianza
//   - "full":  random(0, delay)               → más varianza, mejor distribución

import type {
  RetryPolicyConfig,
  RetryCondition,
  AttemptRecord,
  RetryResult,
  RetryEvent,
} from "./retry-types.ts";

export class RetryEngine {
  private readonly config: RetryPolicyConfig;
  private eventHandler?: (event: RetryEvent) => void;

  constructor(config: Partial<RetryPolicyConfig> = {}, eventHandler?: (event: RetryEvent) => void) {
    this.config = {
      maxAttempts: config.maxAttempts ?? 3,
      backoffStrategy: config.backoffStrategy ?? "exponential_jitter",
      baseDelayMs: config.baseDelayMs ?? 1000,
      maxDelayMs: config.maxDelayMs ?? 30_000,
      backoffMultiplier: config.backoffMultiplier ?? 2,
      maxJitterMs: config.maxJitterMs ?? 1000,
      retryableConditions: config.retryableConditions ?? ["network_error", "timeout", "server_error", "transient"],
      nonRetryableConditions: config.nonRetryableConditions ?? ["never"],
      fullJitter: config.fullJitter ?? true,
    };
    this.eventHandler = eventHandler;
  }

  /**
   * ═══ CORE: Ejecutar con retry ═══
   * @param fn Función a ejecutar
   * @param context Contexto para logging/eventos
   * @returns Resultado con metadata de retry
   */
  async executeWithRetry<T>(
    fn: () => Promise<T>,
    context: {
      toolName: string;
      idempotencyKey?: string;
      onRetry?: (attempt: number, delayMs: number, error: Error) => void;
    }
  ): Promise<RetryResult> {
    const attempts: AttemptRecord[] = [];
    const backoffDelays: number[] = [];
    let lastError: Error | undefined;
    let totalDelayMs = 0;

    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
      const startTime = Date.now();

      try {
        const result = await fn();

        attempts.push({
          attempt,
          timestamp: startTime,
          success: true,
          delayBeforeMs: attempt > 1 ? backoffDelays[attempt - 2] : 0,
          latencyMs: Date.now() - startTime,
        });

        this.eventHandler?.({ type: "retry_success", tool: context.toolName, attempt, totalDelayMs });

        return {
          success: true,
          data: result,
          _meta: {
            attempt,
            maxAttempts: this.config.maxAttempts,
            totalDelayMs,
            backoffDelays,
            idempotencyHit: false,
            idempotencyKey: context.idempotencyKey,
            retryBudgetRemaining: this.config.maxAttempts - attempt,
            stormDetected: false,
            fallbackUsed: false,
          },
        };
      } catch (error) {
        lastError = error as Error;
        const latencyMs = Date.now() - startTime;
        const condition = this.classifyError(lastError);

        attempts.push({
          attempt,
          timestamp: startTime,
          success: false,
          error: lastError,
          condition,
          delayBeforeMs: attempt > 1 ? backoffDelays[attempt - 2] : 0,
          latencyMs,
        });

        if (!this.isRetryable(condition)) {
          return {
            success: false,
            error: {
              code: "NON_RETRYABLE",
              message: lastError.message,
              condition,
              retryable: false,
            },
            _meta: {
              attempt,
              maxAttempts: this.config.maxAttempts,
              totalDelayMs,
              backoffDelays,
              idempotencyHit: false,
              idempotencyKey: context.idempotencyKey,
              retryBudgetRemaining: 0,
              stormDetected: false,
              fallbackUsed: false,
            },
          };
        }

        if (attempt < this.config.maxAttempts) {
          const delayMs = this.calculateBackoff(attempt);
          backoffDelays.push(delayMs);
          totalDelayMs += delayMs;

          this.eventHandler?.({ type: "retry_scheduled", tool: context.toolName, attempt, delayMs, reason: condition });
          context.onRetry?.(attempt, delayMs, lastError);
          await this.sleep(delayMs);
        }
      }
    }

    this.eventHandler?.({ type: "retry_exhausted", tool: context.toolName, totalAttempts: this.config.maxAttempts, fallbackUsed: false });

    return {
      success: false,
      error: {
        code: "RETRY_EXHAUSTED",
        message: `Todos los ${this.config.maxAttempts} intentos fallaron. Último error: ${lastError?.message}`,
        condition: this.classifyError(lastError!),
        retryable: false,
      },
      _meta: {
        attempt: this.config.maxAttempts,
        maxAttempts: this.config.maxAttempts,
        totalDelayMs,
        backoffDelays,
        idempotencyHit: false,
        idempotencyKey: context.idempotencyKey,
        retryBudgetRemaining: 0,
        stormDetected: false,
        fallbackUsed: false,
      },
    };
  }

  /**
   * ═══ CORE: Calcular delay de backoff ═══
   * @param attempt Número de intento (1-based)
   * @returns Delay en ms
   */
  calculateBackoff(attempt: number): number {
    let delay: number;

    switch (this.config.backoffStrategy) {
      case "exponential":
        delay = this.config.baseDelayMs * Math.pow(this.config.backoffMultiplier, attempt - 1);
        break;

      case "exponential_jitter": {
        const baseDelay = this.config.baseDelayMs * Math.pow(this.config.backoffMultiplier, attempt - 1);
        if (this.config.fullJitter) {
          delay = Math.random() * baseDelay;
        } else {
          delay = baseDelay / 2 + Math.random() * (baseDelay / 2);
        }
        delay += Math.random() * this.config.maxJitterMs;
        break;
      }

      case "linear":
        delay = this.config.baseDelayMs * attempt;
        break;

      case "fibonacci":
        delay = this.config.baseDelayMs * this.fibonacci(attempt);
        break;

      case "constant":
        delay = this.config.baseDelayMs;
        break;

      default:
        delay = this.config.baseDelayMs;
    }

    return Math.min(delay, this.config.maxDelayMs);
  }

  /**
   * Clasificar un error en una condición de retry.
   */
  classifyError(error: Error): RetryCondition {
    const message = error.message.toLowerCase();

    if (message.includes("timeout") || message.includes("timed out") || message.includes("deadline exceeded")) {
      return "timeout";
    }

    if (
      message.includes("network") ||
      message.includes("econnrefused") ||
      message.includes("econnreset") ||
      message.includes("enotfound") ||
      message.includes("socket hang up") ||
      message.includes("fetch failed")
    ) {
      return "network_error";
    }

    if (message.includes("429") || message.includes("rate limit") || message.includes("too many requests")) {
      return "rate_limited";
    }

    if (
      message.includes("500") ||
      message.includes("502") ||
      message.includes("503") ||
      message.includes("504") ||
      message.includes("internal server error") ||
      message.includes("service unavailable") ||
      message.includes("bad gateway")
    ) {
      return "server_error";
    }

    if (message.includes("circuit") || message.includes("half_open") || message.includes("half-open")) {
      return "circuit_half_open";
    }

    return "transient";
  }

  /**
   * Verificar si una condición permite retry.
   */
  isRetryable(condition: RetryCondition): boolean {
    if (this.config.nonRetryableConditions.includes(condition)) {
      return false;
    }
    return this.config.retryableConditions.includes(condition);
  }

  /** Calcular secuencia de Fibonacci (para backoff fibonacci). */
  private fibonacci(n: number): number {
    if (n <= 1) return 1;
    let a = 1;
    let b = 1;
    for (let i = 2; i <= n; i++) {
      [a, b] = [b, a + b];
    }
    return b;
  }

  /** Sleep con precisión de ms. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** Obtener configuración actual (para debugging/testing). */
  getConfig(): RetryPolicyConfig {
    return { ...this.config };
  }
}