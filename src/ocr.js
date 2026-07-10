// OCR en el navegador (Tesseract.js, sin coste ni API) + lógica de
// subcategorización de recibos y reconocimiento de transferencias.

import { categorize } from "./utils.js";

let _worker = null;

/** Carga perezosa del worker de Tesseract (descarga datos es+en la 1ª vez). */
async function getWorker(onProgress) {
  const { createWorker } = await import("tesseract.js");
  if (_worker) return _worker;
  _worker = await createWorker(["spa", "eng"], 1, {
    logger: (m) => {
      if (m.status === "recognizing text" && onProgress) onProgress(m.progress);
    },
  });
  return _worker;
}

/** Reconoce texto de una imagen (File/Blob/dataURL). Devuelve string. */
export async function ocrImage(file, onProgress) {
  const worker = await getWorker(onProgress);
  const { data } = await worker.recognize(file);
  return data.text || "";
}

// ---------- Subcategorías (para recibos detallados) ----------

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

const aliasNorm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

/** Clasifica una línea de recibo en {category, subcategory}. Alias aprendidos tienen prioridad. */
export function classifyItem(text, categories, categoryAliases = {}) {
  const d = (text || "").toLowerCase();
  // Correcciones aprendidas: texto del ítem → categoría elegida por el usuario.
  const learned = categoryAliases[aliasNorm(text)];
  if (learned) return { category: learned, subcategory: null };
  // Buscar subcategoría dentro de cada categoría
  for (const [parent, subs] of Object.entries(SUBCATEGORIES)) {
    for (const sub of subs) {
      if (sub.words.some((w) => d.includes(w))) {
        return { category: parent, subcategory: sub.name };
      }
    }
  }
  // Si no hay subcategoría, usar el categorizador general
  const { category } = categorize(text, categories);
  return { category, subcategory: null };
}

const MONEY_RE = /(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2}))|(\d+[.,]\d{2})/;

function parseLineAmount(line) {
  const m = line.match(/(\d+[.,]\d{2})\s*$/) || line.match(MONEY_RE);
  if (!m) return null;
  const raw = m[0].trim();
  // normalizar: último separador = decimal
  const norm = raw.replace(/[.,](?=\d{3}\b)/g, "").replace(",", ".");
  const v = parseFloat(norm);
  return isFinite(v) ? v : null;
}

const SKIP_LINE = /total|subtotal|iva|cambio|efectivo|tarjeta|propina|cajero|caja|folio|rfc|gracias|fecha|hora|ticket|importe|pago/i;

/** Extrae una fecha dd/mm/aaaa (o dd-mm-aa) del texto y la devuelve en ISO, o null. */
export function extractDate(text) {
  const m = (text || "").match(/(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})/);
  if (!m) return null;
  let [, d, mo, y] = m;
  if (y.length === 2) y = `20${y}`;
  const dd = +d, mm = +mo;
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31 || +y < 2000 || +y > 2100) return null;
  return `${y}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

/**
 * Parsea el texto de un recibo en ítems clasificados y agrupados por subcategoría.
 * Devuelve { merchant, total, date, items, groups }.
 */
export function parseReceipt(text, categories, categoryAliases = {}) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const merchant = lines[0]?.replace(/[^\wáéíóúñ &.-]/gi, "").trim().slice(0, 40) || "Recibo";
  const date = extractDate(text);

  const items = [];
  let detectedTotal = null;

  for (const line of lines) {
    const amount = parseLineAmount(line);
    if (amount == null) continue;
    if (/^total\b/i.test(line) || /\btotal\b/i.test(line)) {
      detectedTotal = Math.max(detectedTotal || 0, amount);
    }
    if (SKIP_LINE.test(line)) continue;
    const name = line.replace(/(\d+[.,]\d{2}).*$/, "").replace(/\s+/g, " ").trim();
    if (name.length < 2) continue;
    const { category, subcategory } = classifyItem(name, categories, categoryAliases);
    items.push({ name: name.slice(0, 40), amount, category, subcategory });
  }

  // Agrupar por categoría + subcategoría
  const map = new Map();
  for (const it of items) {
    const key = `${it.category}|${it.subcategory || ""}`;
    const g = map.get(key) || { category: it.category, subcategory: it.subcategory, total: 0, count: 0 };
    g.total = Math.round((g.total + it.amount) * 100) / 100;
    g.count += 1;
    map.set(key, g);
  }
  const groups = [...map.values()].sort((a, b) => b.total - a.total);
  const total = detectedTotal || Math.round(items.reduce((s, it) => s + it.amount, 0) * 100) / 100;

  return { merchant, total, date, items, groups };
}

// ---------- Transferencias por captura ----------

const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

/** Resuelve un texto a una cuenta: alias aprendidos primero, luego nombre/alias parecido. */
export function matchAccount(hint, accounts, aliases = {}) {
  return resolveAccount(hint, accounts, aliases);
}

function resolveAccount(hint, accounts, aliases) {
  if (!hint) return null;
  const h = norm(hint);
  if (aliases[h]) {
    const byAlias = accounts.find((a) => a.id === aliases[h]);
    if (byAlias) return byAlias;
  }
  // coincidencia por nombre incluido o palabras clave (banco, últimos dígitos)
  let best = null;
  for (const a of accounts) {
    const an = norm(a.name);
    if (h.includes(an) || an.includes(h)) return a;
    // dígitos finales (p. ej. "*1234")
    const digits = h.match(/\d{3,4}/)?.[0];
    if (digits && norm(a.name).includes(digits)) best = a;
  }
  return best;
}

/**
 * Parsea el texto de una captura de transferencia.
 * Devuelve { amount, from, to, fromHint, toHint, confident }.
 */
export function parseTransfer(text, accounts, aliases = {}) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const joined = text.toLowerCase();

  // importe: el número con decimales más grande de la captura
  let amount = null;
  const amounts = (text.match(/\d{1,3}(?:[.,]\d{3})*[.,]\d{2}/g) || [])
    .map((r) => parseFloat(r.replace(/[.,](?=\d{3}\b)/g, "").replace(",", ".")))
    .filter((v) => isFinite(v));
  if (amounts.length) amount = Math.max(...amounts);

  // pistas de origen/destino por palabras clave comunes en apps bancarias
  const findHint = (re) => {
    for (const l of lines) {
      const m = l.match(re);
      if (m) return (m[1] || l).trim();
    }
    return null;
  };
  const fromHint = findHint(/(?:de|origen|desde|cuenta de retiro|cargo a)[:\s]+(.{2,40})/i);
  const toHint = findHint(/(?:para|destino|a la cuenta|abono a|beneficiario|enviar a)[:\s]+(.{2,40})/i);

  const from = resolveAccount(fromHint, accounts, aliases);
  const to = resolveAccount(toHint, accounts, aliases);
  const confident = !!(amount && from && to && from.id !== to.id);

  return { amount, from, to, fromHint, toHint, confident, raw: joined.slice(0, 200) };
}

// ---------- Motor de IA (Google Gemini, plan gratuito) ----------
// Si el usuario configura su API key en Ajustes, las imágenes se analizan con
// un modelo de visión: mucho más preciso que el OCR local con tickets arrugados
// o capturas de apps bancarias. La imagen se envía directamente a Google.

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

const GEMINI_MODELS = ["gemini-2.5-flash", "gemini-2.0-flash"];

/**
 * Analiza una imagen financiera con Gemini y devuelve JSON estructurado:
 * { type: "receipt"|"statement"|"transfer", merchant, date, total,
 *   items: [{name, amount, category, subcategory}],
 *   movements: [{date, description, amount, direction, isTransfer, category}],
 *   transfer: {amount, from, to} }
 */
export async function aiExtract(file, apiKey, { categories = [], accounts = [] } = {}) {
  const data = await fileToBase64(file);
  const catNames = categories.filter((c) => !c.system).map((c) => c.name).join(", ");
  const subcats = Object.entries(SUBCATEGORIES)
    .map(([p, subs]) => `${p}: ${subs.map((s) => s.name).join(", ")}`)
    .join("; ");
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
 "transfer": {"amount": número, "from": "..." | null, "to": "..." | null}
}

Reglas:
- "items" solo para receipt (cada línea de producto). "movements" solo para statement. "transfer" solo para transfer.
- Categorías disponibles: ${catNames}. Subcategorías de Comida y Hogar: ${subcats}. Si dudas de la categoría usa null.
- En statements: dirección "in" = abono/depósito/pago recibido (signo +, verde, flecha entrante); "out" = cargo/compra. Marca isTransfer=true en pagos interbancarios, SPEI, traspasos o pagos de tarjeta.
- Fechas: si falta el año usa 2026. Convierte "08 Jun" → "2026-06-08".
- Importes SIEMPRE positivos, usa punto decimal.
- Cuentas del usuario (por si la imagen menciona alguna): ${accNames}.`;

  const body = {
    contents: [
      {
        parts: [
          { text: prompt },
          { inline_data: { mime_type: file.type || "image/jpeg", data } },
        ],
      },
    ],
    generationConfig: { response_mime_type: "application/json", temperature: 0 },
  };

  let lastErr = null;
  for (const model of GEMINI_MODELS) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      );
      if (res.status === 404) continue; // modelo no disponible, probar siguiente
      if (res.status === 400 || res.status === 403) throw new Error("API key de Gemini inválida o sin permisos");
      if (res.status === 429) throw new Error("Límite de uso de Gemini alcanzado, espera un momento");
      if (!res.ok) throw new Error(`Gemini respondió ${res.status}`);
      const out = await res.json();
      const text = out.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error("Gemini no devolvió contenido");
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      if (!/404/.test(String(e.message))) throw e;
    }
  }
  throw lastErr || new Error("Ningún modelo Gemini disponible");
}

// ---------- Auditoría comparativa con IA ----------

async function geminiJSON(prompt, apiKey) {
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { response_mime_type: "application/json", temperature: 0 },
  };
  let lastErr = null;
  for (const model of GEMINI_MODELS) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      );
      if (res.status === 404) continue;
      if (res.status === 400 || res.status === 403) throw new Error("API key de Gemini inválida o sin permisos");
      if (res.status === 429) throw new Error("Límite de uso de Gemini alcanzado, espera un momento");
      if (!res.ok) throw new Error(`Gemini respondió ${res.status}`);
      const out = await res.json();
      const text = out.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error("Gemini no devolvió contenido");
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      if (!/404/.test(String(e.message))) throw e;
    }
  }
  throw lastErr || new Error("Ningún modelo Gemini disponible");
}

/**
 * Auditoría comparativa: la IA coteja los movimientos del extracto contra las
 * transacciones registradas y devuelve discrepancias con propuestas de corrección.
 *
 * @param {Object[]} movements — [{date, description, amount(+), direction, isTransfer, category}]
 * @param {Object[]} registered — transacciones de la cuenta [{id, date, description, amount(signed), category, notes}]
 * @param {string} apiKey — Gemini API key
 * @param {Object} opts — { categories }
 * @returns {Promise<{items: Array}>} items: [{kind, severity, date, description, amount, direction, txId, explanation, proposal}]
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
 "explanation": "explicación breve en español de la discrepancia",
 "proposal": {"description": "...", "amount": número positivo, "date": "AAAA-MM-DD", "category": "..." | null, "notes": "..."}
}]}

Significados:
- "missing": está en el extracto, NO en registros → proposal = datos para crear el registro. severity high.
- "phantom": registrado en la app, NO respaldado por el extracto (solo si su fecha cae dentro del período del extracto). severity medium.
- "amount_mismatch": mismo movimiento, importe distinto → proposal.amount = el del extracto. severity medium.
- "detail_mismatch": mismo movimiento, descripción/categoría pobre o equivocada → proposal con descripción clara y categoría sugerida. severity low.
- "wrong_sign": registrado con signo contrario al extracto. severity high.
- Categorías disponibles: ${catNames}. En proposal.category usa una de ellas o null.
- En proposal.notes escribe una nota breve útil (ej. "Detectado en auditoría del extracto, banco reporta ${"${fecha}"}").
- Si TODO cuadra, devuelve {"items":[]}. NO inventes discrepancias.`;

  const out = await geminiJSON(prompt, apiKey);
  const items = Array.isArray(out?.items) ? out.items : [];
  // Sanear: importes numéricos, kinds válidos
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
