// retry-integration.ts — Integración del sistema de retry (MCP-03) con las
// herramientas reales de Mis Finanzas.
//
// MCP-03 se conecta en la capa de ejecución del servidor: cada handler real
// (balance, OCR, drive, transferencias) se envuelve con
// `runToolWithRetry`, que aplica:
//   - Idempotencia por Idempotency-Key (deduplicación de replays)
//   - Retry Budget por cliente (límite de ejecuciones por ventana)
//   - Storm Detection (cooldown si hay amplificación de retries)
//   - Backoff exponencial + jitter (RetryEngine)
//
// Diferencia con la propuesta original: en lugar de wrappers globales con
// funciones simuladas (`driveReadWithRetry`, `ocrScanWithRetry`...), se expone
// una factory por instancia de servidor y un wrapper por herramienta real. Esto
// evita datos mock en producción y aísla el estado (budget/storm/idempotencia)
// entre instancias de servidor en tests.

import { RetryOrchestrator } from "./resilience/retry-orchestrator.ts";
import type { RetrySystemConfig, RetryEvent } from "./resilience/retry-types.ts";
import type { SecureToolDefinition } from "./tool-registry.ts";

// ─── Configuración específica para misfinanzsvps ──────────────
export const MISFINANZAS_RETRY_CONFIG: RetrySystemConfig = {
  retryPolicy: {
    maxAttempts: 5,                       // Hasta 5 intentos por tool call
    backoffStrategy: "exponential_jitter",
    baseDelayMs: 1000,                    // 1s base
    maxDelayMs: 30_000,                   // Máximo 30s
    backoffMultiplier: 2,                 // Duplicar cada intento
    maxJitterMs: 1000,                    // Hasta 1s de jitter (anti thundering herd)
    retryableConditions: ["network_error", "timeout", "server_error", "transient"],
    nonRetryableConditions: ["never"],
    fullJitter: true,
  },
  idempotency: {
    enabled: true,
    keyTtlMs: 24 * 60 * 60 * 1000,        // 24 horas
    storage: "localStorage",              // Cae a memoria si localStorage no existe (Node)
    keyPrefix: "misfinanzas_idem",
    maxKeys: 5000,
    autoCleanup: true,
    cleanupIntervalMs: 5 * 60 * 1000,     // Cada 5 minutos
  },
  retryBudget: {
    // El budget cuenta ejecuciones totales (no solo retries), como define la
    // propuesta MCP-03. 10/min es holgado para el uso normal del agente Hermes
    // (batch de get_balance + add_transaction) y sigue cortando la amplificación
    // de un storm. Ajustar en Settings si el uso real lo exige.
    maxRetriesPerWindow: 10,
    windowMs: 60_000,
    cooldownMs: 120_000,                  // 2 min de cooldown al agotarse
    globalBudget: false,                  // Budget por cliente
    criticalReserveRatio: 0.2,            // 20% reservado para operaciones críticas
  },
  stormDetection: {
    enabled: true,
    concurrentRetryThreshold: 8,          // 8 retries en 10s = storm
    detectionWindowMs: 10_000,
    maxAmplificationFactor: 3,
    stormCooldownMs: 30_000,
    degradeToFallback: true,
  },
  exhaustedFallback: {
    // "cache" aquí delega: si el retry falla, el ResilienceOrchestrator (MCP-02)
    // ya sirve caché para las herramientas de lectura. Escrituras financieras no
    // usan fallback automático.
    type: "cache",
    cacheTtlMs: 5 * 60 * 1000,
  },
  logging: {
    level: "info",
    logRetries: true,
    logIdempotencyHits: true,
    logStormDetection: true,
  },
};

/**
 * Factory del orquestador de retry con la configuración de Mis Finanzas y
 * logging de eventos. Se crea UNA por instancia de servidor para aislar
 * budget/storm/idempotencia entre procesos (y tests).
 */
export function createRetryOrchestrator(): RetryOrchestrator {
  const orchestrator = new RetryOrchestrator(MISFINANZAS_RETRY_CONFIG);
  orchestrator.onEvent((event: RetryEvent) => logRetryEvent(event));
  return orchestrator;
}

export interface ToolCallContext {
  clientId?: string;
  idempotencyKey?: string;
}

/**
 * ═══ CORE: Ejecutar una herramienta real con retry completo ═══
 *
 * Uso en server.ts:
 *   orchestrator.registerTool(merged, (args, ctx) =>
 *     runToolWithRetry(retry, tool, args, ctx)
 *   );
 */
export async function runToolWithRetry(
  retry: RetryOrchestrator,
  tool: SecureToolDefinition,
  args: unknown,
  ctx?: ToolCallContext
): Promise<unknown> {
  const clientId = ctx?.clientId || "mcp-client";
  const idempotencyKey = ctx?.idempotencyKey;

  // Las operaciones críticas (transferencias, sync de Drive) usan el budget
  // reservado y nunca reintentan a ciegas: el fallback del llamador decide.
  const isCritical = tool.sensitivity === "critical";

  const result = await retry.executeWithFullResilience({
    toolName: tool.name,
    clientId,
    args,
    idempotencyKey,
    isCritical,
    handler: async () => tool.handler(args),
    // Sin fallback automático aquí: el fallback de caché de lecturas lo gestiona
    // el ResilienceOrchestrator (MCP-02) si el retry también falla. Una
    // transferencia que agota retries NO se re-ejecuta ni se degrada.
    fallback: undefined,
  });

  if (result.success) {
    return result.data;
  }

  const err = result.error || { code: "RETRY_FAILED", message: "Fallo desconocido del sistema de retry" };
  throw new Error(`${err.code}: ${err.message}`);
}

// ─── Logging de eventos ───────────────────────────────────────
function logRetryEvent(event: RetryEvent): void {
  const timestamp = new Date().toISOString().slice(11, 19);

  switch (event.type) {
    case "retry_scheduled":
      console.log(
        `[${timestamp}] 🔄 Retry #${event.attempt} para '${event.tool}' en ${event.delayMs}ms (razón: ${event.reason})`
      );
      break;

    case "retry_exhausted":
      console.warn(
        `[${timestamp}] ❌ Retries agotados para '${event.tool}' (${event.totalAttempts} intentos). Fallback: ${event.fallbackUsed}`
      );
      break;

    case "retry_success":
      console.log(
        `[${timestamp}] ✅ Retry exitoso para '${event.tool}' en intento #${event.attempt} (delay total: ${event.totalDelayMs}ms)`
      );
      break;

    case "idempotency_hit":
      console.log(`[${timestamp}] 🔄 Idempotency HIT: '${event.tool}' (key: ${event.key.slice(0, 8)}...)`);
      break;

    case "idempotency_stored":
      console.log(`[${timestamp}] 📦 Idempotency STORED: '${event.tool}' (key: ${event.key.slice(0, 8)}...)`);
      break;

    case "budget_exhausted":
      console.warn(
        `[${timestamp}] ⚠️ Budget agotado: cliente ${event.clientId} en '${event.tool}'. Cooldown: ${event.cooldownMs / 1000}s`
      );
      break;

    case "storm_detected":
      console.error(
        `[${timestamp}] 🚨 STORM DETECTADO: ${event.concurrentRetries} retries concurrentes, amplificación x${event.amplification.toFixed(1)}`
      );
      break;

    case "storm_cooldown":
      console.warn(`[${timestamp}] ⏳ Storm cooldown: ${event.cooldownMs / 1000}s`);
      break;
  }
}