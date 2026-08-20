// notificationPolicy.js — Política de notificaciones MCP (FASE 2).
//
// Lógica pura (sin DOM, sin timers, sin localStorage) para decidir cuándo
// mostrar la notificación del MCP Command Center. El componente McpNotification
// solo se encarga del debounce (setTimeout) y de persistir el conteo diario.

export const DEBOUNCE_MS = 5000; // 5s de debounce antes de mostrar
export const AUTO_DISMISS_MS = 5000; // Auto-cierre tras 5s
export const MIN_TIME_BETWEEN_NOTIFS_MS = 30_000; // 30s entre notificaciones
export const MAX_NOTIFS_PER_DAY = 5; // Máx notificaciones visibles por día
export const DAY_KEY = "mis-finazas-mcp-notif-day";
export const COUNT_KEY = "mis-finazas-mcp-notif-count";

/** Clave de día (YYYY-M-D) — sirve para detectar el reset diario. */
export function todayKey(now = new Date()) {
  return `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
}

/**
 * Decide si la notificación debe mostrarse ahora.
 * @param {object} p
 * @param {number} p.pendingCount  Items pendientes en la cola MCP.
 * @param {boolean} p.inMcp        ¿El usuario está en el menú MCP? → nunca.
 * @param {boolean} p.visible      ¿La notificación ya está visible? → coalescencia.
 * @param {number} p.usedToday     Notificaciones mostradas hoy.
 * @param {number} p.lastShownAt   Timestamp de la última vez mostrada.
 * @param {number} [p.now]         Timestamp actual (inyectable en tests).
 */
export function shouldShowNotification({
  pendingCount,
  inMcp,
  visible,
  usedToday,
  lastShownAt,
  now = Date.now(),
}) {
  if (inMcp || pendingCount === 0 || usedToday >= MAX_NOTIFS_PER_DAY) return false;
  if (visible) return true; // coalescencia: solo actualizar contador
  if (now - lastShownAt < MIN_TIME_BETWEEN_NOTIFS_MS) return false;
  return true;
}