// retry-types.ts — Tipos del sistema de retry con backoff (MCP-03 "Amortiguador
// de Tormentas").
//
// Compone el paraguas anti-storm: Retry Policy (backoff + jitter), Idempotencia
// (deduplicación por Idempotency-Key), Retry Budget (límite por cliente) y Storm
// Detection (anti-amplificación con cooldown).

// ─── Estrategia de Backoff ────────────────────────────────────
export type BackoffStrategy =
  | "exponential"         // base × 2^attempt
  | "exponential_jitter"  // base × 2^attempt + jitter aleatorio
  | "linear"              // base × attempt
  | "fibonacci"           // base × fib(attempt)
  | "constant";           // siempre el mismo delay

// ─── Condiciones para reintentar ──────────────────────────────
export type RetryCondition =
  | "network_error"       // Fallo de red/conexión
  | "timeout"             // Timeout del request
  | "rate_limited"        // 429 del servidor
  | "server_error"        // 5xx del servidor
  | "circuit_half_open"   // Circuit breaker en HALF_OPEN
  | "transient"           // Error transitorio genérico
  | "always"              // Siempre reintentar (peligroso)
  | "never";              // Nunca reintentar

// ─── Configuración de Retry Policy ────────────────────────────
export interface RetryPolicyConfig {
  /** Número máximo de intentos (incluyendo el inicial). Default: 3 */
  maxAttempts: number;
  /** Estrategia de backoff. Default: "exponential_jitter" */
  backoffStrategy: BackoffStrategy;
  /** Delay base en ms. Default: 1000 */
  baseDelayMs: number;
  /** Delay máximo en ms. Default: 30000 */
  maxDelayMs: number;
  /** Multiplicador de backoff. Default: 2 */
  backoffMultiplier: number;
  /** Jitter máximo en ms (solo para exponential_jitter). Default: 1000 */
  maxJitterMs: number;
  /** Condiciones que permiten retry. Default: ["network_error", "timeout", "server_error", "transient"] */
  retryableConditions: RetryCondition[];
  /** Condiciones que NUNCA permiten retry. Default: ["never"] */
  nonRetryableConditions: RetryCondition[];
  /** Si true, aplicar jitter "full" (0 a delay) en vez de "equal" (delay/2 a delay) */
  fullJitter: boolean;
}

// ─── Configuración de Idempotencia ────────────────────────────
export interface IdempotencyConfig {
  /** Habilitar idempotencia. Default: true */
  enabled: boolean;
  /** TTL de las claves de idempotencia en ms. Default: 86400000 (24h) */
  keyTtlMs: number;
  /** Almacenamiento: "memory" | "localStorage" | "redis" */
  storage: "memory" | "localStorage" | "redis";
  /** Prefijo para las claves. Default: "mcp_idem" */
  keyPrefix: string;
  /** Máximo de claves a almacenar (para memory/localStorage). Default: 10000 */
  maxKeys: number;
  /** Si true, limpiar claves expiradas periódicamente */
  autoCleanup: boolean;
  /** Intervalo de limpieza en ms. Default: 60000 (1 min) */
  cleanupIntervalMs: number;
}

// ─── Configuración de Retry Budget ────────────────────────────
export interface RetryBudgetConfig {
  /** Máximo de retries por cliente en la ventana de tiempo. Default: 3 */
  maxRetriesPerWindow: number;
  /** Ventana de tiempo en ms. Default: 60000 (1 min) */
  windowMs: number;
  /** Cooldown en ms cuando se agota el budget. Default: 120000 (2 min) */
  cooldownMs: number;
  /** Si true, el budget es global (todos los tools) en vez de por-tool */
  globalBudget: boolean;
  /** Porcentaje del budget que se reserva para herramientas críticas. Default: 0.2 */
  criticalReserveRatio: number;
}

// ─── Configuración de Storm Detection ─────────────────────────
export interface StormDetectionConfig {
  /** Habilitar detección de storms. Default: true */
  enabled: boolean;
  /** Umbral de retries simultáneos para detectar storm. Default: 10 */
  concurrentRetryThreshold: number;
  /** Ventana de tiempo para contar retries en ms. Default: 10000 (10s) */
  detectionWindowMs: number;
  /** Factor de amplificación máximo permitido. Default: 3 */
  maxAmplificationFactor: number;
  /** Cooldown global cuando se detecta storm en ms. Default: 30000 */
  stormCooldownMs: number;
  /** Si true, degradar a fallback en vez de rechazar durante storm */
  degradeToFallback: boolean;
}

// ─── Configuración global de Retry ────────────────────────────
export interface RetrySystemConfig {
  retryPolicy: RetryPolicyConfig;
  idempotency: IdempotencyConfig;
  retryBudget: RetryBudgetConfig;
  stormDetection: StormDetectionConfig;
  /** Fallback cuando se agotan todos los retries */
  exhaustedFallback: {
    type: "cache" | "default_value" | "queue_for_later" | "reject";
    cacheTtlMs?: number;
    defaultValue?: unknown;
  };
  /** Logging y observabilidad */
  logging: {
    level: "debug" | "info" | "warn" | "error";
    logRetries: boolean;
    logIdempotencyHits: boolean;
    logStormDetection: boolean;
  };
}

// ─── Resultado de un retry ────────────────────────────────────
export interface RetryResult {
  success: boolean;
  data?: unknown;
  error?: {
    code: string;
    message: string;
    condition: RetryCondition;
    retryable: boolean;
  };
  _meta: {
    attempt: number;
    maxAttempts: number;
    totalDelayMs: number;
    backoffDelays: number[];
    idempotencyHit: boolean;
    idempotencyKey?: string;
    retryBudgetRemaining: number;
    stormDetected: boolean;
    fallbackUsed: boolean;
  };
}

// ─── Registro de un intento ───────────────────────────────────
export interface AttemptRecord {
  attempt: number;
  timestamp: number;
  success: boolean;
  error?: Error;
  condition?: RetryCondition;
  delayBeforeMs: number;
  latencyMs: number;
}

// ─── Eventos del sistema de retry ─────────────────────────────
export type RetryEvent =
  | { type: "retry_scheduled"; tool: string; attempt: number; delayMs: number; reason: RetryCondition }
  | { type: "retry_exhausted"; tool: string; totalAttempts: number; fallbackUsed: boolean }
  | { type: "idempotency_hit"; tool: string; key: string; cachedResult: unknown }
  | { type: "idempotency_stored"; tool: string; key: string }
  | { type: "budget_exhausted"; tool: string; clientId: string; cooldownMs: number }
  | { type: "storm_detected"; tool: string; concurrentRetries: number; amplification: number }
  | { type: "storm_cooldown"; tool: string; cooldownMs: number }
  | { type: "retry_success"; tool: string; attempt: number; totalDelayMs: number };