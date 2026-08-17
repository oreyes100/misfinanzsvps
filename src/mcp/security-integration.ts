// security-integration.ts — Integración del sistema de seguridad MCP-04 con las
// herramientas reales de Mis Finanzas.
//
// Conecta el "Cortafuegos de Semántica" en la capa de ejecución del servidor:
// cada handler real se envuelve con `runToolWithSecurity`, que aplica:
//   - Supply Chain Integrity (schema registrado + hash SHA-256 + firma Ed25519)
//   - Schema Validation (tipos, límites, inyecciones SQL/cmd/prompt/path/XSS)
//   - Params size/depth (anti "billion laughs")
//   - Human-in-the-Loop (defensa en profundidad; el auth layer emite PENDING_APPROVAL)
//   - Sandbox (timeout duro por tool según permisos registrados)
//
// Diferencia con la propuesta: NO hay wrappers con datos mock
// (`secureTransfer`/`secureOcrScan`/`secureDriveRead`). En su lugar se expone
// `runToolWithSecurity(security, tool, args, ctx, inner)`, que envuelve el
// handler real (que a su vez incluye el retry layer MCP-03). Los schemas
// registrados se derivan de real-tools.ts (sin drift ni invención).

import { SecurityOrchestrator } from "./security/security-orchestrator.ts";
import type { SecurityConfig, SecurityEvent, SensitivityLevel } from "./security/security-types.ts";
import { DynamicToolRegistry } from "./tool-registry.ts";
import { registerRealTools } from "./real-tools.ts";
import type { SecureToolDefinition } from "./tool-registry.ts";
import type { ToolCallContext } from "./retry-integration.ts";

const MB = 1024 * 1024;

// ─── Configuración de seguridad para misfinanzsvps ────────────
export const MISFINANZAS_SECURITY_CONFIG: SecurityConfig = {
  schemaValidation: {
    strictMode: true,
    rejectAdditionalProperties: true,
    // Techo absoluto por string: admite imageBase64 (OCR) sin dejar campos
    // ilimitados. Los límites finos (maxLength/enum) viven en cada schema.
    maxParamStringLength: 8 * MB,
    maxArrayLength: 1000,
    detectInjectionPatterns: true,
  },
  sandbox: {
    maxExecutionTimeMs: 30_000,
    maxMemoryBytes: 128 * MB,
    networkAllowlist: [],
    allowFileSystem: false,
    allowedDirectories: [],
    isolateGlobalContext: true,
    maxObjectDepth: 10,
    maxParamsSizeBytes: 10 * MB, // admite base64 de recibos (OCR)
  },
  humanInTheLoop: {
    enabled: true,
    approvalThreshold: "high",
    twoFactorThreshold: "critical",
    approvalTimeoutMs: 300_000,
    requireSignature: true,
    approvalMethods: ["button", "voice", "biometric"],
    auditLog: {
      enabled: true,
      storage: "memory", // servidor stdio en Node: sin localStorage
      maxEntries: 500,
    },
  },
  supplyChain: {
    enabled: true,
    hashAlgorithm: "sha256",
    signatureAlgorithm: "ed25519",
    allowUnregisteredInDev: true,
    reVerificationIntervalMs: 3_600_000,
    onVerificationFailure: "reject",
  },
  logging: {
    level: "info",
    logAllValidations: false,
    logBlockedRequests: true,
    logApprovals: true,
    redactSensitiveData: true,
  },
};

// ─── Permisos por tool real (sandbox timeouts alineados con MCP-02) ───
interface DefaultPermissions {
  requiredScopes: string[];
  networkAccess: string[];
  fileSystemAccess: "none" | "read" | "write" | "readwrite";
  maxExecutionTimeMs: number;
  maxMemoryBytes: number;
  requiresHumanApproval: boolean;
  allowedEnvironments: ("dev" | "staging" | "production")[];
}

const PERMISSIONS_BY_TOOL: Record<string, DefaultPermissions> = {
  get_balance: {
    requiredScopes: ["read"], networkAccess: [], fileSystemAccess: "none",
    maxExecutionTimeMs: 10_000, maxMemoryBytes: 16 * MB, requiresHumanApproval: false,
    allowedEnvironments: ["dev", "staging", "production"],
  },
  add_transaction: {
    requiredScopes: ["read", "write"], networkAccess: [], fileSystemAccess: "none",
    maxExecutionTimeMs: 10_000, maxMemoryBytes: 32 * MB, requiresHumanApproval: false,
    allowedEnvironments: ["dev", "staging", "production"],
  },
  transfer_funds: {
    requiredScopes: ["read", "write", "finance"], networkAccess: [], fileSystemAccess: "none",
    maxExecutionTimeMs: 30_000, maxMemoryBytes: 64 * MB, requiresHumanApproval: true,
    allowedEnvironments: ["production"],
  },
  scan_receipt: {
    requiredScopes: ["read", "ocr"], networkAccess: [], fileSystemAccess: "none",
    maxExecutionTimeMs: 30_000, maxMemoryBytes: 128 * MB, requiresHumanApproval: false,
    allowedEnvironments: ["dev", "staging", "production"],
  },
  parse_transfer: {
    requiredScopes: ["read", "ocr"], networkAccess: [], fileSystemAccess: "none",
    maxExecutionTimeMs: 10_000, maxMemoryBytes: 64 * MB, requiresHumanApproval: false,
    allowedEnvironments: ["dev", "staging", "production"],
  },
  drive_status: {
    requiredScopes: ["read", "drive"], networkAccess: [], fileSystemAccess: "none",
    maxExecutionTimeMs: 10_000, maxMemoryBytes: 32 * MB, requiresHumanApproval: false,
    allowedEnvironments: ["dev", "staging", "production"],
  },
  drive_pending: {
    requiredScopes: ["read", "drive"], networkAccess: [], fileSystemAccess: "none",
    maxExecutionTimeMs: 10_000, maxMemoryBytes: 32 * MB, requiresHumanApproval: false,
    allowedEnvironments: ["dev", "staging", "production"],
  },
  drive_sync: {
    requiredScopes: ["read", "write", "drive"], networkAccess: [], fileSystemAccess: "none",
    // El sync es largo (resilience le da 180s): el sandbox no debe cortarlo.
    maxExecutionTimeMs: 200_000, maxMemoryBytes: 128 * MB, requiresHumanApproval: true,
    allowedEnvironments: ["dev", "staging", "production"],
  },
  resilience_health: {
    requiredScopes: ["admin"], networkAccess: [], fileSystemAccess: "none",
    maxExecutionTimeMs: 10_000, maxMemoryBytes: 16 * MB, requiresHumanApproval: false,
    allowedEnvironments: ["dev", "staging", "production"],
  },
};

/**
 * Factory del orquestador de seguridad con la configuración de Mis Finanzas y
 * los schemas de las tools reales. Se crea UNO por instancia de servidor.
 */
export function createSecurityOrchestrator(): SecurityOrchestrator {
  const security = new SecurityOrchestrator(MISFINANZAS_SECURITY_CONFIG, (event) => logSecurityEvent(event));
  registerDefaultSchemas(security);
  return security;
}

/**
 * Registrar los schemas de las tools reales. Se derivan de real-tools.ts
 * (fuente única): el schema registrado ES el inputSchema de la tool.
 * `resilience_health` se añade porque no vive en registerRealTools.
 */
function registerDefaultSchemas(security: SecurityOrchestrator): void {
  const registry = registerRealTools(new DynamicToolRegistry());

  for (const tool of registry.listAll()) {
    security.registerSchema({
      toolName: tool.name,
      version: "1.0.0",
      schema: tool.inputSchema,
      sensitivity: tool.sensitivity,
      permissions: PERMISSIONS_BY_TOOL[tool.name],
    });
  }

  security.registerSchema({
    toolName: "resilience_health",
    version: "1.0.0",
    schema: { type: "object", properties: {} },
    sensitivity: "low",
    permissions: PERMISSIONS_BY_TOOL.resilience_health,
  });
}

/**
 * ═══ CORE: Ejecutar una tool real con seguridad completa ═══
 *
 * Uso en server.ts:
 *   orchestrator.registerTool(merged, (args, ctx) =>
 *     runToolWithSecurity(security, tool, args, ctx,
 *       (sanitized) => runToolWithRetry(retry, tool, sanitized, ctx))
 *   );
 *
 * Orden: validación de seguridad ANTES del retry (un parámetro inválido o
 * inyectado no debe reintentarse). Si la validación falla, se lanza un Error
 * `CODE: message` que el ResilienceOrchestrator clasifica y devuelve al cliente.
 */
export async function runToolWithSecurity(
  security: SecurityOrchestrator,
  tool: SecureToolDefinition,
  args: unknown,
  ctx: ToolCallContext | undefined,
  inner: (sanitized: Record<string, unknown>) => Promise<unknown>
): Promise<unknown> {
  const raw = (args ?? {}) as Record<string, unknown>;
  // Campos de control del protocolo no son parámetros del tool (idempotencyKey
  // viaja por _meta o por args; se excluyen para no romper additionalProperties).
  const { idempotencyKey: _ctrlKey, clientId: _ctrlClient, ...toolParams } = raw;

  const schema = security.getSchemaRegistry().getSchema(tool.name)?.schema ?? tool.inputSchema;

  const result = await security.executeSecureToolCall({
    toolName: tool.name,
    toolParams,
    toolSchema: schema,
    sensitivity: tool.sensitivity,
    requestedBy: ctx?.clientId || "mcp-client",
    handler: (sanitized) => inner(sanitized),
    onApprovalRequired: async () => {
      // El servidor stdio no tiene UI para aprobar: la capa de auth ya emite
      // PENDING_APPROVAL antes de llegar aquí. El gate HITL queda como defensa
      // en profundidad (fail-closed): si una tool sensible llega hasta aquí,
      // se niega. La integración frontend (Assistant/Modals) usará el gate con
      // onApprovalRequired conectado a la previsualización.
      return false;
    },
  });

  if (result.success) return result.data;

  const err = result.error || { code: "SECURITY_FAILED", message: "Fallo de seguridad desconocido" };
  throw new Error(`${err.code}: ${err.message}`);
}

// ─── Logging de eventos de seguridad ──────────────────────────
function logSecurityEvent(event: SecurityEvent): void {
  const timestamp = new Date().toISOString().slice(11, 19);

  switch (event.type) {
    case "schema_validation_failed":
      console.warn(`[${timestamp}] ⚠️ Validación fallida: ${event.tool} (${event.errors.length} errores)`);
      break;
    case "injection_detected":
      console.error(`[${timestamp}] 🚨 INYECCIÓN DETECTADA: ${event.tool} en '${event.paramPath}'`);
      break;
    case "schema_tampered":
      console.error(
        `[${timestamp}] 🚨 SCHEMA MANIPULADO: ${event.tool} ` +
        `(esperado: ${event.expectedHash.slice(0, 12)}… recibido: ${event.actualHash.slice(0, 12)}…)`
      );
      break;
    case "unregistered_schema":
      console.error(`[${timestamp}] 🚨 SCHEMA NO REGISTRADO: ${event.tool}`);
      break;
    case "sandbox_timeout":
      console.warn(`[${timestamp}] ⏱️ Sandbox timeout: ${event.tool} (${event.executionTimeMs}ms)`);
      break;
    case "network_blocked":
      console.warn(`[${timestamp}] 🚫 Red bloqueada: ${event.tool} → ${event.domain}`);
      break;
    case "approval_requested":
      console.log(`[${timestamp}] 🔐 Aprobación solicitada: ${event.tool} (${event.sensitivity})`);
      break;
    case "approval_granted":
      console.log(`[${timestamp}] ✅ Aprobación concedida: ${event.tool} por ${event.approvedBy}`);
      break;
    case "approval_rejected":
      console.warn(`[${timestamp}] ❌ Aprobación rechazada: ${event.tool} por ${event.rejectedBy}`);
      break;
    default:
      break;
  }
}