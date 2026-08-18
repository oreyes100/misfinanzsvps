import { useMemo, useState } from "react";
import { motion, AnimatePresence, useReducedMotion } from "framer-motion";
import { useStore } from "../store.jsx";
import { diagnosePipeline } from "../utils/pipelineDiagnostics.js";
import { Btn } from "./UI.jsx";

const SOURCE_ICONS = { assistant: "🤖", ocr: "📷", sync: "🔁", manual: "✍️", demo: "🎬", ai: "🧠" };
const KIND_LABELS = { enqueue: "Encolado", auto_capture: "Auto-captura", recheck: "Re-check", onboarding: "Demo", accept: "Aceptado" };

/**
 * ═══ McpPipelineHealth (GHOST PIPELINE) ═══
 * Checklist de eslabones del pipeline MCP + actividad reciente + botón reparar.
 * Se integra en McpMenu como cabecera colapsable. Puro sobre el store.
 */
export default function McpPipelineHealth() {
  const { state, dispatch } = useStore();
  const reduceMotion = useReducedMotion();
  const [open, setOpen] = useState(false);

  const diag = useMemo(() => diagnosePipeline(state), [state]);
  const events = state.pipelineEvents?.slice?.(0, 10) || [];
  const hasSeenActivity = (state.pipelineEvents?.length ?? 0) > 0;

  const healthColor =
    diag.health === "ok" ? "text-emerald-300" : diag.health === "degraded" ? "text-amber-300" : "text-rose-300";
  const healthLabel = diag.health === "ok" ? "OK" : diag.health === "degraded" ? "Degradado" : "Roto";

  const recheck = () => dispatch({ type: "pipeline_recheck" });
  const runDemo = () => dispatch({ type: "pipeline_demo" });

  return (
    <div className="mb-4 rounded-2xl border border-white/10 bg-white/4">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
      >
        <span className="flex items-center gap-2 text-xs font-semibold">
          <span aria-hidden="true" className={`size-2 rounded-full ${diag.health === "ok" ? "bg-emerald-400" : diag.health === "degraded" ? "bg-amber-400" : "bg-rose-400"}`} />
          Pipeline MCP · <span className={healthColor}>{healthLabel}</span> · {diag.okCount}/{diag.total} eslabones
        </span>
        <span aria-hidden="true" className="text-xs text-ink-dim">{open ? "▾" : "▸"}</span>
      </button>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 0.2 }}
            className="overflow-hidden"
          >
            <div className="space-y-3 px-3 pb-3">
              {/* Checklist de eslabones */}
              <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                {diag.eslabones.map((e) => (
                  <li key={e.id} className="flex items-center gap-1.5 text-xs">
                    <span aria-hidden="true" className={e.ok ? "text-emerald-400" : "text-rose-400"}>
                      {e.ok ? "✓" : "✗"}
                    </span>
                    <span className="text-ink-dim">{e.label}</span>
                  </li>
                ))}
              </ul>

              {/* Contadores vivos */}
              <div className="flex flex-wrap gap-2 text-xs text-ink-dim">
                <span className="rounded-lg bg-white/6 px-2 py-1">Pendientes: <strong className="text-ink">{diag.counts.pending}</strong></span>
                <span className="rounded-lg bg-white/6 px-2 py-1">Corregir: <strong className="text-ink">{diag.counts.needsFix}</strong></span>
                <span className="rounded-lg bg-white/6 px-2 py-1">Revisar: <strong className="text-ink">{diag.counts.needsReview}</strong></span>
                <span className="rounded-lg bg-white/6 px-2 py-1">Eventos: <strong className="text-ink">{diag.counts.events}</strong></span>
              </div>

              {/* Actividad reciente (telemetría) */}
              <div>
                <p className="mb-1 text-[11px] font-medium uppercase tracking-wide text-ink-dim">Actividad reciente</p>
                {events.length ? (
                  <ul className="space-y-1">
                    {events.map((ev, i) => (
                      <li key={i} className="flex items-center gap-2 text-xs">
                        <span aria-hidden="true">{SOURCE_ICONS[ev.source] || "•"}</span>
                        <span className="text-ink">{KIND_LABELS[ev.kind] || ev.kind}</span>
                        <span className="truncate text-ink-dim">{ev.detail}</span>
                        <span className="ml-auto shrink-0 text-[10px] text-ink-dim">
                          {new Date(ev.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-ink-dim">Sin actividad todavía.</p>
                )}
              </div>

              {/* Acciones: reparar + demo */}
              <div className="flex flex-wrap gap-2">
                <Btn size="sm" onClick={recheck} title="Re-ejecuta la auto-captura sobre las transacciones actuales">
                  🔧 Reparar (re-check)
                </Btn>
                {!hasSeenActivity && (
                  <Btn size="sm" variant="ghost" onClick={runDemo} title="Encola un item de ejemplo para ver el pipeline en acción">
                    🎬 Ver demo
                  </Btn>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}