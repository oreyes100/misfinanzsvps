// client.ts — Cliente MCP que negocia capabilities al conectarse.
//
// 1. Conecta por stdio al servidor.
// 2. Envía `capability/negotiate` con los scopes solicitados + token.
// 3. Lista SOLO las herramientas visibles tras la negociación.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { MCP_SCOPES } from "./capability-types.ts";
import type { McpScope, CapabilityNegotiateResponse, SensitivityLevel } from "./capability-types.ts";

const NegotiateResponseSchema = z.object({
  protocolVersion: z.string(),
  sessionId: z.string().optional(),
  negotiationResult: z.object({
    grantedScopes: z.array(z.enum(MCP_SCOPES as [McpScope, ...McpScope[]])),
    deniedScopes: z.array(
      z.object({ scope: z.enum(MCP_SCOPES as [McpScope, ...McpScope[]]), reason: z.enum(["insufficient_auth", "not_supported", "rate_limited"]) })
    ),
    visibleToolCount: z.number(),
    totalToolCount: z.number(),
    restrictions: z.object({
      maxCallsPerMinute: z.number(),
      maxPayloadSizeBytes: z.number(),
      requireHumanApproval: z.array(z.string()),
    }),
  }),
});

export { NegotiateResponseSchema };

export interface NegotiatedClient {
  client: Client;
  grantedScopes: McpScope[];
  deniedScopes: { scope: McpScope; reason: string }[];
  visibleTools: string[];
  totalTools: number;
  restrictions: CapabilityNegotiateResponse["negotiationResult"]["restrictions"];
}

export interface ClientOptions {
  requestedScopes: McpScope[];
  authToken?: string;
  clientName?: string;
  serverCommand?: string;
  serverArgs?: string[];
  sessionContext?: { sessionId: string; environment: "dev" | "staging" | "production" };
}

const DEFAULT_SERVER = fileURLToPath(new URL("./server.ts", import.meta.url));

/**
 * Negocia capabilities sobre un cliente MCP ya conectado y lista las
 * herramientas visibles. Usable con cualquier transporte (stdio, in-memory).
 */
export async function negotiateWithClient(
  client: Client,
  options: ClientOptions
): Promise<NegotiatedClient> {
  const result = await client.request(
    {
      method: "capability/negotiate",
      params: {
        requestedScopes: options.requestedScopes,
        clientCapabilities: {
          supportsSchemaValidation: true,
          supportsIdempotencyKeys: true,
          supportsStreaming: false,
          maxConcurrentCalls: 5,
        },
        authToken: options.authToken,
        sessionContext: options.sessionContext,
      },
    },
    NegotiateResponseSchema
  );

  const { grantedScopes, deniedScopes, visibleToolCount, totalToolCount, restrictions } = result.negotiationResult;

  const toolsResult = await client.listTools();
  const visibleTools = toolsResult.tools.map((t) => t.name);

  console.log(`[client] scopes otorgados: ${grantedScopes.join(", ") || "(ninguno)"}`);
  console.log(`[client] herramientas visibles: ${visibleTools.join(", ")}`);
  console.log(`[client] visibilidad: ${visibleTools.length}/${totalToolCount} (${totalToolCount - visibleToolCount} ocultas)`);

  return {
    client,
    grantedScopes,
    deniedScopes,
    visibleTools,
    totalTools: totalToolCount,
    restrictions: restrictions as unknown as NegotiatedClient["restrictions"],
  };
}

/**
 * Conecta por stdio, negocia capabilities y lista las herramientas visibles.
 */
export async function createNegotiatedMcpClient(options: ClientOptions): Promise<NegotiatedClient> {
  const clientName = options.clientName || "misfinanzas-client";

  const transport = new StdioClientTransport({
    command: options.serverCommand || process.execPath,
    args: options.serverArgs || [DEFAULT_SERVER],
  });

  const client = new Client({ name: clientName, version: "1.0.0" });
  await client.connect(transport);

  return negotiateWithClient(client, options);
}
