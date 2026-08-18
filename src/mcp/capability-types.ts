// capability-types.ts — Extensión del protocolo MCP para Capability Negotiation.
//
// El handshake estándar de MCP se hace en "initialize". Aquí se añade un método
// propio "capability/negotiate" (ver server.ts) que cumple el mismo propósito sin
// pelear con el validador de schema del SDK. Estos tipos son la especificación
// compartida entre servidor y cliente.

// ─── Scopes disponibles ───────────────────────────────────────
export type McpScope =
  | "read"          // Solo lectura de recursos
  | "write"         // Escritura de archivos/datos
  | "execute"       // Ejecución de código/comandos
  | "finance"       // Operaciones financieras
  | "admin"         // Administración del sistema
  | "superadmin"    // Control total
  | "ocr"           // Procesamiento OCR
  | "drive"         // Acceso a almacenamiento
  | "ai_agent";     // Orquestación de agentes IA

export const MCP_SCOPES: McpScope[] = [
  "read", "write", "execute", "finance", "admin",
  "superadmin", "ocr", "drive", "ai_agent",
];

// ─── Sensibilidad de la herramienta ───────────────────────────
export type SensitivityLevel = "low" | "medium" | "high" | "critical";

// ─── Solicitud de negociación (cliente → servidor) ────────────
export interface CapabilityNegotiateRequest {
  method: "capability/negotiate";
  params: {
    requestedScopes: McpScope[];
    clientCapabilities?: {
      supportsSchemaValidation?: boolean;
      supportsIdempotencyKeys?: boolean;
      supportsStreaming?: boolean;
      maxConcurrentCalls?: number;
    };
    authToken?: string;
    sessionContext?: {
      sessionId: string;
      environment: "dev" | "staging" | "production";
    };
  };
}

// ─── Resultado de la negociación (servidor → cliente) ─────────
export interface NegotiationResult {
  grantedScopes: McpScope[];
  deniedScopes: {
    scope: McpScope;
    reason: "insufficient_auth" | "not_supported" | "rate_limited";
  }[];
  visibleToolCount: number;
  totalToolCount: number;
  restrictions: {
    maxCallsPerMinute: number;
    maxPayloadSizeBytes: number;
    requireHumanApproval: SensitivityLevel[];
  };
}

export interface CapabilityNegotiateResponse {
  protocolVersion: string;
  sessionId?: string;
  negotiationResult: NegotiationResult;
}

// ─── Definición de herramienta filtrada (tools/list) ──────────
export interface FilteredToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  _capability: {
    requiredScopes: McpScope[];
    sensitivity: SensitivityLevel;
    requiresIdempotency: boolean;
    requiresHumanApproval: boolean;
    rateLimitPerMinute: number;
    schemaObfuscated: boolean;
  };
}

export interface FilteredToolsListResponse {
  tools: FilteredToolDefinition[];
  _meta: {
    totalAvailable: number;
    filteredOut: number;
    filterReason: string;
    nextCursor?: string;
  };
}
