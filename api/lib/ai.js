// ai.js — Motor de IA multi-proveedor para clasificar imágenes financieras.
//
// El objetivo: dada la foto de un recibo, captura de banco o comprobante de
// transferencia, devolver JSON estructurado (fecha, descripción, importe,
// dirección, categoría, pistas de cuenta) para asignar cada transacción a una
// cuenta del usuario. Se apoya en el proveedor configurado:
//   - gemini    (Google AI Studio, plan gratuito — el que ya usa la app)
//   - openai    (GPT-4o mini, pago por uso)
//   - anthropic (Claude Haiku, pago por uso)
// Errores clasificados con el mismo vocabulario que Cuentas (invalid_key,
// forbidden, quota, model_missing, overloaded, network).
import { suggestAccountForImage } from "./accounts.js";

const MODEL_DEFAULTS = {
  gemini: ["gemini-2.5-flash", "gemini-2.0-flash"],
  openai: ["gpt-4o-mini"],
  anthropic: ["claude-3-5-haiku-latest"],
};

export function normalizeProvider(p) {
  const id = String(p || "").toLowerCase().trim();
  return MODEL_DEFAULTS[id] ? id : (process.env.AI_PROVIDER || "gemini");
}

/** Modelos a probar para un proveedor (primero el pedido/env, luego fallback). */
export function modelsFor(provider, requested) {
  const defaults = MODEL_DEFAULTS[provider] || MODEL_DEFAULTS.gemini;
  const list = [requested, process.env.AI_MODEL].filter(Boolean);
  return [...new Set([...list, ...defaults])];
}

/** Clasifica el HTTP status en un código accionable (mismo lenguaje que Cuentas). */
export function classifyAiError(status) {
  if (status === 400) return "invalid_key";
  if (status === 401 || status === 403) return "forbidden";
  if (status === 429) return "quota";
  if (status === 404) return "model_missing";
  if (status === 500 || status === 502 || status === 503) return "overloaded";
  return "network";
}

function extractJSON(text) {
  if (!text) return null;
  const match = String(text).match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/** Prompt que pide a la IA el JSON mínimo y predecible. */
function buildPrompt(today, categories, accounts) {
  const catNames = Array.isArray(categories)
    ? categories.filter((c) => !c.system).map((c) => c.name).join(", ")
    : "";
  const accNames = Array.isArray(accounts)
    ? accounts.map((a) => `${a.name}${a.currency ? " (" + a.currency + ")" : ""}`).join(", ")
    : "";
  return `Analiza esta imagen financiera (recibo/ticket, captura de la app del banco con lista de movimientos, o comprobante de UNA transferencia). Hoy es ${today}.

Devuelve SOLO un objeto JSON válido (sin texto adicional) con esta forma exacta:
{
  "type": "receipt" | "statement" | "transfer",
  "merchant": "comercio, banco o tarjeta visible" | null,
  "date": "AAAA-MM-DD" | null,
  "currency": "EUR" | "USD" | "MXN" | "GBP" | ... | null,
  "total": 123.45 | null,
  "transactions": [
    { "description": "...", "amount": 12.34, "direction": "out"|"in", "category": "..."|null }
  ],
  "accountHints": ["nombres/últimos dígitos del banco o tarjeta visibles en la imagen"],
  "confidence": 0.0 a 1.0
}

Reglas:
- importes SIEMPRE positivos, con punto decimal.
- "direction": "out" = gasto/cargo/salida; "in" = ingreso/abono/entrada. fecha "AAAA-MM-DD" (si falta el año usa ${new Date().getFullYear()}).
- "receipt" → una transacción (o varias si hay varias partidas claras).
- "statement" → UNA por movimiento visible (varias fechas/importes).
- "transfer" → la transacción en "transactions" CON su dirección según sea cargo o abono.
- Categorías disponibles del usuario: ${catNames || "ninguna"}. Usa una de ellas en category o null.
- accountHints: SOLO lo que la imagen diga del banco/tarjeta/cuenta (p. ej. "BBVA *1234", "Santander", "Caixa"); SI la imagen no menciona la entidad, deja [].
- Cuentas del usuario (por si la imagen coincide): ${accNames || "ninguna"}.
- NO inventes datos: si algo no se ve, null/[].
- confidence: qué tan seguro estás de la lectura (baja <0.6 implica revisión manual).`;
}

async function callGemini(mime, base64, prompt, apiKey, models) {
  const body = {
    contents: [{ parts: [{ inline_data: { mime_type: mime, data: base64 } }, { text: prompt }] }],
    generationConfig: { response_mime_type: "application/json", temperature: 0 },
  };
  let last = null;
  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    let res;
    try {
      res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    } catch (e) {
      const err = new Error(`API de IA sin conexión: ${e.message}`);
      err.aiCode = "network";
      throw err;
    }
    if (res.status === 404 && models.length > 1) { last = res.status; continue; }
    if (!res.ok) {
      const t = await res.text();
      const err = new Error(`API de IA ${res.status}: ${t.slice(0, 200)}`);
      err.aiCode = classifyAiError(res.status);
      throw err;
    }
    const out = await res.json();
    const text = (out.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
    const parsed = extractJSON(text);
    if (!parsed) { const e = new Error("La IA no devolvió JSON válido"); e.aiCode = "network"; throw e; }
    return parsed;
  }
  const err = new Error("Ningún modelo Gemini disponible (404)");
  err.aiCode = "model_missing";
  throw err;
}

async function callOpenAI(mime, base64, prompt, apiKey, models) {
  const dataUri = `data:${mime};base64,${base64}`;
  const body = {
    model: models[0],
    messages: [
      { role: "system", content: "Eres un contable. Respondes solo JSON." },
      { role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: dataUri } }] },
    ],
    response_format: { type: "json_object" },
    temperature: 0,
  };
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    const err = new Error(`API OpenAI ${res.status}: ${t.slice(0, 200)}`);
    err.aiCode = classifyAiError(res.status);
    throw err;
  }
  const out = await res.json();
  const text = out.choices?.[0]?.message?.content || "";
  const parsed = extractJSON(text);
  if (!parsed) { const e = new Error("OpenAI no devolvió JSON válido"); e.aiCode = "network"; throw e; }
  return parsed;
}

async function callAnthropic(mime, base64, prompt, apiKey, models) {
  const body = {
    model: models[0],
    max_tokens: 1500,
    temperature: 0,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: mime.startsWith("image") ? mime : "image/jpeg", data: base64 } },
          { type: "text", text: prompt },
        ],
      },
    ],
  };
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    const err = new Error(`API Anthropic ${res.status}: ${t.slice(0, 200)}`);
    err.aiCode = classifyAiError(res.status);
    throw err;
  }
  const out = await res.json();
  const text = (out.content || []).map((p) => p.text || "").join("");
  const parsed = extractJSON(text);
  if (!parsed) { const e = new Error("Anthropic no devolvió JSON válido"); e.aiCode = "network"; throw e; }
  return parsed;
}

/**
 * Clasifica UNA imagen financiera.
 * @param {object} image - { mime, base64 }
 * @param {object} opts - { provider, apiKey, model, categories, accounts, aliases }
 * @returns {Promise<object>} resultado normalizado + `accountId` sugerido.
 */
export async function classifyImage({ mime, base64 }, opts = {}) {
  const provider = normalizeProvider(opts.provider);
  const apiKey = opts.apiKey || process.env[ENV_KEY[provider]];
  if (!apiKey) {
    const err = new Error("Falta la clave de IA (configúrala en Ajustes o en el entorno)");
    err.aiCode = "no_key";
    throw err;
  }
  const today = new Date().toISOString().slice(0, 10);
  const prompt = buildPrompt(today, opts.categories, opts.accounts);
  const models = modelsFor(provider, opts.model);

  let data;
  if (provider === "gemini") data = await callGemini(mime || "image/jpeg", base64, prompt, apiKey, models);
  else if (provider === "openai") data = await callOpenAI(mime || "image/jpeg", base64, prompt, apiKey, models);
  else if (provider === "anthropic") data = await callAnthropic(mime || "image/jpeg", base64, prompt, apiKey, models);
  else throw Object.assign(new Error(`Proveedor IA no soportado: ${provider}`), { aiCode: "network" });

  // --- Normalización y saneado -----------------------------
  const result = {
    type: ["receipt", "statement", "transfer"].includes(data.type) ? data.type : "receipt",
    merchant: data.merchant ? String(data.merchant).slice(0, 60) : null,
    date: /^\d{4}-\d{2}-\d{2}$/.test(String(data.date || "")) ? data.date : null,
    currency: ["EUR", "USD", "MXN", "GBP", "BTC", "ETH"].includes(String(data.currency || "").toUpperCase())
      ? String(data.currency).toUpperCase()
      : null,
    total: isFinite(+data.total) ? Math.abs(+data.total) : null,
    accountHints: Array.isArray(data.accountHints) ? data.accountHints.map(String).slice(0, 4) : [],
    confidence: Math.max(0, Math.min(1, +data.confidence || 0.5)),
    transactions: (Array.isArray(data.transactions) ? data.transactions : [])
      .map((t) => ({
        description: String(t.description || data.merchant || "Movimiento").slice(0, 80),
        amount: isFinite(+t.amount) ? Math.abs(+t.amount) : null,
        direction: t.direction === "in" ? "in" : "out",
        category: t.category ? String(t.category).slice(0, 40) : null,
        date: /^\d{4}-\d{2}-\d{2}$/.test(String(t.date || "")) ? t.date : resultDate(data.date),
      }))
      .filter((t) => t.amount != null && t.amount > 0),
  };

  // Si la IA no emitió transacciones pero sí total, crear una genérica.
  if (result.transactions.length === 0 && result.total != null) {
    result.transactions = [{
      description: result.merchant || "Movimiento",
      amount: result.total,
      direction: "out",
      category: null,
      date: result.date,
    }];
  }

  // Sugerencia de cuenta (banco/tarjeta → cuenta del usuario).
  const suggested = suggestAccountForImage(result, opts.accounts, opts.aliases);
  result.accountHint = suggested.hint;
  result.accountId = suggested.account ? suggested.account.id : null;
  result.accountName = suggested.account ? suggested.account.name : null;
  result.accountConfident = suggested.confident;

  return result;
}

function resultDate(date) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(date || "")) ? date : null;
}

const ENV_KEY = { gemini: "GEMINI_API_KEY", openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY" };