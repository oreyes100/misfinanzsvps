// server.ts — Servidor MCP "Escudo de Descubrimiento" (MCP-01).
//
// - Método propio `capability/negotiate`: token → rol → scopes → tools visibles.
// - tools/list filtrado por scopes de la sesión (con obfuscación de schemas).
// - tools/call autorizado por scopes + idempotencia + aprobación humana.
// - Rate limiting por herramienta (ventana de 60s).
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
import type { McpScope, CapabilityNegotiateRequest, NegotiationResult } from "./capability-types.ts";

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

export interface McpServerOptions extends NegotiateOptions {
  environment?: "dev" | "staging" | "production";
}

/** Construye el servidor MCP con registro de herramientas reales y middleware. */
export function createMcpServer(options: McpServerOptions = {}) {
  const registry = registerRealTools(new DynamicToolRegistry());
  const auth = new McpAuthMiddleware(registry, options);
  const environment = options.environment || "production";

  const session: Session = defaultSession();
  // Idempotencia: tool+key → último resultado (replay devuelve lo mismo).
  const idempotencyResults = new Map<string, unknown>();
  // Rate limiting: tool → timestamps de llamadas en la última ventana.
  const callLog = new Map<string, number[]>();
  const WINDOW_MS = 60_000;

  function isRateLimited(toolName: string, limit: number): boolean {
    const now = Date.now();
    const recent = (callLog.get(toolName) || []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= limit) return true;
    callLog.set(toolName, [...recent, now]);
    return false;
  }

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

  // ─── tools/call (AUTORIZADO + rate limit + idempotencia) ────
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const idempotencyKey =
      (request.params._meta as { idempotencyKey?: string } | undefined)?.idempotencyKey ||
      (args as Record<string, unknown> | undefined)?.idempotencyKey;

    const authResult = auth.authorizeToolCall(name, session.scopes, idempotencyKey as string | undefined);
    if (!authResult.authorized) {
      console.warn(`[denied] ${name}: ${authResult.reason}`);
      return { content: [{ type: "text", text: JSON.stringify({ error: "UNAUTHORIZED", message: authResult.reason }) }], isError: true };
    }

    // Replay de operación idempotente → devolver el resultado previo.
    if (idempotencyKey) {
      const cached = idempotencyResults.get(`${name}:${idempotencyKey}`);
      if (cached) return { content: [{ type: "text", text: JSON.stringify(cached) }] };
    }

    const tool = registry.getTool(name);
    if (!tool) {
      return { content: [{ type: "text", text: `Tool '${name}' no encontrada` }], isError: true };
    }

    if (isRateLimited(name, tool.rateLimitPerMinute)) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "RATE_LIMITED", message: `Límite: ${tool.rateLimitPerMinute}/min` }) }], isError: true };
    }

    // Aprobación humana para operaciones críticas.
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

    try {
      const result = await tool.handler(args);
      if (idempotencyKey) idempotencyResults.set(`${name}:${idempotencyKey}`, result);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "EXECUTION_FAILED", message: (error as Error).message }) }], isError: true };
    }
  });

  return { server, registry, auth };
}

/** Conecta el servidor por stdio. Devuelve la promesa de conexión. */
export async function startMcpServer(options: McpServerOptions = {}): Promise<Server> {
  const { server } = createMcpServer(options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.log(`[mcp] ${SERVER_NAME} v${SERVER_VERSION} listo (capability negotiation activa)`);
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
