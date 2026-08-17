// server.ts — Servidor MCP "Escudo de Descubrimiento" (MCP-01) + "Muralla de
// Contención" (MCP-02).
//
// MCP-01 (descubrimiento seguro):
//   - Método propio `capability/negotiate`: token → rol → scopes → tools visibles.
//   - tools/list filtrado por scopes de la sesión (con obfuscación de schemas).
//   - tools/call autorizado por scopes + idempotencia + aprobación humana.
//
// MCP-02 (resiliencia frente a floods):
//   - ResilienceOrchestrator: rate limiting (token bucket), circuit breaker,
//     cola de prioridades con backpressure y fallback a caché para lecturas.
//   - tools/call atraviesa el orquestador: 429 RATE_LIMITED, 503 CIRCUIT_OPEN,
//     BACKPRESSURE, TIMEOUT, con retryAfterMs.
//
// MCP-03 (amortiguador de tormentas):
//   - RetryOrchestrator: backoff exponencial + jitter, idempotencia por
//     Idempotency-Key, presupuesto de retries por cliente y detección de storms.
//   - Cada handler real se envuelve con runToolWithRetry (retry engine dentro
//     de la ejecución). La idempotencia de replay la gestiona el
//     IdempotencyManager del retry layer en vez del antiguo Map local.
//
// Arranque:
//   node src/mcp/server.ts            (o compilado: node dist/mcp/server.js)
// Uso como módulo: import { createMcpServer, startMcpServer } from "./server";

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { pathToFileURL } from "node:url";
import { z } from "zod";

import { DynamicToolRegistry } from "./tool-registry.ts";
import { McpAuthMiddleware, type NegotiateOptions } from "./auth-middleware.ts";
import { registerRealTools } from "./real-tools.ts";
import { MCP_SCOPES } from "./capability-types.ts";
import type { McpScope, CapabilityNegotiateRequest, NegotiationResult, SensitivityLevel } from "./capability-types.ts";
import { ResilienceOrchestrator } from "./resilience/resilience-orchestrator.ts";
import { HealthDashboard } from "./resilience/health-dashboard.ts";
import { ToolPriority, type ResilienceConfig, type ToolResilienceConfig, type ToolPriority as ToolPriorityType } from "./resilience/types.ts";
import { createRetryOrchestrator, runToolWithRetry } from "./retry-integration.ts";
import type { SecureToolDefinition } from "./tool-registry.ts";

const SERVER_NAME = "misfinanzas-mcp-server";
const SERVER_VERSION = "1.0.0";
const PROTOCOL_VERSION = "2025-06-18";

// ─── Método propio: capability/negotiate ──────────────────────
const CapabilityNegotiateSchema = z.object({
  method: z.literal("capability/negotiate"),
  params: z.object({
    requestedScopes: z.array(z.enum(MCP_SCOPES as [McpScope, ...McpScope[]])),
    clientCapabilities: z
      .object({
        supportsSchemaValidation: z.boolean().optional(),
        supportsIdempotencyKeys: z.boolean().optional(),
        supportsStreaming: z.boolean().optional(),
        maxConcurrentCalls: z.number().optional(),
      })
      .optional(),
    authToken: z.string().optional(),
    sessionContext: z
      .object({
        sessionId: z.string(),
        environment: z.enum(["dev", "staging", "production"]),
      })
      .optional(),
  }),
});

interface Session {
  scopes: McpScope[];
  restrictions: NegotiationResult["restrictions"];
}

function defaultSession(): Session {
  return {
    scopes: [],
    restrictions: { maxCallsPerMinute: 0, maxPayloadSizeBytes: 0, requireHumanApproval: [] },
  };
}

// ─── Configuración de resiliencia (MCP-02) ────────────────────
const RESILIENCE_CONFIG: ResilienceConfig = {
  circuitBreaker: {
    failureThreshold: 5,
    successThreshold: 2,
    resetTimeoutMs: 30_000,
    requestTimeoutMs: 10_000,
    errorRateThreshold: 0.5,
    errorRateWindowMs: 60_000,
    minimumRequestVolume: 10,
  },
  rateLimiter: {
    maxRequests: 60,
    windowMs: 60_000,
    algorithm: "token_bucket",
    refillRatePerSecond: 1,
    // Sin bucketCapacity global: cada herramienta deriva su bucket de su propio
    // rateLimitPerMinute (el bucket sigue al límite, no al default global).
  },
  priorityQueue: {
    maxQueueSize: 100,
    concurrency: 5,
    maxWaitTimeMs: 30_000,
    enableBackpressure: true,
  },
  // Sin fallback global: las escrituras financieras nunca deben servir datos
  // stale/deferidos. El fallback a caché se configura solo en herramientas de lectura.
  metrics: {
    enablePrometheus: false,
    logLevel: "info",
    healthCheckIntervalMs: 5_000,
  },
};

// Ajustes por herramienta real (prioridad, circuit breaker, fallback de lectura).
const TOOL_RESILIENCE: Record<string, Partial<ToolResilienceConfig>> = {
  get_balance: { priority: ToolPriority.NORMAL, fallback: { type: "cache", cacheTtlMs: 30_000 } },
  add_transaction: { priority: ToolPriority.HIGH },
  transfer_funds: {
    priority: ToolPriority.CRITICAL,
    bypassQueue: true,
    circuitBreaker: { failureThreshold: 2, resetTimeoutMs: 60_000, requestTimeoutMs: 30_000 },
  },
  scan_receipt: { priority: ToolPriority.LOW, circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 20_000, requestTimeoutMs: 15_000 } },
  parse_transfer: { priority: ToolPriority.LOW },
  drive_status: {
    priority: ToolPriority.NORMAL,
    fallback: { type: "cache", cacheTtlMs: 60_000 },
    circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 20_000, requestTimeoutMs: 30_000 },
  },
  drive_pending: {
    priority: ToolPriority.NORMAL,
    fallback: { type: "cache", cacheTtlMs: 60_000 },
    circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 20_000, requestTimeoutMs: 30_000 },
  },
  drive_sync: {
    priority: ToolPriority.BACKGROUND,
    circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 30_000, requestTimeoutMs: 180_000 },
  },
  resilience_health: { priority: ToolPriority.NORMAL, rateLimitPerMinute: 5 },
};

function defaultPriority(sensitivity: SensitivityLevel): ToolPriorityType {
  if (sensitivity === "critical") return ToolPriority.CRITICAL;
  if (sensitivity === "high") return ToolPriority.HIGH;
  if (sensitivity === "low") return ToolPriority.LOW;
  return ToolPriority.NORMAL;
}

function resilienceConfigFor(tool: SecureToolDefinition): ToolResilienceConfig {
  const overrides = TOOL_RESILIENCE[tool.name] || {};
  return {
    toolName: tool.name,
    priority: overrides.priority ?? defaultPriority(tool.sensitivity),
    rateLimitPerMinute: overrides.rateLimitPerMinute ?? tool.rateLimitPerMinute,
    circuitBreaker: overrides.circuitBreaker,
    fallback: overrides.fallback,
    bypassQueue: overrides.bypassQueue,
  };
}

export interface McpServerOptions extends NegotiateOptions {
  environment?: "dev" | "staging" | "production";
  /** Overrides de resiliencia por herramienta (para tests/despliegues). */
  resilienceOverrides?: Record<string, Partial<ToolResilienceConfig>>;
  /** Desactiva el health-check periódico (para tests deterministas). */
  disableHealthCheck?: boolean;
}

/** Construye el servidor MCP con registro de herramientas reales y middleware. */
export function createMcpServer(options: McpServerOptions = {}) {
  const registry = registerRealTools(new DynamicToolRegistry());
  const auth = new McpAuthMiddleware(registry, options);
  const environment = options.environment || "production";

  const orchestrator = new ResilienceOrchestrator({
    ...RESILIENCE_CONFIG,
    metrics: {
      ...RESILIENCE_CONFIG.metrics,
      healthCheckIntervalMs: options.disableHealthCheck ? 0 : RESILIENCE_CONFIG.metrics.healthCheckIntervalMs,
    },
  });
  const dashboard = new HealthDashboard();
  // MCP-03: capa de retry/backoff + idempotencia + budget + storm.
  const retry = createRetryOrchestrator();

  // Herramienta de admin: reporte de salud del sistema de resiliencia.
  registry.register({
    name: "resilience_health",
    description: "Reporte de salud del sistema de resiliencia: circuit breakers, rate limits, cola y errores.",
    inputSchema: { type: "object", properties: {} },
    handler: async () => dashboard.generateJsonReport(orchestrator.runHealthCheck()),
    requiredScopes: ["admin"],
    sensitivity: "low",
    requiresIdempotency: false,
    requiresHumanApproval: false,
    rateLimitPerMinute: 5,
  });

  // Registrar TODAS las herramientas del registry en el orquestador de resiliencia.
  // El handler real se envuelve con el retry layer (MCP-03): backoff + idempotencia
  // + budget + storm se aplican dentro de la ejecución.
  for (const tool of registry.listAll()) {
    const config = resilienceConfigFor(tool);
    const overrides = options.resilienceOverrides?.[tool.name];
    const merged: ToolResilienceConfig = overrides
      ? { ...config, ...overrides, toolName: tool.name }
      : config;
    orchestrator.registerTool(merged, (args, ctx) => runToolWithRetry(retry, tool, args, ctx));
  }

  // Reenviar eventos de resiliencia al dashboard para los reportes.
  orchestrator.onEvent((event) => dashboard.logEvent(event));

  const session: Session = defaultSession();

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: { listChanged: true } } }
  );

  // ─── Negociación de capabilities ────────────────────────────
  server.setRequestHandler(CapabilityNegotiateSchema, async (raw) => {
    const request: CapabilityNegotiateRequest = {
      method: "capability/negotiate",
      params: {
        requestedScopes: raw.params.requestedScopes,
        clientCapabilities: raw.params.clientCapabilities,
        authToken: raw.params.authToken,
        sessionContext: raw.params.sessionContext,
      },
    };

    const negotiationResult = await auth.handleNegotiate(request);
    session.scopes = negotiationResult.grantedScopes;
    session.restrictions = negotiationResult.restrictions;

    console.log(
      `[negotiate] scopes=${session.scopes.join(",") || "(ninguno)"} ` +
      `tools=${negotiationResult.visibleToolCount}/${negotiationResult.totalToolCount}`
    );

    return {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: raw.params.sessionContext?.sessionId,
      negotiationResult,
    };
  });

  // ─── tools/list (FILTRADO por scopes de la sesión) ──────────
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const { tools, filteredOut, total } = registry.getFilteredTools(session.scopes, {
      obfuscateSchemas: environment === "production",
      environment,
    });

    console.log(
      `[tools/list] cliente ve ${tools.length}/${total} herramientas (${filteredOut} filtradas)`
    );

    return {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
      _meta: { totalAvailable: total, filteredOut, filterReason: "capability_negotiation" },
    };
  });

  // ─── tools/call (AUTORIZADO + resiliencia + idempotencia) ──
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const meta = request.params._meta as { idempotencyKey?: string; clientId?: string } | undefined;
    const idempotencyKey = meta?.idempotencyKey || (args as Record<string, unknown> | undefined)?.idempotencyKey;
    const clientId = meta?.clientId || "mcp-client";

    const authResult = auth.authorizeToolCall(name, session.scopes, idempotencyKey as string | undefined);
    if (!authResult.authorized) {
      console.warn(`[denied] ${name}: ${authResult.reason}`);
      return { content: [{ type: "text", text: JSON.stringify({ error: "UNAUTHORIZED", message: authResult.reason }) }], isError: true };
    }

    // Replay de operación idempotente → lo resuelve el IdempotencyManager del
    // retry layer (MCP-03) dentro del handler, sin llegar a re-ejecutar.

    const tool = registry.getTool(name);
    if (!tool) {
      return { content: [{ type: "text", text: `Tool '${name}' no encontrada` }], isError: true };
    }

    // Aprobación humana para operaciones críticas (antes del orquestador:
    // una aprobación pendiente no consume tokens de rate limit).
    if (authResult.requiresApproval) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: "PENDING_APPROVAL",
            message: "Esta acción requiere aprobación humana.",
            preview: { tool: name, arguments: args, sensitivity: tool.sensitivity },
            approvalRequired: true,
          }),
        }],
      };
    }

    // ═══ Resiliencia: rate limit → circuit breaker → cola → ejecución ═══
    const result = await orchestrator.executeToolCall({
      toolName: name,
      clientId,
      args,
      idempotencyKey: idempotencyKey as string | undefined,
    });

    if (result.success) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            data: result.data,
            _meta: {
              fromCache: result._meta.fromCache,
              latencyMs: result._meta.latencyMs,
              circuitState: result._meta.circuitState,
              queuedTimeMs: result._meta.queuedTimeMs,
            },
          }),
        }],
      };
    }

    return {
      content: [{ type: "text", text: JSON.stringify({ error: result.error, _meta: result._meta }) }],
      isError: true,
      _meta: {
        retryAfterMs: result.error?.retryAfterMs,
        retryable: result.error?.retryable,
      },
    };
  });

  // Al cerrar la conexión, liberar timers del orquestador y del retry layer.
  server.onclose = () => {
    orchestrator.destroy();
    retry.destroy();
  };

  return { server, registry, auth, orchestrator, dashboard, retry };
}

/** Conecta el servidor por stdio. Devuelve la promesa de conexión. */
export async function startMcpServer(options: McpServerOptions = {}): Promise<Server> {
  const { server } = createMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.log(`[mcp] ${SERVER_NAME} v${SERVER_VERSION} listo (capability negotiation + resiliencia activas)`);
  return server;
}

// ─── Arranque solo cuando se ejecuta directo ──────────────────
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  startMcpServer().catch((e) => {
    console.error("[mcp] fatal:", e);
    process.exit(1);
  });
}