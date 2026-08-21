// syncHealth.ts — Telemetría y diagnóstico de convergencia (W21 Fase 4)
import type { AppState } from "./types.ts";

export const LAST_RESYNC_KEY = "mis-finanzas-last-resync";

export interface LastResync {
  at: string; // ISO
  reason: string; // e.g. "heartbeat", "focus", "local_is_demo"
  fromVersion: number | null;
  toVersion: number | null;
  hash: string | null;
  motivos: string[];
}

export function diagnoseDivergence(local: any, snapshot: any): string[] {
  const reasons: string[] = [];
  if (!local) reasons.push("no_local");
  if (!snapshot || !snapshot.state) reasons.push("no_snapshot");
  else {
    if (local?._isDemo && !snapshot.state._isDemo) reasons.push("local_is_demo");
    if (local?._syncVersion == null) reasons.push("missing_sync_version");
    if (snapshot.hash) {
      // hash mismatch will be checked outside with syncableHash, but we note version mismatch here
      if (snapshot.syncVersion != null && local?._syncVersion !== snapshot.syncVersion) reasons.push("version_mismatch");
    }
  }
  return reasons;
}

export function shouldAutoReplace(local: any, snapState: any): boolean {
  return !!local?._isDemo && !snapState?._isDemo;
}

export function recordResync(entry: Partial<LastResync> & { reason: string }) {
  try {
    const payload: LastResync = {
      at: new Date().toISOString(),
      reason: entry.reason,
      fromVersion: entry.fromVersion ?? null,
      toVersion: entry.toVersion ?? null,
      hash: entry.hash ?? null,
      motivos: entry.motivos ?? [],
    };
    localStorage.setItem(LAST_RESYNC_KEY, JSON.stringify(payload));
  } catch {}
}

export function getLastResync(): LastResync | null {
  try {
    const raw = localStorage.getItem(LAST_RESYNC_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
