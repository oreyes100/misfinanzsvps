import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useStore } from "../store.jsx";

// ═══ Coalescencia de notificaciones (FASE 2) ═══
const DEBOUNCE_MS = 5000;            // 5s de debounce antes de mostrar
const AUTO_DISMISS_MS = 5000;        // Auto-cierre tras 5s
const MIN_TIME_BETWEEN_NOTIFS_MS = 30_000; // 30s entre notificaciones
const MAX_NOTIFS_PER_DAY = 5;        // Máx notificaciones visibles por día
const DAY_KEY = "mis-finazas-mcp-notif-day";
const COUNT_KEY = "mis-finazas-mcp-notif-count";

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/**
 * Notificación mínima no-invasiva: solo un contador que redirige al menú MCP.
 *  - Debounce 5s + coalescencia: si ya está visible, solo actualiza el número.
 *  - Si el usuario está en el menú MCP → no aparece.
 *  - Límite de 5/día → después solo badge en la nav.
 */
export default function McpNotification({ tab, onNavigate }) {
  const { state } = useStore();
  const pendingCount = state.reviewQueue.pending.length;
  const inMcp = tab === "mcp";

  const [visible, setVisible] = useState(false);
  const [count, setCount] = useState(0);
  const lastShownRef = useRef(0);
  const dayRef = useRef(todayKey());
  const usedRef = useRef(() => {
    try {
      if (localStorage.getItem(DAY_KEY) !== dayRef.current) return 0;
      return Number(localStorage.getItem(COUNT_KEY) || 0);
    } catch { return 0; }
  })();

  useEffect(() => {
    // Reset diario
    const tk = todayKey();
    if (dayRef.current !== tk) {
      dayRef.current = tk;
      usedRef.current = 0;
      try { localStorage.setItem(DAY_KEY, tk); localStorage.setItem(COUNT_KEY, "0"); } catch {}
    }

    // Supresión contextual: usuario en el menú, sin pendientes o límite diario.
    if (inMcp || pendingCount === 0 || usedRef.current >= MAX_NOTIFS_PER_DAY) {
      setVisible(false);
      return;
    }

    // Coalescencia: si ya está visible, solo actualizar el contador.
    if (visible) {
      setCount(pendingCount);
      return;
    }

    // 30s mínimo entre notificaciones.
    if (Date.now() - lastShownRef.current < MIN_TIME_BETWEEN_NOTIFS_MS) {
      setVisible(false);
      return;
    }

    const t = setTimeout(() => {
      setCount(pendingCount);
      setVisible(true);
      lastShownRef.current = Date.now();
      usedRef.current += 1;
      try { localStorage.setItem(COUNT_KEY, String(usedRef.current)); } catch {}
      setTimeout(() => setVisible(false), AUTO_DISMISS_MS);
    }, DEBOUNCE_MS);

    return () => clearTimeout(t);
  }, [pendingCount, inMcp, visible]);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: -16, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -16, scale: 0.96 }}
          transition={{ duration: 0.18, ease: "easeOut" }}
          className="fixed left-1/2 top-4 z-50 w-[min(24rem,calc(100%-2rem))] -translate-x-1/2"
          role="alert"
          aria-live="polite"
        >
          <div className="glass flex items-center gap-3 !rounded-2xl px-4 py-3 shadow-lg">
            <span className="text-lg" aria-hidden="true">🔔</span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {count} transacción{count !== 1 ? "es" : ""} nueva{count !== 1 ? "s" : ""}
              </p>
              <p className="text-xs text-ink-dim">Pendientes de revisión en MCP</p>
            </div>
            <button
              type="button"
              onClick={onNavigate}
              className="pressable shrink-0 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-base-950 hover:bg-accent-soft"
              aria-label={`Ver ${count} transacciones en el menú MCP`}
            >
              Ver →
            </button>
            <button
              type="button"
              onClick={() => setVisible(false)}
              className="pressable shrink-0 p-1 text-ink-dim hover:text-ink"
              aria-label="Cerrar notificación"
            >
              ✕
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * Badge del menú MCP en la bottom nav. Siempre visible si hay pendientes
 * (sin depender de la notificación). Capa en 99+.
 */
export function McpNavBadge() {
  const { state } = useStore();
  const total = state.reviewQueue.pending.length;
  if (total === 0) return null;
  return (
    <span
      className="absolute -right-1 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-loss px-1 text-[10px] font-bold leading-none text-base-950"
      aria-label={`${total} transacciones pendientes de revisión`}
    >
      {total > 99 ? "99+" : total}
    </span>
  );
}