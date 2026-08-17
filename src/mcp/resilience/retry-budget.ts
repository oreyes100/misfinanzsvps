// retry-budget.ts — Presupuesto de retries por cliente + Detector de Retry Storms
// (MCP-03 "Amortiguador de Tormentas").
//
// RetryBudgetManager: limita cuántas ejecuciones de tool puede hacer un cliente
// en una ventana de tiempo. Si lo agota → cooldown. Las herramientas críticas
// tienen una reserva propia (no compiten con las no críticas).
//
// StormDetector: detecta amplificación de retries (muchos reintentos en poco
// tiempo, o factor retries/requests originales > umbral) y aplica un cooldown
// global o degradación a fallback.

import type { RetryBudgetConfig, StormDetectionConfig, RetryEvent } from "./retry-types.ts";

export class RetryBudgetManager {
  private readonly config: RetryBudgetConfig;
  private clientRetries = new Map<string, { count: number; windowStart: number }>();
  private clientCooldowns = new Map<string, number>(); // clientId → cooldownUntil
  private eventHandler?: (event: RetryEvent) => void;

  constructor(config: Partial<RetryBudgetConfig> = {}, eventHandler?: (event: RetryEvent) => void) {
    this.config = {
      maxRetriesPerWindow: config.maxRetriesPerWindow ?? 3,
      windowMs: config.windowMs ?? 60_000,
      cooldownMs: config.cooldownMs ?? 120_000,
      globalBudget: config.globalBudget ?? false,
      criticalReserveRatio: config.criticalReserveRatio ?? 0.2,
    };
    this.eventHandler = eventHandler;
  }

  /**
   * ═══ CORE: Verificar si una ejecución está permitida ═══
   */
  canRetry(params: { clientId: string; toolName: string; isCritical?: boolean }): {
    allowed: boolean;
    reason?: string;
    remaining: number;
    cooldownMs?: number;
  } {
    const { clientId, toolName, isCritical } = params;
    const now = Date.now();

    const cooldownUntil = this.clientCooldowns.get(clientId);
    if (cooldownUntil && now < cooldownUntil) {
      const remainingCooldown = cooldownUntil - now;
      return {
        allowed: false,
        reason: `Cooldown activo. Espera ${Math.ceil(remainingCooldown / 1000)}s`,
        remaining: 0,
        cooldownMs: remainingCooldown,
      };
    }

    const budgetKey = this.config.globalBudget ? "__global__" : clientId;
    let record = this.clientRetries.get(budgetKey);

    if (!record || now - record.windowStart >= this.config.windowMs) {
      record = { count: 0, windowStart: now };
      this.clientRetries.set(budgetKey, record);
    }

    // Reserva crítica con ceil: garantiza ≥1 retry reservado cuando ratio > 0,
    // de modo que las operaciones críticas nunca se quedan sin presupuesto.
    const criticalReserve = isCritical
      ? 0
      : Math.ceil(this.config.maxRetriesPerWindow * this.config.criticalReserveRatio);
    const effectiveBudget = this.config.maxRetriesPerWindow - criticalReserve;

    if (record.count >= effectiveBudget) {
      const cooldownUntil = now + this.config.cooldownMs;
      this.clientCooldowns.set(clientId, cooldownUntil);

      this.eventHandler?.({ type: "budget_exhausted", tool: toolName, clientId, cooldownMs: this.config.cooldownMs });

      return {
        allowed: false,
        reason: `Budget de retries agotado (${record.count}/${effectiveBudget}). Cooldown aplicado.`,
        remaining: 0,
        cooldownMs: this.config.cooldownMs,
      };
    }

    record.count++;

    return {
      allowed: true,
      remaining: effectiveBudget - record.count,
    };
  }

  /** Reset del budget de un cliente (para admin/testing). */
  resetClient(clientId: string): void {
    this.clientRetries.delete(clientId);
    this.clientCooldowns.delete(clientId);
  }

  /** Reset de todos los budgets. */
  resetAll(): void {
    this.clientRetries.clear();
    this.clientCooldowns.clear();
  }

  /** Obtener estado del budget de un cliente. */
  getClientStatus(clientId: string): {
    retryCount: number;
    windowStart: number;
    cooldownActive: boolean;
    cooldownRemainingMs: number;
  } {
    const budgetKey = this.config.globalBudget ? "__global__" : clientId;
    const record = this.clientRetries.get(budgetKey);
    const cooldownUntil = this.clientCooldowns.get(clientId);
    const now = Date.now();

    return {
      retryCount: record?.count ?? 0,
      windowStart: record?.windowStart ?? 0,
      cooldownActive: !!cooldownUntil && cooldownUntil > now,
      cooldownRemainingMs: cooldownUntil ? Math.max(0, cooldownUntil - now) : 0,
    };
  }
}

interface RetryLogEntry {
  timestamp: number;
  tool: string;
  clientId: string;
}

export class StormDetector {
  private readonly config: StormDetectionConfig;
  private retryLog: RetryLogEntry[] = [];
  private originalRequestCount = 0;
  private isStormActive = false;
  private stormEndTime = 0;
  private eventHandler?: (event: RetryEvent) => void;

  constructor(config: Partial<StormDetectionConfig> = {}, eventHandler?: (event: RetryEvent) => void) {
    this.config = {
      enabled: config.enabled ?? true,
      concurrentRetryThreshold: config.concurrentRetryThreshold ?? 10,
      detectionWindowMs: config.detectionWindowMs ?? 10_000,
      maxAmplificationFactor: config.maxAmplificationFactor ?? 3,
      stormCooldownMs: config.stormCooldownMs ?? 30_000,
      degradeToFallback: config.degradeToFallback ?? true,
    };
    this.eventHandler = eventHandler;
  }

  /** Registrar un request original (no retry). */
  recordOriginalRequest(): void {
    this.originalRequestCount++;
    this.cleanupOldEntries();
  }

  /**
   * ═══ CORE: Registrar un retry y verificar si hay storm ═══
   */
  recordRetry(tool: string, clientId: string): {
    isStorm: boolean;
    shouldDegrade: boolean;
    concurrentRetries: number;
    amplificationFactor: number;
  } {
    if (!this.config.enabled) {
      return { isStorm: false, shouldDegrade: false, concurrentRetries: 0, amplificationFactor: 0 };
    }

    const now = Date.now();

    if (this.isStormActive && now < this.stormEndTime) {
      return {
        isStorm: true,
        shouldDegrade: this.config.degradeToFallback,
        concurrentRetries: this.getRecentRetries().length,
        amplificationFactor: this.calculateAmplification(),
      };
    }

    this.retryLog.push({ timestamp: now, tool, clientId });
    this.cleanupOldEntries();

    const recentRetries = this.getRecentRetries();
    const concurrentRetries = recentRetries.length;
    const amplificationFactor = this.calculateAmplification();

    const isConcurrentStorm = concurrentRetries >= this.config.concurrentRetryThreshold;
    const isAmplificationStorm = amplificationFactor >= this.config.maxAmplificationFactor;

    if (isConcurrentStorm || isAmplificationStorm) {
      this.isStormActive = true;
      this.stormEndTime = now + this.config.stormCooldownMs;

      this.eventHandler?.({ type: "storm_detected", tool, concurrentRetries, amplification: amplificationFactor });
      this.eventHandler?.({ type: "storm_cooldown", tool, cooldownMs: this.config.stormCooldownMs });

      console.warn(
        `🚨 [STORM DETECTED] ${concurrentRetries} retries concurrentes, ` +
          `amplificación x${amplificationFactor.toFixed(1)}. ` +
          `Cooldown: ${this.config.stormCooldownMs / 1000}s`
      );

      return { isStorm: true, shouldDegrade: this.config.degradeToFallback, concurrentRetries, amplificationFactor };
    }

    return { isStorm: false, shouldDegrade: false, concurrentRetries, amplificationFactor };
  }

  /** Obtener retries recientes en la ventana de detección. */
  private getRecentRetries(): RetryLogEntry[] {
    const windowStart = Date.now() - this.config.detectionWindowMs;
    return this.retryLog.filter((r) => r.timestamp >= windowStart);
  }

  /** Calcular factor de amplificación (retries / requests originales). */
  private calculateAmplification(): number {
    if (this.originalRequestCount === 0) return 0;
    return this.getRecentRetries().length / this.originalRequestCount;
  }

  /** Limpiar entradas fuera de la ventana. */
  private cleanupOldEntries(): void {
    const windowStart = Date.now() - this.config.detectionWindowMs;
    this.retryLog = this.retryLog.filter((r) => r.timestamp >= windowStart);
  }

  /** Verificar si hay storm activo. */
  isStormCurrentlyActive(): boolean {
    return this.isStormActive && Date.now() < this.stormEndTime;
  }

  /** Reset manual (para admin/testing). */
  reset(): void {
    this.retryLog = [];
    this.originalRequestCount = 0;
    this.isStormActive = false;
    this.stormEndTime = 0;
  }

  /** Obtener estado actual. */
  getStatus(): {
    isStormActive: boolean;
    stormRemainingMs: number;
    concurrentRetries: number;
    amplificationFactor: number;
    totalOriginalRequests: number;
  } {
    const now = Date.now();
    return {
      isStormActive: this.isStormActive && now < this.stormEndTime,
      stormRemainingMs: this.isStormActive ? Math.max(0, this.stormEndTime - now) : 0,
      concurrentRetries: this.getRecentRetries().length,
      amplificationFactor: this.calculateAmplification(),
      totalOriginalRequests: this.originalRequestCount,
    };
  }
}