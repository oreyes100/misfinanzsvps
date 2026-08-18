// pipelineDiagnostics.js — Diagnóstico del pipeline MCP (OPERACIÓN GHOST PIPELINE).
// Inspecciona los eslabones del flujo: SEED → reducer → fuentes → cola → UI → badge → telemetría.
// Puro, sin side-effects. Devuelve un reporte con cada eslabón + un health global.

export const PIPELINE_LINKS = [
  { id: "seed", label: "SEED.reviewQueue", ok: (s) => Boolean(s?.reviewQueue) },
  { id: "reducer", label: "Reducer review_enqueue", ok: (s) => s?.reviewQueue !== undefined && s?.reviewQueue !== null },
  { id: "queue", label: "Cola pendiente", ok: (s) => Array.isArray(s?.reviewQueue?.pending) },
  { id: "sync", label: "Sync incluye cola", ok: (s) => s?.reviewQueue?.pending !== undefined && s?.reviewQueue?.resolved !== undefined },
  { id: "telemetry", label: "Telemetría mcp_record", ok: (s) => Array.isArray(s?.pipelineEvents) },
];

/**
 * Diagnostica el pipeline contra un estado (store). Cada eslabón reporta ok/detail.
 * health: "ok" (todos verdes) | "degraded" (≥1 rojo, se puede operar) | "broken".
 */
export function diagnosePipeline(state) {
  const eslabones = PIPELINE_LINKS.map((l) => {
    let ok = false;
    let detail = "";
    try {
      ok = Boolean(l.ok(state));
    } catch {
      ok = false;
    }
    if (!ok) detail = "no encontrado en el estado";
    return { id: l.id, label: l.label, ok, detail };
  });

  const okCount = eslabones.filter((e) => e.ok).length;
  const failed = eslabones.filter((e) => !e.ok);
  let health = okCount === eslabones.length ? "ok" : failed.length >= 3 ? "broken" : "degraded";
  if (!state || typeof state !== "object") health = "broken";

  return {
    health,
    okCount,
    total: eslabones.length,
    eslabones,
    failed: failed.map((e) => e.id),
    // Datos derivados útiles para la UI (contadores vivos).
    counts: {
      pending: state?.reviewQueue?.pending?.length ?? 0,
      needsFix: state?.reviewQueue?.pending?.filter((i) => i.classification === "needs_fix").length ?? 0,
      needsReview: state?.reviewQueue?.pending?.filter((i) => i.classification === "needs_review").length ?? 0,
      events: state?.pipelineEvents?.length ?? 0,
    },
  };
}

/**
 * Reporte legible (para tests y logs): "ok (6/6)" / "degraded (5/6: telemetry)".
 */
export function summarizeDiagnosis(d) {
  return `${d.health} (${d.okCount}/${d.total})${d.failed.length ? `: ${d.failed.join(", ")}` : ""}`;
}

/**
 * Encola eventos de telemetría del pipeline (cap fijo, más reciente primero).
 * Puro: devuelve un nuevo array.
 */
export const MAX_PIPELINE_EVENTS = 200;

export function pushPipelineEvents(events, newEvents) {
  const list = Array.isArray(newEvents) ? newEvents : [newEvents];
  const clean = list.filter((e) => e && e.ts && e.source);
  if (!clean.length) return events;
  return [...clean, ...(events || [])].slice(0, MAX_PIPELINE_EVENTS);
}