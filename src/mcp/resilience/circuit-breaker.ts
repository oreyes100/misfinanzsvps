// circuit-breaker.ts — Circuit Breaker por herramienta MCP.
//
// Estados: CLOSED → (fallos) → OPEN → (timer) → HALF_OPEN → (éxitos) → CLOSED.
// Abre por umbral de fallos consecutivos O por error rate en la ventana.

import { CircuitState, type CircuitBreakerConfig, type ResilienceEvent } from "./types.ts";

export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount = 0;
  private successCount = 0;
  private nextAttemptTime = 0;
  private requestLog: { timestamp: number; success: boolean }[] = [];

  private readonly config: CircuitBreakerConfig;
  private readonly toolName: string;
  private eventHandler?: (event: ResilienceEvent) => void;

  constructor(toolName: string, config: Partial<CircuitBreakerConfig> = {}, eventHandler?: (event: ResilienceEvent) => void) {
    this.toolName = toolName;
    this.eventHandler = eventHandler;
    this.config = {
      failureThreshold: config.failureThreshold ?? 5,
      successThreshold: config.successThreshold ?? 2,
      resetTimeoutMs: config.resetTimeoutMs ?? 30_000,
      requestTimeoutMs: config.requestTimeoutMs ?? 10_000,
      errorRateThreshold: config.errorRateThreshold ?? 0.5,
      errorRateWindowMs: config.errorRateWindowMs ?? 60_000,
      minimumRequestVolume: config.minimumRequestVolume ?? 10,
    };
  }

  /**
   * ═══ CORE: Verificar si un request puede pasar ═══
   */
  canExecute(): { allowed: boolean; reason?: string; retryAfterMs?: number } {
    this.cleanupOldRequests();

    switch (this.state) {
      case CircuitState.CLOSED:
        return { allowed: true };

      case CircuitState.OPEN: {
        const now = Date.now();
        if (now >= this.nextAttemptTime) {
          this.transitionTo(CircuitState.HALF_OPEN);
          return { allowed: true };
        }
        const retryAfterMs = this.nextAttemptTime - now;
        return {
          allowed: false,
          reason: `Circuit OPEN for '${this.toolName}'. Fallos: ${this.failureCount}`,
          retryAfterMs,
        };
      }

      case CircuitState.HALF_OPEN:
        // En HALF_OPEN solo se deja pasar el request de sondeo; el flag interno
        // se controla desde el orquestador (una sola prueba por transición).
        return { allowed: true };

      default:
        return { allowed: true };
    }
  }

  recordSuccess(latencyMs: number): void {
    const now = Date.now();
    this.requestLog.push({ timestamp: now, success: true });

    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount++;
      if (this.successCount >= this.config.successThreshold) {
        this.transitionTo(CircuitState.CLOSED);
      }
    }

    if (this.state === CircuitState.CLOSED) {
      this.checkErrorRate();
    }
  }

  recordFailure(): void {
    const now = Date.now();
    this.requestLog.push({ timestamp: now, success: false });

    if (this.state === CircuitState.HALF_OPEN) {
      // Cualquier fallo en HALF_OPEN → volver a OPEN
      this.transitionTo(CircuitState.OPEN);
      return;
    }

    if (this.state === CircuitState.CLOSED) {
      this.failureCount++;
      if (this.failureCount >= this.config.failureThreshold) {
        this.transitionTo(CircuitState.OPEN);
        return;
      }
      this.checkErrorRate();
    }
  }

  private checkErrorRate(): void {
    const windowStart = Date.now() - this.config.errorRateWindowMs;
    const recent = this.requestLog.filter((r) => r.timestamp >= windowStart);
    if (recent.length < this.config.minimumRequestVolume) return;

    const failures = recent.filter((r) => !r.success).length;
    if (failures / recent.length >= this.config.errorRateThreshold) {
      this.transitionTo(CircuitState.OPEN);
    }
  }

  private transitionTo(newState: CircuitState): void {
    const oldState = this.state;
    this.state = newState;

    switch (newState) {
      case CircuitState.OPEN:
        this.nextAttemptTime = Date.now() + this.config.resetTimeoutMs;
        this.failureCount = 0;
        this.successCount = 0;
        this.eventHandler?.({ type: "circuit_opened", tool: this.toolName, failureCount: this.failureCount });
        break;

      case CircuitState.HALF_OPEN:
        this.successCount = 0;
        this.eventHandler?.({ type: "circuit_half_open", tool: this.toolName });
        break;

      case CircuitState.CLOSED:
        this.failureCount = 0;
        this.successCount = 0;
        this.eventHandler?.({ type: "circuit_closed", tool: this.toolName, successCount: this.successCount });
        break;
    }

    if (oldState !== newState) {
      console.log(`[CircuitBreaker:${this.toolName}] ${oldState} → ${newState}`);
    }
  }

  private cleanupOldRequests(): void {
    const windowStart = Date.now() - this.config.errorRateWindowMs;
    this.requestLog = this.requestLog.filter((r) => r.timestamp >= windowStart);
  }

  reset(): void {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.requestLog = [];
    this.nextAttemptTime = 0;
  }

  getStatus(): {
    state: CircuitState;
    failureCount: number;
    successCount: number;
    errorRate: number;
    requestsInWindow: number;
  } {
    const windowStart = Date.now() - this.config.errorRateWindowMs;
    const recent = this.requestLog.filter((r) => r.timestamp >= windowStart);
    const failures = recent.filter((r) => !r.success).length;
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      errorRate: recent.length > 0 ? failures / recent.length : 0,
      requestsInWindow: recent.length,
    };
  }
}
