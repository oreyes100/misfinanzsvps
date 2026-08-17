// security-orchestrator.ts — Orquestador de seguridad MCP-04: integra todas las
// capas en un solo punto de entrada.
//
//   1. Supply Chain Integrity → schema registrado + hash + firma
//   2. Schema Validation      → tipos, límites, inyecciones
//   3. Params size/depth      → anti "billion laughs"
//   4. Human-in-the-Loop      → aprobación para acciones sensibles
//   5. Sandbox                → timeout duro de ejecución
//
// Flujo: Tool Call → Verify Schema → Validate Params → Check HITL → Sandbox Execute.

import { SchemaValidator } from "./schema-validator.ts";
import { SchemaRegistry } from "./schema-registry.ts";
import { ExecutionSandbox } from "./sandbox.ts";
import { HumanInTheLoopGate } from "./human-in-the-loop.ts";
import type {
  SecurityConfig,
  SecurityEvent,
  SensitivityLevel,
  SchemaValidationResult,
  ApprovalRequest,
} from "./security-types.ts";

export class SecurityOrchestrator {
  private readonly config: SecurityConfig;
  private schemaValidator: SchemaValidator;
  private schemaRegistry: SchemaRegistry;
  private sandbox: ExecutionSandbox;
  private hitlGate: HumanInTheLoopGate;
  private eventListeners: ((event: SecurityEvent) => void)[] = [];

  constructor(config: SecurityConfig, eventHandler?: (event: SecurityEvent) => void) {
    this.config = config;
    if (eventHandler) this.eventListeners.push(eventHandler);
    this.schemaValidator = new SchemaValidator(config.schemaValidation);
    this.schemaRegistry = new SchemaRegistry(config.supplyChain, (event) => this.emitEvent(event));
    this.sandbox = new ExecutionSandbox(config.sandbox, (event) => this.emitEvent(event));
    this.hitlGate = new HumanInTheLoopGate(config.humanInTheLoop, (event) => this.emitEvent(event));
  }

  /** ═══ CORE: Ejecutar un tool call con seguridad completa ═══ */
  async executeSecureToolCall<T>(params: {
    toolName: string;
    toolParams: Record<string, unknown>;
    toolSchema: Record<string, unknown>;
    sensitivity: SensitivityLevel;
    requestedBy: string;
    handler: (sanitizedParams: Record<string, unknown>) => Promise<T>;
    onApprovalRequired?: (request: ApprovalRequest) => Promise<boolean>;
  }): Promise<{
    success: boolean;
    data?: T;
    error?: { code: string; message: string };
    _meta: {
      validationTimeMs: number;
      approvalRequired: boolean;
      approvalGranted?: boolean;
      sandboxExecutionTimeMs: number;
      securityChecksPassed: number;
    };
  }> {
    const { toolName, toolParams, toolSchema, sensitivity, requestedBy, handler, onApprovalRequired } = params;
    const startTime = Date.now();
    let securityChecksPassed = 0;

    // ─── PASO 1: Supply Chain Integrity ────────────────────────
    const schemaCheck = this.schemaRegistry.verify(toolName, toolSchema);
    if (!schemaCheck.valid) {
      return {
        success: false,
        error: { code: "SUPPLY_CHAIN_FAILED", message: schemaCheck.reason || "Verificación de schema fallida" },
        _meta: { validationTimeMs: Date.now() - startTime, approvalRequired: false, sandboxExecutionTimeMs: 0, securityChecksPassed },
      };
    }
    securityChecksPassed++;

    // ─── PASO 2: Validar Schema y Parámetros ──────────────────
    const validation: SchemaValidationResult = this.schemaValidator.validate(toolName, toolParams, toolSchema);

    if (!validation.valid) {
      for (const err of validation.errors) {
        if (err.code === "INJECTION_DETECTED") {
          this.emitEvent({
            type: "injection_detected",
            tool: toolName,
            paramPath: err.path,
            pattern: err.message,
          });
        }
      }
      this.emitEvent({ type: "schema_validation_failed", tool: toolName, errors: validation.errors });

      return {
        success: false,
        error: {
          code: "SCHEMA_VALIDATION_FAILED",
          message: `Validación fallida: ${validation.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`,
        },
        _meta: { validationTimeMs: validation.metadata.validationTimeMs, approvalRequired: false, sandboxExecutionTimeMs: 0, securityChecksPassed },
      };
    }

    this.emitEvent({ type: "schema_validation_passed", tool: toolName, validationTimeMs: validation.metadata.validationTimeMs });
    securityChecksPassed++;

    const cleanParams = validation.sanitizedParams || toolParams;

    // ─── PASO 3: Tamaño y profundidad de parámetros ───────────
    const sizeCheck = this.sandbox.validateParamsSize(cleanParams);
    if (!sizeCheck.valid) {
      return {
        success: false,
        error: {
          code: "PARAMS_SIZE_EXCEEDED",
          message: `Parámetros exceden el tamaño máximo (${sizeCheck.actualSize} > ${sizeCheck.maxSize} bytes)`,
        },
        _meta: { validationTimeMs: Date.now() - startTime, approvalRequired: false, sandboxExecutionTimeMs: 0, securityChecksPassed },
      };
    }

    const depthCheck = this.sandbox.validateObjectDepth(cleanParams);
    if (!depthCheck.valid) {
      return {
        success: false,
        error: {
          code: "OBJECT_DEPTH_EXCEEDED",
          message: `Profundidad de objeto excede el límite (${depthCheck.maxDepthReached})`,
        },
        _meta: { validationTimeMs: Date.now() - startTime, approvalRequired: false, sandboxExecutionTimeMs: 0, securityChecksPassed },
      };
    }
    securityChecksPassed++;

    // ─── PASO 4: Human-in-the-Loop ────────────────────────────
    let approvalGranted: boolean | undefined;
    const approvalRequired = this.hitlGate.requiresApproval(sensitivity);

    if (approvalRequired) {
      const approvalRequest = this.hitlGate.createApprovalRequest({
        toolName,
        toolParams: cleanParams,
        sensitivity,
        requestedBy,
        preview: {
          description: `Ejecutar '${toolName}' con sensibilidad ${sensitivity}`,
          impact: this.describeImpact(sensitivity),
          reversible: sensitivity !== "critical",
          affectedResources: this.extractAffectedResources(cleanParams),
        },
      });

      approvalGranted = onApprovalRequired
        ? await onApprovalRequired(approvalRequest)
        : await this.hitlGate.waitForApproval(approvalRequest.id);

      if (!approvalGranted) {
        return {
          success: false,
          error: { code: "APPROVAL_DENIED", message: `Aprobación denegada para '${toolName}'` },
          _meta: { validationTimeMs: Date.now() - startTime, approvalRequired: true, approvalGranted: false, sandboxExecutionTimeMs: 0, securityChecksPassed },
        };
      }
      securityChecksPassed++;
    }

    // ─── PASO 5: Ejecutar en Sandbox ──────────────────────────
    const sandboxStartTime = Date.now();
    const executionId = `exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    try {
      // El timeout del sandbox lo dicta el schema registrado (supply chain),
      // con el global como suelo. drive_sync (200s) no debe cortarse a 30s.
      const perToolTimeout = schemaCheck.registeredSchema?.permissions.maxExecutionTimeMs;
      const result = await this.sandbox.execute(
        toolName,
        executionId,
        () => handler(cleanParams),
        perToolTimeout
      );

      return {
        success: true,
        data: result,
        _meta: {
          validationTimeMs: validation.metadata.validationTimeMs,
          approvalRequired,
          approvalGranted,
          sandboxExecutionTimeMs: Date.now() - sandboxStartTime,
          securityChecksPassed,
        },
      };
    } catch (error) {
      return {
        success: false,
        error: { code: "EXECUTION_FAILED", message: (error as Error).message },
        _meta: {
          validationTimeMs: validation.metadata.validationTimeMs,
          approvalRequired,
          approvalGranted,
          sandboxExecutionTimeMs: Date.now() - sandboxStartTime,
          securityChecksPassed,
        },
      };
    }
  }

  /** Registrar un schema en el registry. */
  registerSchema(params: {
    toolName: string;
    version: string;
    schema: Record<string, unknown>;
    sensitivity: SensitivityLevel;
    permissions: {
      requiredScopes: string[];
      networkAccess: string[];
      fileSystemAccess: "none" | "read" | "write" | "readwrite";
      maxExecutionTimeMs: number;
      maxMemoryBytes: number;
      requiresHumanApproval: boolean;
      allowedEnvironments: ("dev" | "staging" | "production")[];
    };
  }): void {
    this.schemaRegistry.register({
      toolName: params.toolName,
      version: params.version,
      schema: params.schema,
      sensitivity: params.sensitivity,
      registeredBy: "system",
      permissions: params.permissions,
    });
  }

  private describeImpact(sensitivity: SensitivityLevel): string {
    switch (sensitivity) {
      case "low": return "Sin impacto significativo";
      case "medium": return "Acceso a datos privados";
      case "high": return "Modificación de datos";
      case "critical": return "Operación financiera o destructiva irreversible";
    }
  }

  private extractAffectedResources(params: Record<string, unknown>): string[] {
    const resources: string[] = [];
    const resourceKeys = ["accountId", "fromAccountId", "toAccountId", "syncCode", "transactionId"];
    for (const key of resourceKeys) {
      if (params[key] !== undefined && params[key] !== null) resources.push(`${key}: ${String(params[key])}`);
    }
    return resources;
  }

  onEvent(listener: (event: SecurityEvent) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      this.eventListeners = this.eventListeners.filter((l) => l !== listener);
    };
  }

  private emitEvent(event: SecurityEvent): void {
    for (const listener of this.eventListeners) listener(event);
  }

  getHitlGate(): HumanInTheLoopGate {
    return this.hitlGate;
  }

  getSchemaRegistry(): SchemaRegistry {
    return this.schemaRegistry;
  }

  getSandbox(): ExecutionSandbox {
    return this.sandbox;
  }

  getConfig(): SecurityConfig {
    return this.config;
  }

  /** Liberar timers del gate HITL (onclose del servidor). */
  destroy(): void {
    this.hitlGate.destroy();
  }
}