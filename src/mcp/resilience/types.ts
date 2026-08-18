// types.ts — Tipos del sistema de resiliencia MCP-02 (Muralla de Contención).
//
// IMPORTANTE: se usan objetos `as const` en lugar de `enum` de TypeScript porque
// los enums no son "erasable syntax" y romperían el arranque nativo del servidor
// con Node 26 (`node src/mcp/server.ts`).

// ─── Estados del Circuit Breaker ──────────────────────────────
export const CircuitState = {
  CLOSED: "CLOSED",
  OPEN: "OPEN",
  HALF_OPEN: "HALF_OPEN",
} as const;
export type CircuitState = (typeof CircuitState)[keyof typeof CircuitState];

// ─── Prioridad de tool calls ──────────────────────────────────
export const ToolPriority = {
  CRITICAL: 0,
  HIGH: 1,
  NORMAL: 2,
  LOW: 3,
  BACKGROUND: 4,
} as const;
export type ToolPriority = (typeof ToolPriority)[keyof typeof ToolPriority];

export const TOOL_PRIORITY_NAME: Record<number, string> = {
  [ToolPriority.CRITICAL]: "CRITICAL",
  [ToolPriority.HIGH]: "HIGH",
  [ToolPriority.NORMAL]: "NORMAL",
  [ToolPriority.LOW]: "LOW",
  [ToolPriority.BACKGROUND]: "BACKGROUND",
};

// ─── Configuración del Circuit Breaker ────────────────────────
export interface CircuitBreakerConfig {
  failureThreshold: number;
  successThreshold: number;
  resetTimeoutMs: number;
  requestTimeoutMs: number;
  errorRateThreshold: number;
  errorRateWindowMs: number;
  minimumRequestVolume: number;
}

// ─── Configuración del Rate Limiter ───────────────────────────
export interface RateLimiterConfig {
  maxRequests: number;
  windowMs: number;
  algorithm: "fixed" | "sliding" | "token_bucket";
  refillRatePerSecond?: number;
  bucketCapacity?: number;
}

// ─── Configuración de la cola de prioridades ──────────────────
export interface PriorityQueueConfig {
  maxQueueSize: number;
  concurrency: number;
  maxWaitTimeMs: number;
  enableBackpressure: boolean;
}

// ─── Configuración global de resiliencia ──────────────────────
export interface FallbackConfig {
  type: "cache" | "default_value" | "queue_for_later" | "reject";
  cacheTtlMs?: number;
  defaultValue?: unknown;
}

export interface ResilienceConfig {
  circuitBreaker: CircuitBreakerConfig;
  rateLimiter: RateLimiterConfig;
  priorityQueue: PriorityQueueConfig;
  fallback?: FallbackConfig;
  metrics: {
    enablePrometheus: boolean;
    logLevel: "debug" | "info" | "warn" | "error";
    healthCheckIntervalMs: number;
  };
}

// ─── Resultado de un tool call con metadata de resiliencia ────
export interface ResilientToolCallResult {
  success: boolean;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
    retryAfterMs?: number;
  };
  _meta: {
    circuitState: CircuitState;
    latencyMs: number;
    attempt: number;
    fromCache: boolean;
    queuedTimeMs: number;
    priority: ToolPriority;
  };
}

// ─── Configuración por herramienta ────────────────────────────
export interface ToolResilienceConfig {
  toolName: string;
  priority: ToolPriority;
  rateLimitPerMinute: number;
  circuitBreaker?: Partial<CircuitBreakerConfig>;
  fallback?: FallbackConfig;
  bypassQueue?: boolean;
}

// ─── Eventos del sistema de resiliencia ───────────────────────
export type ResilienceEvent =
  | { type: "circuit_opened"; tool: string; failureCount: number }
  | { type: "circuit_half_open"; tool: string }
  | { type: "circuit_closed"; tool: string; successCount: number }
  | { type: "rate_limit_exceeded"; tool: string; clientId: string; retryAfterMs: number }
  | { type: "queue_full"; tool: string; queueSize: number }
  | { type: "backpressure_applied"; tool: string; rejectedCount: number }
  | { type: "fallback_activated"; tool: string; fallbackType: string }
  | { type: "timeout"; tool: string; timeoutMs: number }
  | { type: "health_check"; tools: ToolHealthStatus[] };

export interface ToolHealthStatus {
  tool: string;
  circuitState: CircuitState;
  latencyP99Ms: number;
  errorRate: number;
  requestsInWindow: number;
  queueDepth: number;
  isHealthy: boolean;
}

export interface ToolHealthReport {
  timestamp: string;
  overall: {
    healthyTools: number;
    totalTools: number;
    healthPercentage: number;
    openCircuits: number;
  };
  tools: ToolHealthStatus[];
  recentEvents: Array<ResilienceEvent & { timestamp: number; formatted: string }>;
}
