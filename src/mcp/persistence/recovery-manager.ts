// recovery-manager.ts — Recuperación automática ante corrupción (MCP-05).
//
// Decide qué estado cargar al arrancar cuando localStorage (o el WAL/checkpoints)
// pueden estar dañados. Estrategia:
//
//   1. Corrupción MASIVA del WAL (≥ maxToleratedDamage) → reset a estado semilla.
//   2. Checkpoint válido + WAL intacto después → reconstrucción exacta desde la
//      última entrada WAL con snapshot (o el propio checkpoint).
//   3. Checkpoint válido + WAL dañado después → rollback al checkpoint.
//   4. Sin checkpoint + WAL íntegro → reconstrucción desde la última entrada WAL.
//   5. Sin checkpoint + WAL parcialmente dañado → última entrada WAL válida.
//   6. Nada usable → estado semilla.
//
// `autoHeal`: tras recuperar, regenera checkpoint del estado resultante y
// compacta el WAL para que la próxima carga sea limpia.

import type { CheckpointManager } from "./checkpoint-manager.ts";
import type { RecoveryResult } from "./persistence-types.ts";
import type { WriteAheadLog } from "./write-ahead-log.ts";

export interface RecoveryManagerConfig {
  autoHeal: boolean;
  maxToleratedDamage: number;
}

interface FallbackState {
  _syncVersion?: number;
  [key: string]: unknown;
}

export class RecoveryManager {
  private readonly wal: WriteAheadLog;
  private readonly checkpoints: CheckpointManager;
  private readonly config: RecoveryManagerConfig;

  constructor(wal: WriteAheadLog, checkpoints: CheckpointManager, config: RecoveryManagerConfig) {
    this.wal = wal;
    this.checkpoints = checkpoints;
    this.config = config;
  }

  /**
   * Devuelve el estado a cargar y el resultado de la recuperación.
   * `fallbackState` es el estado semilla (nunca corrupto por construcción).
   */
  recoverOnLoad(fallbackState: FallbackState): RecoveryResult {
    const reasons: string[] = [];
    const fallbackVersion = Number(fallbackState._syncVersion ?? 0);
    const verify = this.wal.verify();
    const corruptedSeqs = new Set(verify.corrupted);

    // 1. Corrupción masiva → reset completo.
    if (verify.corrupted.length >= this.config.maxToleratedDamage) {
      reasons.push(
        `Corrupción masiva del WAL: ${verify.corrupted.length} entradas dañadas (≥ ${this.config.maxToleratedDamage}) → estado semilla`
      );
      this.wal.clear();
      this.checkpoints.clear();
      return {
        status: "reset",
        state: fallbackState,
        version: fallbackVersion,
        reasons,
        droppedWalEntries: verify.corrupted.length,
        healed: false,
      };
    }

    const cp = this.checkpoints.loadLatest();
    const validCp = cp && this.checkpoints.isValid(cp) ? cp : undefined;
    if (cp && !validCp) reasons.push("Checkpoint más reciente corrupto → ignorado");

    // 2-3. Hay un checkpoint válido.
    if (validCp) {
      const after = verify.entries.filter((e) => e.seq > validCp.seq);
      const afterCorrupted = after.filter((e) => corruptedSeqs.has(e.seq));
      const afterValid = after.filter((e) => !corruptedSeqs.has(e.seq));

      if (afterCorrupted.length === 0) {
        const lastWithState = [...afterValid].reverse().find((e) => e.state !== undefined);
        if (lastWithState) {
          reasons.push(
            `Reconstrucción exacta desde WAL (seq ${lastWithState.seq}, versión ${lastWithState.version}) tras checkpoint ${validCp.seq}`
          );
          return this.heal(lastWithState.state, lastWithState.version, lastWithState.seq, reasons, 0, "recovered");
        }
        reasons.push(`Recuperado desde checkpoint (seq ${validCp.seq}, versión ${validCp.version})`);
        return this.heal(validCp.state, validCp.version, validCp.seq, reasons, 0, "recovered");
      }

      reasons.push(
        `WAL dañado tras checkpoint ${validCp.seq} (${afterCorrupted.length} entradas descartadas) → rollback al checkpoint`
      );
      return this.heal(validCp.state, validCp.version, validCp.seq, reasons, afterCorrupted.length, "recovered");
    }

    // 4-6. Sin checkpoint válido.
    if (verify.ok) {
      const lastWithState = [...verify.entries].reverse().find((e) => e.state !== undefined);
      if (lastWithState) {
        reasons.push(`Sin checkpoint: reconstrucción desde WAL (seq ${lastWithState.seq}, versión ${lastWithState.version})`);
        return this.heal(lastWithState.state, lastWithState.version, lastWithState.seq, reasons, 0, "recovered");
      }
      reasons.push("Sin checkpoint y sin snapshots en WAL → estado semilla");
      return {
        status: "reset",
        state: fallbackState,
        version: fallbackVersion,
        reasons,
        droppedWalEntries: 0,
        healed: false,
      };
    }

    const lastValidWithState = [...verify.entries]
      .reverse()
      .find((e) => e.state !== undefined && !corruptedSeqs.has(e.seq));
    if (lastValidWithState) {
      reasons.push(
        `WAL parcialmente dañado (${verify.corrupted.length}): reconstrucción desde última entrada válida (seq ${lastValidWithState.seq})`
      );
      return this.heal(
        lastValidWithState.state,
        lastValidWithState.version,
        lastValidWithState.seq,
        reasons,
        verify.corrupted.length,
        "recovered"
      );
    }

    reasons.push(`WAL sin snapshots válidos (${verify.corrupted.length} dañadas) → estado semilla`);
    if (this.config.autoHeal) this.wal.clear();
    return {
      status: "reset",
      state: fallbackState,
      version: fallbackVersion,
      reasons,
      droppedWalEntries: verify.corrupted.length,
      healed: this.config.autoHeal,
    };
  }

  /** Aplica autoHeal (checkpoint + compactación) si está habilitado. */
  private heal(
    state: unknown,
    version: number,
    seq: number,
    reasons: string[],
    dropped: number,
    status: RecoveryResult["status"]
  ): RecoveryResult {
    let healed = false;
    if (this.config.autoHeal) {
      this.checkpoints.save(state, version, seq);
      this.wal.compact(seq);
      healed = true;
    }
    return { status, state, version, reasons, droppedWalEntries: dropped, healed };
  }
}