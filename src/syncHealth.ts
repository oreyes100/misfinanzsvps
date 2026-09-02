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

// ---------- W24: telemetría de pushes ----------

export const PUSH_LOG_KEY = "mis-finanzas-push-log";

export interface PushTelemetryEntry {
  at: string; // ISO
  success: boolean;
  syncVersion: number | null;
  error: string | null;
  attempts: number;
}

const PUSH_LOG_MAX = 20;

function readPushLog(): PushTelemetryEntry[] {
  try {
    const raw = localStorage.getItem(PUSH_LOG_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function recordPush(entry: Omit<PushTelemetryEntry, "at">) {
  try {
    const log = readPushLog();
    log.unshift({ at: new Date().toISOString(), ...entry });
    localStorage.setItem(PUSH_LOG_KEY, JSON.stringify(log.slice(0, PUSH_LOG_MAX)));
  } catch {}
}

export function getPushLog(): PushTelemetryEntry[] {
  return readPushLog();
}

export function getLastPush(): PushTelemetryEntry | null {
  return readPushLog()[0] ?? null;
}

/**
 * W24 Fase 4: push con reintentos (backoff lineal) e inyección de fetch para tests.
 * Devuelve { ok, status, attempts } — nunca lanza (el caller decide abortar o no).
 */
export async function pushWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  opts?: { maxRetries?: number; sleep?: (ms: number) => Promise<void> }
): Promise<{ ok: boolean; status: number | null; attempts: number; error: string | null }> {
  const maxRetries = opts?.maxRetries ?? 3;
  const sleep = opts?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let lastError: string | null = null;
  let lastStatus: number | null = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const r = await fetchImpl(url, init);
      lastStatus = r.status;
      if (r.ok) return { ok: true, status: r.status, attempts: attempt, error: null };
      lastError = `HTTP ${r.status}`;
    } catch (e: any) {
      lastError = e?.message || "network error";
    }
    if (attempt < maxRetries) await sleep(1000 * attempt);
  }
  return { ok: false, status: lastStatus, attempts: maxRetries, error: lastError };
}
