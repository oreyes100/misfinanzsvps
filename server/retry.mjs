// retry.mjs — Retry con backoff exponencial + jitter (W1 Fase 3).
export function getRetryDelay(attempt, baseMs = 1000, maxMs = 30_000, jitter = 0.2) {
  const exp = baseMs * Math.pow(2, attempt);
  const capped = Math.min(exp, maxMs);
  const j = capped * jitter * (Math.random() * 2 - 1); // ±20%
  return Math.max(0, Math.round(capped + j));
}

/**
 * Reintenta `fn` con backoff si `isRetryable(error)` es true.
 * @param {() => Promise<any>} fn
 * @param {{ maxAttempts?: number, baseMs?: number, maxMs?: number, isRetryable?: (e:any)=>boolean, delayFn?: (attempt:number)=>number }} opts
 */
export async function retryWithBackoff(fn, { maxAttempts = 3, baseMs = 1000, maxMs = 30_000, isRetryable = () => true, delayFn } = {}) {
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      lastError = e;
      const retriable = isRetryable(e);
      if (!retriable || attempt === maxAttempts - 1) throw e;
      const delay = delayFn ? delayFn(attempt) : getRetryDelay(attempt, baseMs, maxMs, 0);
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

export function isRetryableStatus(status) {
  return status === 429 || (status >= 500 && status < 600);
}
