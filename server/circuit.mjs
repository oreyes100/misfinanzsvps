// circuit.mjs — Circuit breaker puro (W1 Fortress Fase 2).
// Estados: CLOSED (normal) → OPEN (corto tras threshold fallos) → HALF_OPEN (prueba).
// La lógica de transición es pura respecto al tiempo inyectado.
export const STATE_CLOSED = "CLOSED";
export const STATE_OPEN = "OPEN";
export const STATE_HALF_OPEN = "HALF_OPEN";

/**
 * @param {object} opts
 * @param {number} opts.threshold - fallos consecutivos antes de abrir
 * @param {number} opts.resetMs - tiempo en OPEN antes de HALF_OPEN
 * @param {number} opts.halfOpenMax - intentos en HALF_OPEN antes de decidir
 * @param {() => number} opts.nowFn
 */
export function makeCircuitBreaker({ threshold = 3, resetMs = 300_000, halfOpenMax = 1, nowFn = Date.now } = {}) {
  let state = STATE_CLOSED;
  let failures = 0;
  let openedAt = 0;
  let halfOpenAttempts = 0;

  function canExecute(now = nowFn()) {
    if (state === STATE_CLOSED) return true;
    if (state === STATE_OPEN) {
      if (now - openedAt >= resetMs) {
        state = STATE_HALF_OPEN;
        halfOpenAttempts = 0;
        return true;
      }
      return false;
    }
    if (state === STATE_HALF_OPEN) {
      return halfOpenAttempts < halfOpenMax;
    }
    return true;
  }

  function onSuccess() {
    failures = 0;
    state = STATE_CLOSED;
    openedAt = 0;
    halfOpenAttempts = 0;
  }

  function onFailure(now = nowFn()) {
    failures += 1;
    if (state === STATE_HALF_OPEN) {
      state = STATE_OPEN;
      openedAt = now;
      halfOpenAttempts = 0;
      return;
    }
    if (failures >= threshold) {
      state = STATE_OPEN;
      openedAt = now;
    }
  }

  // alias semántico para errores de Gemini (429 / rate limit)
  function onRateLimit(now = nowFn()) {
    onFailure(now);
  }

  function getState(now = nowFn()) {
    // auto-transición por tiempo si vence ventana
    if (state === STATE_OPEN && now - openedAt >= resetMs) {
      state = STATE_HALF_OPEN;
      halfOpenAttempts = 0;
    }
    return state;
  }

  function reset() {
    state = STATE_CLOSED;
    failures = 0;
    openedAt = 0;
    halfOpenAttempts = 0;
  }

  function snapshot(now = nowFn()) {
    return { state: getState(now), failures, openedAt, threshold, resetMs };
  }

  return { canExecute, onSuccess, onFailure, onRateLimit, getState, reset, snapshot };
}

/**
 * Helper puro para decisiones sin instancia: ¿debe abrirse?
 */
export function shouldOpen(failures, threshold) {
  return failures >= threshold;
}
