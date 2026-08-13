// accounts.js — Resolución de cuentas del usuario a partir de pistas
// extraídas de una imagen (nombre del banco/tarjeta, últimos dígitos).
// Espejo server-side de src/ocr.js (resolveAccount), con aliases aprendidos.
const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

/** Busca la cuenta que mejor encaja con un hint textual ("BBVA *1234", "Santander"...). */
export function resolveAccountByHint(hint, accounts, aliases = {}) {
  if (!hint || !Array.isArray(accounts)) return null;
  const h = norm(hint);
  if (aliases[h]) {
    const byAlias = accounts.find((a) => a.id === aliases[h]);
    if (byAlias) return byAlias;
  }
  let best = null;
  for (const a of accounts) {
    const an = norm(a.name);
    if (an && (h.includes(an) || an.includes(h))) return a;
    const digits = h.match(/\d{3,4}/)?.[0];
    if (digits && an && an.includes(digits)) best = a;
  }
  return best;
}

/**
 * Decide qué cuenta sugerir para una imagen.
 * - Si la imagen menciona banco/tarjeta/dígitos → se resuelve contra las cuentas.
 * - Si no hay pista (recibo de comercio), devuelve null (la IU pide elegir).
 */
export function suggestAccountForImage(result, accounts, aliases = {}) {
  if (!result || !Array.isArray(accounts)) return { account: null, hint: null, confident: false };
  const hints = Array.isArray(result.accountHints) && result.accountHints.length
    ? result.accountHints
    : (result.merchant ? [result.merchant] : []);
  for (const hint of hints) {
    const acc = resolveAccountByHint(hint, accounts, aliases);
    if (acc) return { account: acc, hint, confident: true };
  }
  return { account: null, hint: hints[0] || null, confident: false };
}