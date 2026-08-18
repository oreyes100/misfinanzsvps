// auth-middleware.ts — Autorización RBAC + negociación de scopes.
//
// Roles → scopes → herramientas visibles. Todo tool call pasa por authorizeToolCall
// antes de ejecutarse: scopes, idempotencia y aprobación humana.

import type { McpScope, CapabilityNegotiateRequest, NegotiationResult, SensitivityLevel } from "./capability-types.ts";
import { DynamicToolRegistry } from "./tool-registry.ts";

interface RoleDefinition {
  name: string;
  scopes: McpScope[];
  maxCallsPerMinute: number;
  canEscalate: boolean;
}

export const DEFAULT_ROLES: Record<string, RoleDefinition> = {
  viewer: {
    name: "viewer",
    scopes: ["read"],
    maxCallsPerMinute: 30,
    canEscalate: false,
  },
  operator: {
    name: "operator",
    scopes: ["read", "write", "ocr", "drive"],
    maxCallsPerMinute: 60,
    canEscalate: false,
  },
  agent: {
    name: "agent",
    scopes: ["read", "write", "execute", "ai_agent", "ocr", "drive"],
    maxCallsPerMinute: 100,
    canEscalate: true,
  },
  finance: {
    name: "finance",
    scopes: ["read", "write", "finance", "drive"],
    maxCallsPerMinute: 50,
    canEscalate: true,
  },
  admin: {
    name: "admin",
    scopes: ["read", "write", "execute", "finance", "admin", "ocr", "drive", "ai_agent"],
    maxCallsPerMinute: 200,
    canEscalate: true,
  },
};

interface AuthTokenPayload {
  role?: string;
  sub?: string;
  [key: string]: unknown;
}

export interface NegotiateOptions {
  roles?: Record<string, RoleDefinition>;
  requireHumanApprovalFor?: SensitivityLevel[];
  maxPayloadSizeBytes?: number;
  environment?: "dev" | "staging" | "production";
}

// ─── Middleware de autorización ───────────────────────────────
export class McpAuthMiddleware {
  private registry: DynamicToolRegistry;
  private roles: Record<string, RoleDefinition>;
  private requireHumanApprovalFor: SensitivityLevel[];
  private maxPayloadSizeBytes: number;

  constructor(registry: DynamicToolRegistry, options?: NegotiateOptions) {
    this.registry = registry;
    this.roles = options?.roles || DEFAULT_ROLES;
    this.requireHumanApprovalFor = options?.requireHumanApprovalFor || ["critical"];
    this.maxPayloadSizeBytes = options?.maxPayloadSizeBytes || 10 * 1024 * 1024;
  }

  /**
   * ═══ CORE: Negocia scopes con la solicitud del cliente.
   * Token → rol → intersección(requeridos, permitidos) → herramientas visibles.
   */
  async handleNegotiate(
    request: CapabilityNegotiateRequest
  ): Promise<NegotiationResult> {
    const { requestedScopes, authToken, sessionContext } = request.params;

    const authResult = await this.validateAuthToken(authToken);
    if (!authResult.valid) {
      return this.deniedResult(requestedScopes, "insufficient_auth");
    }

    const role = this.roles[authResult.role || "viewer"] || this.roles.viewer;
    const grantedScopes = this.negotiateScopes(requestedScopes, role.scopes);

    const { total, tools: visibleTools } = this.registry.getFilteredTools(grantedScopes, {
      obfuscateSchemas: this.envOf(sessionContext) === "production",
      environment: this.envOf(sessionContext),
      sessionContext,
    });

    return {
      grantedScopes,
      deniedScopes: requestedScopes
        .filter((s) => !grantedScopes.includes(s))
        .map((s) => ({ scope: s, reason: "insufficient_auth" as const })),
      visibleToolCount: visibleTools.length,
      totalToolCount: total,
      restrictions: {
        maxCallsPerMinute: role.maxCallsPerMinute,
        maxPayloadSizeBytes: this.maxPayloadSizeBytes,
        requireHumanApproval: this.requireHumanApprovalFor,
      },
    };
  }

  /**
   * ═══ CORE: Intersección entre lo solicitado y lo permitido por rol.
   */
  private negotiateScopes(requested: McpScope[], allowed: McpScope[]): McpScope[] {
    const allowedSet = new Set(allowed);
    return requested.filter((s) => allowedSet.has(s));
  }

  /**
   * Valida el token y extrae el rol.
   * El token es un JSON base64 con { sub, role }; en producción se debe
   * sustituir por jwt.verify(token, JWT_SECRET).
   */
  private async validateAuthToken(token?: string): Promise<{ valid: boolean; role: string; userId?: string }> {
    if (!token) return { valid: false, role: "viewer" };
    try {
      const decoded = JSON.parse(Buffer.from(token, "base64").toString("utf8")) as AuthTokenPayload;
      return { valid: true, role: decoded.role || "viewer", userId: decoded.sub };
    } catch {
      return { valid: false, role: "viewer" };
    }
  }

  /**
   * Autoriza un tool call concreto: scopes → idempotencia → aprobación humana.
   */
  authorizeToolCall(
    toolName: string,
    clientScopes: McpScope[],
    idempotencyKey?: string
  ): { authorized: boolean; reason?: string; requiresApproval?: boolean } {
    const tool = this.registry.getTool(toolName);
    if (!tool) {
      return { authorized: false, reason: `Herramienta '${toolName}' no existe` };
    }

    const hasScopes = tool.requiredScopes.every((s) => clientScopes.includes(s));
    if (!hasScopes) {
      return {
        authorized: false,
        reason: `Scopes insuficientes. Requiere: ${tool.requiredScopes.join(", ")}`,
      };
    }

    if (tool.requiresIdempotency && !idempotencyKey) {
      return {
        authorized: false,
        reason: "Se requiere Idempotency-Key para esta operación",
      };
    }

    const requiresApproval =
      tool.requiresHumanApproval || this.requireHumanApprovalFor.includes(tool.sensitivity);

    return { authorized: true, requiresApproval };
  }

  private deniedResult(
    requested: McpScope[],
    reason: "insufficient_auth"
  ): NegotiationResult {
    return {
      grantedScopes: [],
      deniedScopes: requested.map((s) => ({ scope: s, reason })),
      visibleToolCount: 0,
      totalToolCount: this.registry.listAll().length,
      restrictions: {
        maxCallsPerMinute: 0,
        maxPayloadSizeBytes: 0,
        requireHumanApproval: ["low", "medium", "high", "critical"],
      },
    };
  }

  private envOf(context?: { environment?: "dev" | "staging" | "production" }): "dev" | "staging" | "production" {
    return context?.environment || "production";
  }
}
