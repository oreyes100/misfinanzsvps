// persistence-orchestrator.ts — Orquestador del subsistema de persistencia (MCP-05).
//
// Conecta WAL + checkpoints + recovery + export/import en una sola pieza usada
// por store.jsx (navegador) y por el MCP server (audit trail en Node):
//
//   - recordStateMutation: registra cada mutación de estado (dedupe por _syncVersion)
//   - maybeCheckpoint: guarda snapshot tras N mutaciones o intervalo de tiempo
//   - recoverStateOnLoad: decide qué estado cargar ante corrupción
//   - rollbackTo: deshace hasta una versión previa consistente
//   - exportState/importState: backup de emergencia con firma HMAC-SHA256
//
// Factory por instancia (sin singletons): cada StoreProvider / servidor MCP
// tiene su propia cadena WAL-checkpoint-recovery aislada.

import { CheckpointManager } from "./checkpoint-manager.ts";
import { ExportImport } from "./export-import.ts";
import type { RecoveryResult } from "./persistence-types.ts";
import { RecoveryManager } from "./recovery-manager.ts";
import { WriteAheadLog } from "./write-ahead-log.ts";
import type { PersistenceConfig } from "./persistence-types.ts";

interface StateLike {
  _syncVersion?: number;
  [key: string]: unknown;
}

export interface PersistenceStats {
  lastRecordedVersion: number;
  lastCheckpointVersion: number;
  walSeq: number;
  pendingWalEntries: number;
  checkpointCount: number;
  mutationsSinceCheckpoint: number;
}

export class PersistenceOrchestrator {
  private readonly wal: WriteAheadLog;
  private readonly checkpoints: CheckpointManager;
  private readonly recovery: RecoveryManager;
  private readonly exportImport: ExportImport;
  private readonly config: PersistenceConfig;

  private lastRecordedVersion = -1;
  private lastState: StateLike | undefined;
  private lastCheckpointVersion = -1;
  private mutationCountSinceCheckpoint = 0;
  private auditVersion = 0;
  private checkpointTimer?: ReturnType<typeof setInterval>;

  constructor(config: PersistenceConfig) {
    this.config = config;
    this.wal = new WriteAheadLog({
      ...config.wal,
      storageAdapter: config.wal.storageAdapter,
    });
    this.checkpoints = new CheckpointManager({
      ...config.checkpoints,
      storageAdapter: config.checkpoints.storageAdapter,
    });
    this.recovery = new RecoveryManager(this.wal, this.checkpoints, config.recovery);
    this.exportImport = new ExportImport(config.exportImport);

    if (config.orchestration.checkpointEvery.intervalMs > 0) {
      this.checkpointTimer = setInterval(
        () => this.tick(),
        config.orchestration.checkpointEvery.intervalMs
      );
    }
  }

  /** Registra una mutación de estado. Dedupe por _syncVersion (StrictMode-safe). */
  recordStateMutation(state: StateLike, meta?: Record<string, unknown>): void {
    const version = Number(state._syncVersion ?? 0);
    if (version <= this.lastRecordedVersion) return;
    this.lastRecordedVersion = version;
    this.lastState = state;
    this.mutationCountSinceCheckpoint += 1;
    this.wal.append({ version, state, meta });
  }

  /** Registra una mutación de auditoría (server MCP) sin snapshot de estado. */
  recordMutation(meta: Record<string, unknown>): void {
    this.auditVersion += 1;
    this.wal.append({ version: this.auditVersion, meta });
  }

  /**
   * Guarda un checkpoint si toca (N mutaciones o intervalo cumplido).
   * `state`/`version` deben ser coherentes (validateState).
   */
  maybeCheckpoint(state: StateLike, version: number): { checkpointed: boolean; checkpoint?: unknown } {
    const invalid = this.validateState(state, version);
    if (invalid) return { checkpointed: false };
    const intervalMs = this.config.orchestration.checkpointEvery.intervalMs;
    const dueByMutations = this.mutationCountSinceCheckpoint >= this.config.orchestration.checkpointEvery.mutations;
    const dueByTime = intervalMs > 0 && Date.now() - (this.lastCheckpointAt ?? 0) >= intervalMs;
    if (!dueByMutations && !dueByTime) return { checkpointed: false };

    this.wal.flush();
    const seq = this.wal.getLastSeq();
    const checkpoint = this.checkpoints.save(state, version, seq);
    this.wal.compact(seq);
    this.mutationCountSinceCheckpoint = 0;
    this.lastCheckpointVersion = version;
    this.lastCheckpointAt = Date.now();
    return { checkpointed: true, checkpoint };
  }

  private lastCheckpointAt = 0;

  /** Decisión de arranque ante corrupción (delega en RecoveryManager). */
  recoverStateOnLoad(fallbackState: StateLike): RecoveryResult {
    return this.recovery.recoverOnLoad(fallbackState);
  }

  /**
   * Rollback al estado consistente más reciente con version ≤ `version`.
   * El checkpoint/entrada elegida se promueve a checkpoint vigente.
   */
  rollbackTo(version: number): { ok: boolean; state?: unknown; version?: number; error?: string } {
    const cps = this.checkpoints.loadAll();
    const target = cps.find((c) => c.version <= version && this.checkpoints.isValid(c));
    if (target) {
      this.wal.flush();
      const seq = this.wal.getLastSeq();
      this.checkpoints.save(target.state, target.version, seq);
      this.wal.compact(seq);
      this.lastCheckpointVersion = target.version;
      this.mutationCountSinceCheckpoint = 0;
      return { ok: true, state: target.state, version: target.version };
    }

    const lastWithState = [...this.wal.getEntries()]
      .reverse()
      .find((e) => e.state !== undefined && e.version <= version);
    if (lastWithState) {
      this.wal.flush();
      const seq = this.wal.getLastSeq();
      this.checkpoints.save(lastWithState.state, lastWithState.version, seq);
      this.wal.compact(seq);
      this.lastCheckpointVersion = lastWithState.version;
      this.mutationCountSinceCheckpoint = 0;
      return { ok: true, state: lastWithState.state, version: lastWithState.version };
    }

    return { ok: false, error: `no existe estado consistente con versión ≤ ${version}` };
  }

  /** Valida la coherencia estado/versión. Devuelve error o null. */
  validateState(state: StateLike, version: number): string | null {
    if (!state || typeof state !== "object") return "estado no es objeto";
    if (!Number.isFinite(version)) return "versión no es un número";
    if (version !== Number(state._syncVersion ?? 0)) return "versión no coincide con _syncVersion";
    return null;
  }

  /** Exporta el estado a bundle portable (con firma si hay clave). */
  async exportState(state: StateLike): Promise<unknown> {
    return this.exportImport.exportState(state);
  }

  /** Importa y valida un bundle. */
  async importState(bundle: unknown): Promise<{ ok: boolean; state?: unknown; error?: string }> {
    return this.exportImport.importState(bundle);
  }

  /** Fuerza la escritura del WAL pendiente (beforeunload/pagehide). */
  flush(): void {
    this.wal.flush();
  }

  getStats(): PersistenceStats {
    return {
      lastRecordedVersion: this.lastRecordedVersion,
      lastCheckpointVersion: this.lastCheckpointVersion,
      walSeq: this.wal.getLastSeq(),
      pendingWalEntries: this.wal.getEntries().length,
      checkpointCount: this.checkpoints.loadAll().length,
      mutationsSinceCheckpoint: this.mutationCountSinceCheckpoint,
    };
  }

  private tick(): void {
    if (this.lastState && this.lastRecordedVersion > this.lastCheckpointVersion) {
      this.maybeCheckpoint(this.lastState, this.lastRecordedVersion);
    }
  }

  /** Libera timers. No destruye el contenido persistido. */
  destroy(): void {
    if (this.checkpointTimer) {
      clearInterval(this.checkpointTimer);
      this.checkpointTimer = undefined;
    }
    this.wal.destroy();
  }
}