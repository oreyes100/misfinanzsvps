// checkpoint-manager.ts — Snapshot del estado para recovery (MCP-05).
//
// Un checkpoint es un snapshot completo del estado con:
//   - seq: último seq de WAL incluido (el recovery sabe desde dónde re-aplicar)
//   - version: _syncVersion del estado
//   - checksum: FNV-1a del snapshot (detección de corrupción)
//
// Se guardan los `maxHistory` más recientes en la key `{keyPrefix}:checkpoints`
// (`{ checkpoints: [...] }`). `storageAdapter` permite inyectar almacenamiento
// en tests para simular corrupción.

import {
  createKeyValueStorage,
  fnv1a,
  stableStringify,
  type Checkpoint,
  type KeyValueStorage,
  type PersistenceStorageType,
} from "./persistence-types.ts";

export interface CheckpointManagerConfig {
  storage: PersistenceStorageType;
  maxHistory: number;
  keyPrefix: string;
  storageAdapter?: KeyValueStorage;
}

interface CheckpointPayload {
  checkpoints: Checkpoint[];
}

export class CheckpointManager {
  private readonly config: CheckpointManagerConfig;
  private readonly kv: KeyValueStorage;
  private checkpoints: Checkpoint[] = [];

  constructor(config: CheckpointManagerConfig) {
    this.config = config;
    this.kv = config.storageAdapter ?? createKeyValueStorage(config.storage);
    this.loadPersisted();
  }

  private cpKey(): string {
    return `${this.config.keyPrefix}:checkpoints`;
  }

  private loadPersisted(): void {
    try {
      const raw = this.kv.getItem(this.cpKey());
      if (!raw) return;
      const parsed = JSON.parse(raw) as CheckpointPayload;
      if (!Array.isArray(parsed.checkpoints)) return;
      this.checkpoints = parsed.checkpoints
        .filter((c) => c && typeof c.seq === "number" && typeof c.version === "number")
        .sort((a, b) => b.seq - a.seq);
    } catch {
      this.checkpoints = [];
    }
  }

  private persist(): void {
    try {
      this.kv.setItem(this.cpKey(), JSON.stringify({ checkpoints: this.checkpoints } satisfies CheckpointPayload));
    } catch {
      // Best-effort (cuota/privacidad); el historial en memoria sigue disponible.
    }
  }

  /** Guarda un snapshot del estado como checkpoint más reciente. */
  save(state: unknown, version: number, walSeq: number): Checkpoint {
    const checkpoint: Checkpoint = {
      seq: walSeq,
      version,
      checksum: fnv1a(stableStringify(state)),
      state,
      timestamp: Date.now(),
    };
    this.checkpoints = [checkpoint, ...this.checkpoints]
      .sort((a, b) => b.seq - a.seq)
      .slice(0, this.config.maxHistory);
    this.persist();
    return checkpoint;
  }

  /** Todos los checkpoints, más reciente primero. */
  loadAll(): Checkpoint[] {
    return [...this.checkpoints];
  }

  /** El checkpoint con mayor seq, o undefined si no hay. */
  loadLatest(): Checkpoint | undefined {
    return this.checkpoints.length ? this.checkpoints[0] : undefined;
  }

  /** Recalcula el checksum del snapshot: true si el checkpoint está intacto. */
  isValid(checkpoint: Checkpoint): boolean {
    return checkpoint.checksum === fnv1a(stableStringify(checkpoint.state));
  }

  /** Elimina todo el historial de checkpoints. */
  clear(): void {
    this.checkpoints = [];
    try {
      this.kv.removeItem(this.cpKey());
    } catch { /* best-effort */ }
  }
}