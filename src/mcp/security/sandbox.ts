// sandbox.ts — Sandbox de ejecución de tool calls (MCP-04).
//
// Aísla la ejecución para prevenir:
//   - Ejecución sin límite de tiempo (timeout duro, con cleanup de timers)
//   - Acceso a red no autorizado (allowlist; el intercepto real de fetch en
//     handlers ajenos requiere un proxy de red — fuera del alcance del MVP)
//   - Consumo excesivo de recursos (límites de tamaño y profundidad de params)
//   - Fugas de datos entre tool calls (registro de ejecuciones activas)
//
// La memoria es un presupuesto declarativo (config/permissions): el aislamiento
// real de memoria exigiría worker_threads/subprocesos, fuera del MVP.

import type { SandboxConfig, SecurityEvent } from "./security-types.ts";

export class ExecutionSandbox {
  private readonly config: SandboxConfig;
  private eventHandler?: (event: SecurityEvent) => void;
  private activeExecutions = new Map<string, { startTime: number; tool: string }>();

  constructor(config: SandboxConfig, eventHandler?: (event: SecurityEvent) => void) {
    this.config = config;
    this.eventHandler = eventHandler;
  }

  /** ═══ CORE: Ejecutar una función dentro del sandbox ═══ */
  async execute<T>(
    toolName: string,
    executionId: string,
    fn: () => Promise<T>,
    timeoutMsOverride?: number
  ): Promise<T> {
    const startTime = Date.now();
    this.activeExecutions.set(executionId, { startTime, tool: toolName });

    try {
      const timeoutMs = timeoutMsOverride ?? this.config.maxExecutionTimeMs;
      return await this.withTimeout(fn, timeoutMs, toolName, startTime);
    } finally {
      this.activeExecutions.delete(executionId);
    }
  }

  /** Timeout duro con cleanup: un éxito temprano cancela el timer. */
  private withTimeout<T>(
    fn: () => Promise<T>,
    timeoutMs: number,
    toolName: string,
    startTime: number
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        const executionTime = Date.now() - startTime;
        this.eventHandler?.({ type: "sandbox_timeout", tool: toolName, executionTimeMs: executionTime });
        reject(new Error(`Sandbox timeout: '${toolName}' excedió ${timeoutMs}ms`));
      }, timeoutMs);

      fn().then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }

  /** Verificar si un dominio está en la allowlist. */
  validateNetworkAccess(toolName: string, domain: string, allowlist: string[]): boolean {
    if (!allowlist || allowlist.length === 0) {
      this.eventHandler?.({ type: "network_blocked", tool: toolName, domain });
      return false;
    }

    const isAllowed = allowlist.some((allowed) => {
      if (allowed === "*") return true;
      if (allowed.startsWith("*.")) return domain.endsWith(allowed.slice(2));
      return domain === allowed;
    });

    if (!isAllowed) this.eventHandler?.({ type: "network_blocked", tool: toolName, domain });
    return isAllowed;
  }

  /** Validar tamaño total de parámetros. */
  validateParamsSize(params: Record<string, unknown>): { valid: boolean; actualSize: number; maxSize: number } {
    const actualSize = JSON.stringify(params).length;
    return { valid: actualSize <= this.config.maxParamsSizeBytes, actualSize, maxSize: this.config.maxParamsSizeBytes };
  }

  /** Validar profundidad de objetos (anti "billion laughs"/stack overflow). */
  validateObjectDepth(obj: unknown, currentDepth = 0): { valid: boolean; maxDepthReached: number } {
    if (currentDepth > this.config.maxObjectDepth) {
      return { valid: false, maxDepthReached: currentDepth };
    }
    if (obj === null || typeof obj !== "object") {
      return { valid: true, maxDepthReached: currentDepth };
    }

    let maxDepth = currentDepth;
    const values = Array.isArray(obj) ? obj : Object.values(obj as Record<string, unknown>);

    for (const item of values) {
      const result = this.validateObjectDepth(item, currentDepth + 1);
      if (!result.valid) return result;
      maxDepth = Math.max(maxDepth, result.maxDepthReached);
    }

    return { valid: true, maxDepthReached: maxDepth };
  }

  getActiveExecutions(): { executionId: string; tool: string; elapsedMs: number }[] {
    const now = Date.now();
    return Array.from(this.activeExecutions.entries()).map(([id, info]) => ({
      executionId: id,
      tool: info.tool,
      elapsedMs: now - info.startTime,
    }));
  }

  getConfig(): SandboxConfig {
    return { ...this.config };
  }
}