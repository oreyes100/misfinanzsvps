// gemini.mjs — Cliente Gemini para el agente Hermes (port a Node de src/ocr.js).
// aiExtractFromFile: analiza una imagen financiera y devuelve JSON estructurado.
// aiAudit: auditoría comparativa (revisión recursiva de estados de cuenta).

import fs from "node:fs";
import path from "node:path";
// W26: cadena de modelos LLM desde aiConfig.json (primary + fallback), circuit
// breaker por modelo (W1 Fortress) y timeout OBLIGATORIO ≤60s por llamada.
import { loadAIConfig, withTimeout, circuitForProvider } from "./aiClient.mjs";

// --- Configuración de proveedores de embeddings ---
const OLLAMA_BASE = process.env.OLLAMA_BASE || "http://localhost:11434";
const OLLAMA_EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";

const GEMINI_EMBED_MODEL = "gemini-embedding-001";
const OPENAI_EMBED_MODEL = "text-embedding-3-small";

/**
 * Genera embeddings para un texto.
 * @param {string} text - Texto a embeddear
 * @param {string} provider - "ollama" | "openai" | "gemini"
 * @param {string} apiKey - API key (para openai/gemini) o URL base (ollama)
 * @param {string} model - Modelo específico (opcional)
 * @returns {Promise<number[]>} Vector de embeddings
 */
export async function embedText(text, provider = "ollama", apiKey, model) {
  const t = String(text || "").trim();
  if (!t) return [];
  // W26: timeout obligatorio de embeddings (≤60s, default 15s en aiConfig).
  const signal = AbortSignal.timeout(loadAIConfig().embeddings.timeoutMs);

  if (provider === "ollama") {
    const m = model || OLLAMA_EMBED_MODEL;
    const base = apiKey || OLLAMA_BASE;
    const res = await fetch(`${base}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: m, prompt: t }),
      signal,
    });
    if (!res.ok) throw new Error(`Ollama embeddings ${res.status}: ${await res.text()}`);
    const out = await res.json();
    return out.embedding || [];
  }

  if (provider === "openai") {
    const key = apiKey || process.env.OPENAI_API_KEY;
    if (!key) throw new Error("Falta OPENAI_API_KEY");
    const m = model || OPENAI_EMBED_MODEL;
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: m, input: t }),
      signal,
    });
    if (!res.ok) throw new Error(`OpenAI embeddings ${res.status}: ${await res.text()}`);
    const out = await res.json();
    return out.data?.[0]?.embedding || [];
  }

  if (provider === "gemini") {
    const key = apiKey || process.env.GEMINI_API_KEY;
    if (!key) throw new Error("Falta GEMINI_API_KEY");
    const m = model || GEMINI_EMBED_MODEL;
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${m}:embedContent?key=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: { parts: [{ text: t }] } }),
        signal,
      }
    );
    if (!res.ok) throw new Error(`Gemini embeddings ${res.status}: ${await res.text()}`);
    const out = await res.json();
    return out.embedding?.values || [];
  }

  throw new Error(`Proveedor embeddings no soportado: ${provider}`);
}

/**
 * Similaridad coseno entre dos vectores.
 */
export function cosineSimilarity(a, b) {
  if (!a.length || !b.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/**
 * Categorización semántica vía embeddings + k-NN (async).
 * @param {string} description - Descripción de la transacción
 * @param {Array<{text:string, embedding:number[], category:string}>} knownExamples - Ejemplos con embeddings precalculados
 * @param {number} k - Vecinos a considerar
 * @param {string} embedProvider - "ollama" | "openai" | "gemini"
 * @param {string} embedApiKey - API key para el proveedor
 * @returns {Promise<{category:string, confidence:number}>}
 */
export async function categorizeSemanticAsync(
  description,
  knownExamples,
  k = 5,
  embedProvider = "ollama",
  embedApiKey
) {
  if (!description?.trim() || !knownExamples?.length) {
    return { category: "Otros", confidence: 0.3 };
  }
  try {
    const descEmb = await embedText(description, embedProvider, embedApiKey);
    if (!descEmb?.length) return { category: "Otros", confidence: 0.3 };

    const scored = knownExamples
      .filter(x => x.embedding?.length === descEmb.length)
      .map(x => ({ category: x.category, sim: cosineSimilarity(descEmb, x.embedding) }))
      .sort((a, b) => b.sim - a.sim)
      .slice(0, k);

    if (!scored.length) return { category: "Otros", confidence: 0.3 };

    const votes = {};
    for (const s of scored) {
      votes[s.category] = (votes[s.category] || 0) + s.sim;
    }
    const top = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
    const totalSim = scored.reduce((sum, s) => sum + s.sim, 0);
    const confidence = Math.min(0.95, top[1] / (totalSim / scored.length || 1));
    return { category: top[0], confidence };
  } catch {
    return { category: "Otros", confidence: 0.3 };
  }
}

export const SUBCATEGORIES = {
  Comida: [
    { name: "Abarrotes", words: ["arroz", "frijol", "frijoles", "azucar", "azúcar", "sal", "aceite", "harina", "pasta", "atun", "atún", "sopa", "lata", "enlatado", "cafe", "café", "mayonesa", "salsa", "especias", "abarrote"] },
    { name: "Carbohidratos", words: ["pan", "tortilla", "tortillas", "bolillo", "baguette", "cereal", "galleta", "galletas", "papa", "papas", "tostada", "tostadas", "donut", "panque"] },
    { name: "Lácteos", words: ["leche", "queso", "yogur", "yoghurt", "yogurt", "crema", "mantequilla", "huevo", "huevos", "lacteo", "lácteo"] },
    { name: "Carnes", words: ["pollo", "res", "cerdo", "carne", "pescado", "jamon", "jamón", "salchicha", "tocino", "chuleta", "bistec", "molida", "pechuga"] },
    { name: "Frutas y verduras", words: ["manzana", "platano", "plátano", "tomate", "jitomate", "cebolla", "lechuga", "zanahoria", "naranja", "limon", "limón", "aguacate", "fruta", "verdura", "chile", "papaya", "fresa", "uva"] },
    { name: "Bebidas", words: ["agua", "refresco", "coca", "jugo", "cerveza", "vino", "soda", "bebida", "gatorade", "té", "te "] },
    { name: "Botana", words: ["sabritas", "doritos", "papas fritas", "frituras", "botana", "cacahuate", "chocolate", "dulce", "dulces", "chips"] },
  ],
  Hogar: [
    { name: "Limpieza", words: ["jabon", "jabón", "detergente", "cloro", "fabuloso", "pinol", "suavitel", "limpiador", "escoba", "trapeador", "servilleta", "papel higienico", "higiénico", "shampoo", "champú", "pasta dental"] },
  ],
};

const GEMINI_MODELS = ["gemini-2.5-flash", "gemini-2.0-flash"];

function llmModelChain() {
  try {
    const cfg = loadAIConfig();
    const chain = [cfg.llm.primary, ...cfg.llm.fallback].filter((m) => m.startsWith("gemini-"));
    if (chain.length) return [...new Set(chain)];
  } catch { /* fallback a la lista histórica */ }
  return GEMINI_MODELS;
}

const MIME_BY_EXT = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
};

export function mimeFromPath(p) {
  return MIME_BY_EXT[path.extname(p).toLowerCase()] || "image/jpeg";
}

async function geminiCall(parts, apiKey, maxRetries = 2) {
  const body = {
    contents: [{ parts }],
    generationConfig: { response_mime_type: "application/json", temperature: 0 },
  };
  const aiCfg = loadAIConfig();
  const timeoutMs = aiCfg.llm.timeoutMs;
  const models = llmModelChain();
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    for (const model of models) {
      const circuit = circuitForProvider("llm", model);
      if (!circuit.canExecute()) {
        console.warn(`[gemini] ⚠️ ${model} en circuit breaker ${circuit.getState()}, saltando`);
        lastErr = new Error(`${model} circuit open`);
        continue; // modelo en corto, probar siguiente
      }
      const started = Date.now();
      try {
        const res = await withTimeout(
          (signal) => fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
            { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal }
          ),
          timeoutMs,
          `llm/${model}`
        );
        if (res.status === 404) continue;
        if (res.status === 429) throw new Error("Límite de uso de Gemini alcanzado, espera un momento");
        if (res.status === 400 || res.status === 403) throw new Error("API key de Gemini inválida o sin permisos");
        if (!res.ok) throw new Error(`Gemini respondió ${res.status}`);
        const out = await res.json();
        const text = out.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) throw new Error("Gemini no devolvió contenido");
        const parsed = JSON.parse(text);
        circuit.onSuccess();
        console.log(`[gemini] ✅ ${model} respondió en intento ${attempt + 1} (${Date.now() - started}ms)`);
        return parsed;
      } catch (e) {
        const msg = String(e.message || e);
        const latencyMs = Date.now() - started;
        const retriable = /429|Límite de uso/i.test(msg) || /404/.test(msg);
        if (retriable && attempt < maxRetries) {
          if (/429|Límite de uso/i.test(msg)) circuit.onRateLimit();
          else circuit.onFailure();
          const delay = 15000 * Math.pow(2, attempt);
          await new Promise((r) => setTimeout(r, delay));
          lastErr = e;
          break; // reintentar con backoff
        }
        if (/404/.test(msg) || /timeout/i.test(msg)) {
          circuit.onFailure();
          console.warn(`[gemini] ⚠️ ${model} falló (${latencyMs}ms): ${msg} → siguiente modelo`);
          lastErr = e;
          continue; // modelo no disponible o lento → probar siguiente
        }
        // 400/403 (key inválida) o error no recuperable: no quemar el circuit
        // por un error de configuración, pero registrar el fallo y abortar.
        circuit.onFailure();
        throw e;
      }
    }
  }
  throw lastErr || new Error("Ningún modelo Gemini disponible");
}

/**
 * Analiza una imagen financiera con Gemini.
 * @param {string} filePath — ruta local de la imagen.
 * @param {string} apiKey
 * @param {{categories?: Array, accounts?: Array, ocrText?: string|null}} opts
 * @returns {Promise<object>} { type, merchant, date, total, items, movements, transfer, statementBalance }
 */
export async function aiExtractFromFile(filePath, apiKey, { categories = [], accounts = [], ocrText = null, knownExamples = [] } = {}) {
  const data = fs.readFileSync(filePath).toString("base64");
  const catNames = categories.filter((c) => !c.system).map((c) => c.name).join(", ");
  const accNames = accounts.map((a) => a.name).join(", ");

  const prompt = `Analiza esta imagen financiera. Es UNA de estas tres cosas:
- "receipt": ticket/recibo de una compra (super, restaurante, tienda).
- "statement": captura de una app bancaria con una LISTA de movimientos (varias fechas e importes, algunos con signo + o flechas de entrada).
- "transfer": comprobante de UNA transferencia entre cuentas.

Devuelve SOLO un objeto JSON con esta forma exacta (sin texto adicional):
{
 "type": "receipt"|"statement"|"transfer",
 "merchant": "comercio o banco/tarjeta" | null,
 "date": "AAAA-MM-DD" | null,
 "total": número | null,
 "items": [{"name": "...", "amount": número, "category": "...", "subcategory": "..." | null}],
 "movements": [{"date": "AAAA-MM-DD" | null, "description": "...", "amount": número positivo, "direction": "in"|"out", "isTransfer": true|false, "category": "..." | null}],
 "transfer": {"amount": número, "from": "..." | null, "to": "..." | null},
 "statementBalance": número | null
}

Reglas:
- "items" solo para receipt (cada línea de producto). "movements" solo para statement. "transfer" solo para transfer.
- "statementBalance": SOLO para statement, el saldo actual/último saldo visible en la captura (p. ej. "Saldo: $1,234.56" o el total disponible). Si no se ve claramente, null.
- Categorías disponibles: ${catNames}. Si dudas de la categoría usa null.
- En statements: dirección "in" = abono/depósito/pago recibido (signo +, verde, flecha entrante); "out" = cargo/compra. Marca isTransfer=true en pagos interbancarios, SPEI, traspasos o pagos de tarjeta.
- Fechas: si falta el año usa 2026. Convierte "08 Jun" → "2026-06-08".
- Importes SIEMPRE positivos, usa punto decimal.
- Cuentas del usuario (por si la imagen menciona alguna): ${accNames}.`;

  const parts = [{ text: prompt }];
  if (ocrText) {
    parts.push({
      text: `\n[Texto extraído por OCR local (Unlimited-OCR) de la misma imagen. Úsalo si la imagen es ilegible o para confirmar importes, fechas o nombres]:\n${String(ocrText).slice(0, 6000)}`,
    });
  }
  parts.push({ inline_data: { mime_type: mimeFromPath(filePath), data } });
  return geminiCall(parts, apiKey);
}

/**
 * Auditoría comparativa: la IA coteja los movimientos del extracto contra las
 * transacciones registradas y devuelve discrepancias con propuestas de corrección.
 * @param {Object[]} movements
 * @param {Object[]} registered
 * @param {string} apiKey
 * @param {{categories?: Array}} opts
 */
export async function aiAudit(movements, registered, apiKey, { categories = [] } = {}) {
  const catNames = categories.filter((c) => !c.system).map((c) => c.name).join(", ");
  const movs = movements.map((m, i) => ({
    i, date: m.date, description: m.description, amount: m.amount, direction: m.direction,
  }));
  const regs = registered.map((t) => ({
    id: t.id, date: t.date, description: t.description, amount: t.amount,
    category: t.category || null, notes: t.notes || null,
  }));

  const prompt = `Eres un auditor contable meticuloso. Compara el ESTADO DE CUENTA bancario contra los REGISTROS de una app de finanzas personales y detecta TODA discrepancia.

ESTADO DE CUENTA (movimientos extraídos, amount siempre positivo, direction "in"=abono / "out"=cargo):
${JSON.stringify(movs)}

REGISTROS DE LA APP (amount con signo: negativo=gasto, positivo=ingreso):
${JSON.stringify(regs)}

Reglas de emparejamiento:
- Un registro solo puede cubrir UN movimiento del extracto (1 a 1). Dos cargos idénticos del extracto requieren dos registros.
- Match = mismo importe (±0.03), fecha cercana (±3 días) y concepto compatible (los bancos abrevian: "SPEI ENVIADO OXXO" ≈ "Oxxo").
- direction "out" corresponde a amount negativo en registros; "in" a positivo. Si el signo no corresponde, es discrepancia "wrong_sign".

Devuelve SOLO JSON:
{"items":[{
 "kind": "missing"|"phantom"|"amount_mismatch"|"detail_mismatch"|"wrong_sign",
 "severity": "high"|"medium"|"low",
 "movIndex": número | null,
 "txId": "id del registro" | null,
 "date": "AAAA-MM-DD",
 "description": "...",
 "amount": número positivo,
 "direction": "in"|"out",
 "isTransfer": true|false,
 "explanation": "explicación breve en español de la discrepancia",
 "proposal": {"description": "...", "amount": número positivo, "date": "AAAA-MM-DD", "category": "..." | null, "notes": "..."}
}]}

Significados:
- "missing": está en el extracto, NO en registros → proposal = datos para crear el registro. severity high. Si es un pago interbancario, SPEI, traspaso o pago de tarjeta, marca isTransfer=true.
- "phantom": registrado en la app, NO respaldado por el extracto (solo si su fecha cae dentro del período del extracto). severity medium.
- "amount_mismatch": mismo movimiento, importe distinto → proposal.amount = el del extracto. severity medium.
- "detail_mismatch": mismo movimiento, descripción/categoría pobre o equivocada → proposal con descripción clara y categoría sugerida. severity low.
- "wrong_sign": registrado con signo contrario al extracto. severity high.
- Categorías disponibles: ${catNames}. En proposal.category usa una de ellas o null.
- En proposal.notes escribe una nota breve útil (ej. "Detectado en auditoría del extracto, banco reporta ${"${fecha}"}").
- Si TODO cuadra, devuelve {"items":[]}. NO inventes discrepancias.`;

  const out = await geminiCall([{ text: prompt }], apiKey);
  const items = Array.isArray(out?.items) ? out.items : [];
  const VALID = new Set(["missing", "phantom", "amount_mismatch", "detail_mismatch", "wrong_sign"]);
  return {
    items: items.filter((it) => it && VALID.has(it.kind) && isFinite(+it.amount)).map((it) => ({
      ...it,
      amount: Math.abs(+it.amount),
      proposal: it.proposal && typeof it.proposal === "object" ? {
        description: String(it.proposal.description || it.description || "").slice(0, 60),
        amount: isFinite(+it.proposal.amount) ? Math.abs(+it.proposal.amount) : Math.abs(+it.amount),
        date: it.proposal.date || it.date || null,
        category: it.proposal.category || null,
        notes: String(it.proposal.notes || "").slice(0, 200),
      } : null,
    })),
  };
}