// ratelimit.mjs — Rate limiting puro y testeable (W1 Fortress Fase 2).
// Algoritmo: fixed window sliding por clave (IP). La función pura
// `checkWindow` es 100% determinista; el wrapper `makeRateLimiter`
// mantiene el mapa de timestamps en memoria (stateful).
export const DEFAULT_WINDOW_MS = 60_000;
export const DEFAULT_MAX = 30;

/**
 * Decide si la ventana permite un nuevo request.
 * @param {number[]} timestamps - timestamps previos dentro de la ventana
 * @param {number} now - timestamp actual
 * @param {number} windowMs
 * @param {number} max
 * @returns {{ allowed: boolean, remaining: number, resetAt: number, next: number[] }}
 */
export function checkWindow(timestamps, now, windowMs, max) {
  const pruned = timestamps.filter((t) => now - t < windowMs);
  if (pruned.length >= max) {
    const oldest = pruned[0];
    const resetAt = oldest + windowMs;
    return { allowed: false, remaining: 0, resetAt, next: pruned };
  }
  const next = [...pruned, now];
  return { allowed: true, remaining: max - next.length, resetAt: now + windowMs, next };
}

/**
 * Crea un rate limiter stateful en memoria.
 * Uso: const rl = makeRateLimiter({ windowMs: 60_000, max: 30 });
 *       if (!rl.isAllowed(ip).allowed) return 429
 */
export function makeRateLimiter({ windowMs = DEFAULT_WINDOW_MS, max = DEFAULT_MAX, nowFn = Date.now } = {}) {
  /** @type {Map<string, number[]>} */
  const store = new Map();

  function isAllowed(key, now = nowFn()) {
    const k = String(key || "global");
    const curr = store.get(k) || [];
    const res = checkWindow(curr, now, windowMs, max);
    if (res.allowed) store.set(k, res.next);
    else store.set(k, res.next); // keep pruned
    return { allowed: res.allowed, remaining: res.remaining, resetAt: res.resetAt };
  }

  function reset(key) {
    store.delete(String(key || "global"));
  }

  function remaining(key, now = nowFn()) {
    const curr = store.get(String(key || "global")) || [];
    const pruned = curr.filter((t) => now - t < windowMs);
    return Math.max(0, max - pruned.length);
  }

  function _size() { return store.size; }

  return { isAllowed, check: isAllowed, reset, remaining, _store: store, windowMs, max };
}

export function rateLimitHeaders(remaining, resetAt) {
  return {
    "X-RateLimit-Remaining": String(remaining),
    "X-RateLimit-Reset": String(Math.ceil(resetAt / 1000)),
  };
}
