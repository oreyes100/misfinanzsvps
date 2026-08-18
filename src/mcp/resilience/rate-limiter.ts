// rate-limiter.ts — Rate Limiter por herramienta.
//
// Algoritmos: fixed, sliding window y token_bucket (por defecto, permite bursts
// controlados). El límite es por clientId → un cliente que abusa no afecta al resto.

import type { RateLimiterConfig, ResilienceEvent } from "./types.ts";

export class RateLimiter {
  private readonly config: Required<RateLimiterConfig>;
  private readonly toolName: string;
  private eventHandler?: (event: ResilienceEvent) => void;

  private tokens: number;
  private lastRefillTime: number;
  private requestTimestamps = new Map<string, number[]>(); // clientId → timestamps

  constructor(toolName: string, config: Partial<RateLimiterConfig> = {}, eventHandler?: (event: ResilienceEvent) => void) {
    this.toolName = toolName;
    this.eventHandler = eventHandler;
    this.config = {
      maxRequests: config.maxRequests ?? 60,
      windowMs: config.windowMs ?? 60_000,
      algorithm: config.algorithm ?? "token_bucket",
      refillRatePerSecond: config.refillRatePerSecond ?? 1,
      bucketCapacity: config.bucketCapacity ?? config.maxRequests ?? 60,
    };
    this.tokens = this.config.bucketCapacity;
    this.lastRefillTime = Date.now();
  }

  /**
   * ═══ CORE: Verificar si un request puede pasar ═══
   */
  canProceed(clientId: string): { allowed: boolean; retryAfterMs?: number; remaining: number } {
    switch (this.config.algorithm) {
      case "sliding":
        return this.checkSlidingWindow(clientId);
      case "fixed":
        return this.checkFixedWindow(clientId);
      case "token_bucket":
      default:
        return this.checkTokenBucket(clientId);
    }
  }

  private checkTokenBucket(clientId: string): { allowed: boolean; retryAfterMs?: number; remaining: number } {
    this.refillTokens();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return { allowed: true, remaining: Math.floor(this.tokens) };
    }

    const msPerToken = 1000 / this.config.refillRatePerSecond;
    const retryAfterMs = Math.ceil(msPerToken);
    this.eventHandler?.({ type: "rate_limit_exceeded", tool: this.toolName, clientId, retryAfterMs });
    return { allowed: false, retryAfterMs, remaining: 0 };
  }

  private checkSlidingWindow(clientId: string): { allowed: boolean; retryAfterMs?: number; remaining: number } {
    const now = Date.now();
    const windowStart = now - this.config.windowMs;
    let timestamps = (this.requestTimestamps.get(clientId) || []).filter((t) => t >= windowStart);

    if (timestamps.length >= this.config.maxRequests) {
      const retryAfterMs = Math.max(1, timestamps[0] + this.config.windowMs - now);
      this.eventHandler?.({ type: "rate_limit_exceeded", tool: this.toolName, clientId, retryAfterMs });
      return { allowed: false, retryAfterMs, remaining: 0 };
    }

    timestamps.push(now);
    this.requestTimestamps.set(clientId, timestamps);
    return { allowed: true, remaining: this.config.maxRequests - timestamps.length };
  }

  private checkFixedWindow(clientId: string): { allowed: boolean; retryAfterMs?: number; remaining: number } {
    const now = Date.now();
    const windowStart = Math.floor(now / this.config.windowMs) * this.config.windowMs;
    let timestamps = (this.requestTimestamps.get(clientId) || []).filter((t) => t >= windowStart);

    if (timestamps.length >= this.config.maxRequests) {
      return { allowed: false, retryAfterMs: Math.max(1, windowStart + this.config.windowMs - now), remaining: 0 };
    }

    timestamps.push(now);
    this.requestTimestamps.set(clientId, timestamps);
    return { allowed: true, remaining: this.config.maxRequests - timestamps.length };
  }

  private refillTokens(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefillTime;
    const tokensToAdd = (elapsed / 1000) * this.config.refillRatePerSecond;
    this.tokens = Math.min(this.config.bucketCapacity, this.tokens + tokensToAdd);
    this.lastRefillTime = now;
  }

  reset(): void {
    this.tokens = this.config.bucketCapacity;
    this.lastRefillTime = Date.now();
    this.requestTimestamps.clear();
  }

  getStatus(): { algorithm: string; availableTokens: number; activeClients: number } {
    return {
      algorithm: this.config.algorithm,
      availableTokens: Math.floor(this.tokens),
      activeClients: this.requestTimestamps.size,
    };
  }
}
