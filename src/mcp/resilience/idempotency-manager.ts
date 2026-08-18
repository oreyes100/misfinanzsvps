// idempotency-manager.ts — Deduplicación de tool calls por Idempotency-Key (MCP-03).
//
// Si un request con la misma clave ya fue procesado, devuelve el resultado
// cacheado en vez de re-ejecutar la operación.
//
// Almacenamiento:
//   - memory: Map en memoria (rápido, no persistente)
//   - localStorage: persistente en navegador (si no existe —p. ej. Node— cae a memoria)
//   - redis: para producción distribuida (requiere adapter, no implementado en MVP)

import type { IdempotencyConfig, RetryEvent } from "./retry-types.ts";

export class IdempotencyManager {
  private readonly config: IdempotencyConfig;
  // NOTA: el campo se llama `entries` para no colisionar con el método store().
  private entries = new Map<string, { result: unknown; timestamp: number }>();
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private eventHandler?: (event: RetryEvent) => void;

  constructor(config: Partial<IdempotencyConfig> = {}, eventHandler?: (event: RetryEvent) => void) {
    this.config = {
      enabled: config.enabled ?? true,
      keyTtlMs: config.keyTtlMs ?? 86_400_000, // 24h
      storage: config.storage ?? "memory",
      keyPrefix: config.keyPrefix ?? "mcp_idem",
      maxKeys: config.maxKeys ?? 10_000,
      autoCleanup: config.autoCleanup ?? true,
      cleanupIntervalMs: config.cleanupIntervalMs ?? 60_000,
    };
    this.eventHandler = eventHandler;

    this.initStorage();

    if (this.config.autoCleanup) {
      this.cleanupTimer = setInterval(() => this.cleanupExpired(), this.config.cleanupIntervalMs);
    }
  }

  /** Inicializar el almacenamiento según configuración. */
  private initStorage(): void {
    switch (this.config.storage) {
      case "localStorage":
        if (this.hasLocalStorage()) {
          this.loadFromLocalStorage();
        } else {
          // El servidor MCP corre en Node (sin localStorage real) → memoria.
          console.warn("[Idempotency] localStorage no disponible (entorno Node) → usando memoria");
        }
        break;
      case "redis":
        console.warn("[Idempotency] Redis no implementado en MVP, usando memoria");
        break;
      case "memory":
      default:
        break;
    }
  }

  private hasLocalStorage(): boolean {
    if (this.config.storage !== "localStorage") return false;
    // Node 22+ expone `localStorage` global experimental (no-op con warning);
    // en el servidor MCP siempre usamos memoria.
    if (typeof process !== "undefined" && typeof process.version === "string") return false;
    return typeof localStorage !== "undefined";
  }

  /** Cargar claves desde localStorage. */
  private loadFromLocalStorage(): void {
    try {
      const prefix = this.config.keyPrefix;
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith(prefix + ":")) {
          const idemKey = key.slice(prefix.length + 1);
          const value = JSON.parse(localStorage.getItem(key) || "{}");
          this.entries.set(idemKey, { result: value.result, timestamp: value.timestamp });
        }
      }
    } catch (error) {
      console.warn("[Idempotency] Error cargando de localStorage:", error);
    }
  }

  /**
   * ═══ CORE: Verificar si un request ya fue procesado ═══
   * @param idempotencyKey Clave única del request
   * @param toolName Nombre de la herramienta (para scope)
   * @returns Resultado cacheado si existe, null si no
   */
  check(idempotencyKey: string | undefined, toolName: string): { hit: boolean; cachedResult?: unknown } {
    if (!this.config.enabled || !idempotencyKey) {
      return { hit: false };
    }

    const scopedKey = this.buildScopedKey(idempotencyKey, toolName);
    const cached = this.entries.get(scopedKey);

    if (!cached) {
      return { hit: false };
    }

    if (Date.now() - cached.timestamp > this.config.keyTtlMs) {
      this.entries.delete(scopedKey);
      return { hit: false };
    }

    this.eventHandler?.({ type: "idempotency_hit", tool: toolName, key: idempotencyKey, cachedResult: cached.result });

    return { hit: true, cachedResult: cached.result };
  }

  /**
   * ═══ CORE: Almacenar resultado para futura deduplicación ═══
   */
  store(idempotencyKey: string | undefined, toolName: string, result: unknown): void {
    if (!this.config.enabled || !idempotencyKey) {
      return;
    }

    const scopedKey = this.buildScopedKey(idempotencyKey, toolName);

    if (this.entries.size >= this.config.maxKeys) {
      this.evictOldest();
    }

    this.entries.set(scopedKey, { result, timestamp: Date.now() });

    if (this.hasLocalStorage()) {
      try {
        const fullKey = `${this.config.keyPrefix}:${scopedKey}`;
        localStorage.setItem(fullKey, JSON.stringify({ result, timestamp: Date.now() }));
      } catch (error) {
        console.warn("[Idempotency] Error guardando en localStorage:", error);
      }
    }

    this.eventHandler?.({ type: "idempotency_stored", tool: toolName, key: idempotencyKey });
  }

  /** Construir clave con scope (tool + idempotency key). */
  private buildScopedKey(idempotencyKey: string, toolName: string): string {
    return `${toolName}:${idempotencyKey}`;
  }

  /** Evitar la clave más antigua cuando se excede el límite. */
  private evictOldest(): void {
    let oldestKey: string | null = null;
    let oldestTimestamp = Infinity;

    for (const [key, value] of this.entries) {
      if (value.timestamp < oldestTimestamp) {
        oldestTimestamp = value.timestamp;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.entries.delete(oldestKey);
    }
  }

  /** Limpiar claves expiradas. */
  cleanupExpired(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, value] of this.entries) {
      if (now - value.timestamp > this.config.keyTtlMs) {
        this.entries.delete(key);
        cleaned++;

        if (this.hasLocalStorage()) {
          try {
            localStorage.removeItem(`${this.config.keyPrefix}:${key}`);
          } catch {
            // Ignorar errores de localStorage
          }
        }
      }
    }

    if (cleaned > 0) {
      console.log(`[Idempotency] Limpiadas ${cleaned} claves expiradas`);
    }
  }

  /** Generar una clave de idempotencia única (UUID v4 si está disponible). */
  static generateKey(): string {
    if (typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.randomUUID === "function") {
      return globalThis.crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  }

  /** Obtener estadísticas. */
  getStats(): { totalKeys: number; maxKeys: number; storageType: string } {
    return {
      totalKeys: this.entries.size,
      maxKeys: this.config.maxKeys,
      storageType: this.config.storage,
    };
  }

  /** Limpiar todas las claves (reset). */
  clear(): void {
    this.entries.clear();
    if (this.hasLocalStorage()) {
      try {
        const prefix = this.config.keyPrefix + ":";
        const keysToRemove: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key?.startsWith(prefix)) {
            keysToRemove.push(key);
          }
        }
        keysToRemove.forEach((k) => localStorage.removeItem(k));
      } catch {
        // Ignorar
      }
    }
  }

  /** Cleanup. */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
  }
}