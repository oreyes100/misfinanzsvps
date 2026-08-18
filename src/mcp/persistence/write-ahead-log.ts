// write-ahead-log.ts — Write-Ahead Log (WAL) de Fortaleza de Datos (MCP-05).
//
// Antes de aplicar una mutación de estado se registra una entrada en el WAL:
//   - seq incremental (único, base para checkpoints y rollback)
//   - version (_syncVersion del estado que provocó la mutación)
//   - checksum FNV-1a del contenido, ENCADENADO al checksum anterior
//     (`prevChecksum`): detecta borrados/reordenaciones además de corrupción.
//   - snapshot post-mutación opcional (`state`) para reconstrucción exacta.
//
// El WAL se persiste en una única key JSON `{ entries: [...] }` y puede
// escribirse inmediatamente (flushIntervalMs = 0, tests) o en lote por timer
// (producción en navegador: batchear reduce escrituras a localStorage).
//
// `storageAdapter` permite inyectar almacenamiento compartido en tests para
// simular corrupción leyendo/escribiendo la key `{keyPrefix}:wal`.

import {
  createKeyValueStorage,
  fnv1a,
  stableStringify,
  type KeyValueStorage,
  type PersistenceStorageType,
  type WalEntry,
} from "./persistence-types.ts";

export interface WriteAheadLogConfig {
  storage: PersistenceStorageType;
  /** 0 = flush inmediato; >0 = batch por intervalo (ms). */
  flushIntervalMs: number;
  keyPrefix: string;
  storageAdapter?: KeyValueStorage;
}

interface WalPayload {
  entries: WalEntry[];
}

export class WriteAheadLog {
  private readonly config: WriteAheadLogConfig;
  private readonly kv: KeyValueStorage;
  private entries: WalEntry[] = [];
  private lastSeq = -1;
  private pending: WalEntry[] = [];
  private flushTimer?: ReturnType<typeof setInterval>;

  constructor(config: WriteAheadLogConfig) {
    this.config = config;
    this.kv = config.storageAdapter ?? createKeyValueStorage(config.storage);
    this.loadPersisted();
    if (config.flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => this.flush(), config.flushIntervalMs);
    }
  }

  private loadPersisted(): void {
    try {
      const raw = this.kv.getItem(this.walKey());
      if (!raw) return;
      const parsed = JSON.parse(raw) as WalPayload;
      if (!Array.isArray(parsed.entries)) return;
      this.entries = parsed.entries
        .filter((e) => e && typeof e.seq === "number")
        .sort((a, b) => a.seq - b.seq);
      this.lastSeq = this.entries.length ? this.entries[this.entries.length - 1].seq : -1;
    } catch {
      // WAL ilegible → arrancar vacío; recovery decidirá el estado a usar.
      this.entries = [];
      this.lastSeq = -1;
    }
  }

  private walKey(): string {
    return `${this.config.keyPrefix}:wal`;
  }

  /**
   * Registra una mutación. `version` es el _syncVersion del estado post-mutación;
   * `state` es el snapshot durable opcional para reconstrucción exacta.
   * Devuelve la entrada creada.
   */
  append(input: { version: number; state?: unknown; meta?: Record<string, unknown> }): WalEntry {
    const seq = this.lastSeq + 1;
    const prevChecksum = this.entries.length
      ? this.entries[this.entries.length - 1].checksum
      : undefined;
    const entry: WalEntry = {
      seq,
      version: input.version,
      timestamp: Date.now(),
      prevChecksum,
      checksum: "",
      ...(input.state !== undefined ? { state: input.state } : {}),
      ...(input.meta ? { meta: input.meta } : {}),
    };
    entry.checksum = fnv1a(
      stableStringify({ seq: entry.seq, version: entry.version, state: entry.state, meta: entry.meta, prevChecksum: entry.prevChecksum })
    );
    this.pending.push(entry);
    this.entries.push(entry);
    this.lastSeq = seq;
    if (this.config.flushIntervalMs === 0) this.flush();
    return entry;
  }

  /** Fuerza la escritura de las entradas pendientes al almacenamiento. */
  flush(): void {
    if (!this.pending.length) return;
    const merged = [...this.entries];
    try {
      this.kv.setItem(this.walKey(), JSON.stringify({ entries: merged } satisfies WalPayload));
      this.pending = [];
    } catch {
      // Persistencia fallida (cuota/privacidad): mantener pendientes para reintentar.
    }
  }

  /** Todas las entradas (de memoria), ordenadas por seq. */
  getEntries(): WalEntry[] {
    return [...this.entries];
  }

  getLastSeq(): number {
    return this.lastSeq;
  }

  /**
   * Verifica la cadena de checksums. Devuelve ok + los seqs corruptos.
   * Detecta también entradas borradas/reordenadas vía prevChecksum.
   */
  verify(): { ok: boolean; entries: WalEntry[]; corrupted: number[] } {
    const corrupted: number[] = [];
    let prev: string | undefined;
    for (const entry of this.entries) {
      const recomputed = fnv1a(
        stableStringify({ seq: entry.seq, version: entry.version, state: entry.state, meta: entry.meta, prevChecksum: entry.prevChecksum })
      );
      if (entry.checksum !== recomputed || entry.prevChecksum !== prev) {
        corrupted.push(entry.seq);
      }
      prev = entry.checksum;
    }
    return { ok: corrupted.length === 0, entries: this.getEntries(), corrupted };
  }

  /**
   * Compacta el WAL conservando entradas con seq > upToSeq y RE-ENCADENA los
   * checksums (los datos sobrevivientes quedan con una cadena válida).
   * lastSeq se fija en max(upToSeq, maxSeqRestante) para mantener monotonicidad.
   */
  compact(upToSeq: number): void {
    const kept = this.entries.filter((e) => e.seq > upToSeq);
    let prev: string | undefined;
    const rebuilt: WalEntry[] = kept.map((e) => {
      const copy: WalEntry = {
        seq: e.seq,
        version: e.version,
        timestamp: e.timestamp,
        checksum: "",
        ...(e.state !== undefined ? { state: e.state } : {}),
        ...(e.meta ? { meta: e.meta } : {}),
      };
      copy.prevChecksum = prev;
      copy.checksum = fnv1a(
        stableStringify({ seq: copy.seq, version: copy.version, state: copy.state, meta: copy.meta, prevChecksum: copy.prevChecksum })
      );
      prev = copy.checksum;
      return copy;
    });
    this.entries = rebuilt;
    this.lastSeq = Math.max(upToSeq, rebuilt.length ? rebuilt[rebuilt.length - 1].seq : -1);
    this.pending = [];
    try {
      this.kv.setItem(this.walKey(), JSON.stringify({ entries: this.entries } satisfies WalPayload));
    } catch {
      // Compact best-effort; el estado en memoria es la fuente de verdad.
    }
  }

  /** Elimina todas las entradas y resetea la cadena (reset completo). */
  clear(): void {
    this.entries = [];
    this.pending = [];
    this.lastSeq = -1;
    try {
      this.kv.removeItem(this.walKey());
    } catch { /* best-effort */ }
  }

  /** Libera el timer de flush. No vacía el contenido persistido. */
  destroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
  }
}