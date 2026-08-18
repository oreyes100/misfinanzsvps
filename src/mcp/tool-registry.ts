// tool-registry.ts — Registro dinámico de herramientas con metadata de seguridad.
//
// Cada herramienta se registra con sus scopes requeridos, sensibilidad, flags de
// idempotencia/aprobación humana y rate limit. El servidor lo usa para filtrar
// tools/list y el middleware para autorizar tools/call.

import type { McpScope, SensitivityLevel, FilteredToolDefinition } from "./capability-types.ts";

export interface SecureToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (params: unknown) => Promise<unknown>;
  // ═══ Metadata de Capability Negotiation ═══
  requiredScopes: McpScope[];
  sensitivity: SensitivityLevel;
  requiresIdempotency: boolean;
  requiresHumanApproval: boolean;
  rateLimitPerMinute: number;
  // Visibilidad condicional
  visibleWhen?: (clientScopes: McpScope[], sessionContext?: unknown) => boolean;
}

export interface FilterOptions {
  obfuscateSchemas?: boolean;
  environment?: "dev" | "staging" | "production";
  sessionContext?: unknown;
}

// ─── Registro central de herramientas ─────────────────────────
export class DynamicToolRegistry {
  private tools = new Map<string, SecureToolDefinition>();
  private scopeGroups = new Map<string, Set<string>>(); // scope → tool names

  register(tool: SecureToolDefinition): void {
    this.tools.set(tool.name, tool);
    for (const scope of tool.requiredScopes) {
      if (!this.scopeGroups.has(scope)) this.scopeGroups.set(scope, new Set());
      this.scopeGroups.get(scope)!.add(tool.name);
    }
  }

  unregister(toolName: string): boolean {
    const tool = this.tools.get(toolName);
    if (!tool) return false;
    for (const scope of tool.requiredScopes) {
      this.scopeGroups.get(scope)?.delete(toolName);
    }
    return this.tools.delete(toolName);
  }

  /**
   * ═══ CORE: Filtrado dinámico por scopes ═══
   * Solo devuelve herramientas que el cliente puede ver y usar.
   */
  getFilteredTools(
    clientScopes: McpScope[],
    options?: FilterOptions
  ): { tools: FilteredToolDefinition[]; filteredOut: number; total: number } {
    const clientScopeSet = new Set(clientScopes);
    const filtered: FilteredToolDefinition[] = [];
    let filteredOut = 0;

    for (const [name, tool] of this.tools) {
      const hasAllScopes = tool.requiredScopes.every((s) => clientScopeSet.has(s));
      const isVisible = tool.visibleWhen
        ? tool.visibleWhen(clientScopes, options?.sessionContext)
        : true;

      if (!hasAllScopes || !isVisible) {
        filteredOut++;
        continue;
      }

      const filteredTool: FilteredToolDefinition = {
        name: tool.name,
        description: tool.description,
        inputSchema: options?.obfuscateSchemas
          ? this.obfuscateSchema(tool.inputSchema, clientScopes)
          : tool.inputSchema,
        _capability: {
          requiredScopes: tool.requiredScopes,
          sensitivity: tool.sensitivity,
          requiresIdempotency: tool.requiresIdempotency,
          requiresHumanApproval: tool.requiresHumanApproval,
          rateLimitPerMinute: tool.rateLimitPerMinute,
          schemaObfuscated: options?.obfuscateSchemas
            ? Boolean((tool.inputSchema as any)._obfuscationNotice ||
              (tool.inputSchema as any).properties &&
              Object.values((tool.inputSchema as any).properties || {}).some((f: any) =>
                (f.sensitivity === "high" || f.sensitivity === "critical") && !clientScopes.includes("admin")
              ))
            : false,
        },
      };

      filtered.push(filteredTool);
    }

    return { tools: filtered, filteredOut, total: this.tools.size };
  }

  /**
   * Obfusca parcialmente el schema: los campos marcados como sensibles
   * (sensitivity high/critical) se redactan salvo que el cliente tenga scope
   * admin. El aviso _obfuscationNotice indica que hubo redacción.
   */
  private obfuscateSchema(
    schema: Record<string, unknown>,
    clientScopes: McpScope[]
  ): Record<string, unknown> {
    const properties = (schema.properties as Record<string, any>) || {};
    const hasAdmin = clientScopes.includes("admin");
    const obfuscatedProperties: Record<string, unknown> = {};
    let redacted = false;

    for (const [key, value] of Object.entries(properties)) {
      const field = value as any;
      const sensitive = field?.sensitivity === "high" || field?.sensitivity === "critical";
      if (sensitive && !hasAdmin) {
        redacted = true;
        obfuscatedProperties[key] = {
          type: field.type || "string",
          description: "[REDACTED - requiere scope admin]",
        };
      } else {
        obfuscatedProperties[key] = field;
      }
    }

    const out: Record<string, unknown> = { ...schema, properties: obfuscatedProperties };
    if (redacted) {
      out._obfuscationNotice =
        "Algunos campos están ocultos. Solicita scopes adicionales para ver el schema completo.";
    }
    return out;
  }

  getTool(name: string): SecureToolDefinition | undefined {
    return this.tools.get(name);
  }

  listAll(): SecureToolDefinition[] {
    return Array.from(this.tools.values());
  }

  /** Herramientas visibles según scopes (para debug/informes). */
  namesFor(clientScopes: McpScope[]): string[] {
    return this.getFilteredTools(clientScopes).tools.map((t) => t.name);
  }
}
