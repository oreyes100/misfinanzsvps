// persistence-types.ts — Tipos del subsistema de persistencia (MCP-05).
//
// Fortaleza de Datos: Write-Ahead Log + checkpoints + recovery + export/import.
// Corren en navegador (store.jsx, localStorage) y en Node (tests, MCP server),
// por eso el hashing es FNV-1a puro (sync, sin node:crypto) y el almacenamiento
// cae a memoria si localStorage no existe (guard `process.version`).

export type PersistenceStorageType = "localStorage" | "memory";
export type RecoveryStatus = "ok" | "recovered" | "reset";

/** Interfaz mínima de almacenamiento clave-valor (localStorage o memoria). */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** Almacenamiento en memoria (tests y fallback en Node). */
export class MemoryStorage implements KeyValueStorage {
  private readonly map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  keys(): string[] {
    return [...this.map.keys()];
  }
}

/** True si hay localStorage real (navegador). En Node (proceso) siempre memoria. */
export function hasLocalStorage(): boolean {
  if (typeof process !== "undefined" && typeof process.version === "string") return false;
  return typeof localStorage !== "undefined";
}

/** Crea el almacenamiento según el tipo configurado. */
export function createKeyValueStorage(type: PersistenceStorageType): KeyValueStorage {
  if (type === "localStorage" && hasLocalStorage()) {
    return {
      getItem: (key) => {
        try { return localStorage.getItem(key); } catch { return null; }
      },
      setItem: (key, value) => {
        try { localStorage.setItem(key, value); } catch { /* cuota/privacidad */ }
      },
      removeItem: (key) => {
        try { localStorage.removeItem(key); } catch { /* ignorar */ }
      },
    };
  }
  if (type === "localStorage") {
    console.warn("[persistence] localStorage no disponible (entorno Node) → usando memoria");
  }
  return new MemoryStorage();
}

// ─── Hash de checksum (FNV-1a 32-bit, sync, browser+Node) ──────

/** Hash FNV-1a de 32 bits en hex. Integridad/corrupción, no criptográfico. */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Serialización JSON determinista (claves ordenadas) para checksums estables. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return value === undefined ? "null" : JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => stableStringify(v)).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

// ─── Entidades del WAL / checkpoints ───────────────────────────

export interface WalEntry {
  /** Seq incremental (0,1,2,…). Único por WAL. */
  seq: number;
  /** _syncVersion del estado que provocó la mutación. */
  version: number;
  /** FNV-1a del contenido de la entrada (encadena `prevChecksum`). */
  checksum: string;
  /** Checksum de la entrada anterior (detecta borrados/reordenaciones). */
  prevChecksum?: string;
  timestamp: number;
  /** Snapshot post-mutación (para reconstrucción exacta en recovery). */
  state?: unknown;
  meta?: Record<string, unknown>;
}

export interface Checkpoint {
  /** Último seq de WAL incluido en el snapshot. */
  seq: number;
  /** _syncVersion del estado. */
  version: number;
  /** FNV-1a del snapshot. */
  checksum: string;
  state: unknown;
  timestamp: number;
}

export interface RecoveryResult {
  status: RecoveryStatus;
  state: unknown;
  version: number;
  reasons: string[];
  /** Entradas de WAL descartadas por corrupción. */
  droppedWalEntries: number;
  /** True si se regeneró checkpoint + compactó WAL tras la recuperación. */
  healed: boolean;
}

export interface ExportBundle {
  format: "misfinanzas-backup";
  version: number;
  timestamp: number;
  checksum: string;
  signature?: string;
  data: unknown;
}

export interface ImportResult {
  ok: boolean;
  state?: unknown;
  error?: string;
}

// ─── Configuración ─────────────────────────────────────────────

export interface PersistenceConfig {
  wal: {
    storage: PersistenceStorageType;
    flushIntervalMs: number;
    keyPrefix: string;
    /** Inyección para tests (compartir almacenamiento entre instancias). */
    storageAdapter?: KeyValueStorage;
  };
  checkpoints: {
    storage: PersistenceStorageType;
    maxHistory: number;
    keyPrefix: string;
    /** Inyección para tests (compartir almacenamiento entre instancias). */
    storageAdapter?: KeyValueStorage;
  };
  recovery: {
    autoHeal: boolean;
    maxToleratedDamage: number;
  };
  exportImport: {
    signingKey?: string;
    verifyOnImport: boolean;
  };
  orchestration: {
    checkpointEvery: { mutations: number; intervalMs: number };
    rollbackLimit: number;
  };
}