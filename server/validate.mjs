// validate.mjs — Validación de schemas de entrada (W1 Fortress Fase 4).
export const MAX_TEXT_LEN = 500;
export const MAX_CATEGORIES = 50;
export const MAX_MERCHANT_LEN = 100;
export const MAX_CATEGORY_LEN = 50;

function isString(v) { return typeof v === "string"; }

/**
 * Valida payload de /api/categorize.
 * @param {any} body
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateCategorizePayload(body) {
  if (!body || typeof body !== "object") return { ok: false, error: "Cuerpo JSON requerido." };
  const text = body.text;
  if (!isString(text) || !text.trim()) return { ok: false, error: "text requerido." };
  if (text.length > MAX_TEXT_LEN) return { ok: false, error: `text excede ${MAX_TEXT_LEN} caracteres.` };
  if (body.categories !== undefined) {
    if (!Array.isArray(body.categories)) return { ok: false, error: "categories debe ser un array." };
    if (body.categories.length > MAX_CATEGORIES) return { ok: false, error: `categories excede ${MAX_CATEGORIES} elementos.` };
    for (const c of body.categories) {
      if (!c || typeof c.name !== "string") return { ok: false, error: "cada categoría debe tener name." };
    }
  }
  return { ok: true };
}

/**
 * Valida payload de /api/learn.
 * @param {any} body
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateLearnPayload(body) {
  const entry = body && typeof body === "object" && body.entry ? body.entry : body;
  if (!entry || typeof entry !== "object") return { ok: false, error: "Cuerpo JSON requerido." };
  const kind = entry.kind || "account";
  if (kind === "category") {
    const merchant = String(entry.merchant || "").trim();
    const category = String(entry.category || "").trim();
    if (!merchant) return { ok: false, error: "merchant requerido." };
    if (merchant.length > MAX_MERCHANT_LEN) return { ok: false, error: `merchant excede ${MAX_MERCHANT_LEN} caracteres.` };
    if (!category) return { ok: false, error: "category requerido." };
    if (category.length > MAX_CATEGORY_LEN) return { ok: false, error: `category excede ${MAX_CATEGORY_LEN} caracteres.` };
    return { ok: true };
  }
  if (kind === "transfer") {
    const from = String(entry.from || "").trim();
    const to = String(entry.to || "").trim();
    const fromId = String(entry.fromId || "").trim();
    const toId = String(entry.toId || "").trim();
    if (!from && !to) return { ok: false, error: "origen o destino requerido." };
    if (!fromId && !toId) return { ok: false, error: "fromId o toId requerido." };
    if ((from && from.length > MAX_MERCHANT_LEN) || (to && to.length > MAX_MERCHANT_LEN)) return { ok: false, error: `from/to excede ${MAX_MERCHANT_LEN} caracteres.` };
    return { ok: true };
  }
  // account
  const merchant = String(entry.merchant || "").trim();
  const accountId = String(entry.accountId || "").trim();
  if (!merchant) return { ok: false, error: "merchant requerido." };
  if (merchant.length > MAX_MERCHANT_LEN) return { ok: false, error: `merchant excede ${MAX_MERCHANT_LEN} caracteres.` };
  if (!accountId) return { ok: false, error: "accountId requerido." };
  if (accountId.length > 64) return { ok: false, error: "accountId inválido." };
  return { ok: true };
}
