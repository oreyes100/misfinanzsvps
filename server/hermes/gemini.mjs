// gemini.mjs — Cliente Gemini para el agente Hermes (port a Node de src/ocr.js).
// aiExtractFromFile: analiza una imagen financiera y devuelve JSON estructurado.
// aiAudit: auditoría comparativa (revisión recursiva de estados de cuenta).

import fs from "node:fs";
import path from "node:path";

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
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    for (const model of GEMINI_MODELS) {
      try {
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
        );
        if (res.status === 404) continue;
        if (res.status === 429) throw new Error("Límite de uso de Gemini alcanzado, espera un momento");
        if (res.status === 400 || res.status === 403) throw new Error("API key de Gemini inválida o sin permisos");
        if (!res.ok) throw new Error(`Gemini respondió ${res.status}`);
        const out = await res.json();
        const text = out.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!text) throw new Error("Gemini no devolvió contenido");
        return JSON.parse(text);
      } catch (e) {
        const retriable = /429|Límite de uso/i.test(String(e.message)) || /404/.test(String(e.message));
        if (retriable && attempt < maxRetries) {
          const delay = 15000 * Math.pow(2, attempt);
          await new Promise((r) => setTimeout(r, delay));
          lastErr = e;
          break; // reintentar con backoff
        }
        if (/404/.test(String(e.message))) {
          lastErr = e;
          continue; // modelo no disponible, probar siguiente
        }
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
 * @param {{categories?: Array, accounts?: Array, statementBalance?: boolean}} opts
 * @returns {Promise<object>} { type, merchant, date, total, items, movements, transfer, statementBalance }
 */
export async function aiExtractFromFile(filePath, apiKey, { categories = [], accounts = [] } = {}) {
  const data = fs.readFileSync(filePath).toString("base64");
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
 "transfer": {"amount": número, "from": "..." | null, "to": "..." | null},
 "statementBalance": número | null
}

Reglas:
- "items" solo para receipt (cada línea de producto). "movements" solo para statement. "transfer" solo para transfer.
- "statementBalance": SOLO para statement, el saldo actual/último saldo visible en la captura (p. ej. "Saldo: $1,234.56" o el total disponible). Si no se ve claramente, null.
- Categorías disponibles: ${catNames}. Subcategorías de Comida y Hogar: ${subcats}. Si dudas de la categoría usa null.
- En statements: dirección "in" = abono/depósito/pago recibido (signo +, verde, flecha entrante); "out" = cargo/compra. Marca isTransfer=true en pagos interbancarios, SPEI, traspasos o pagos de tarjeta.
- Fechas: si falta el año usa 2026. Convierte "08 Jun" → "2026-06-08".
- Importes SIEMPRE positivos, usa punto decimal.
- Cuentas del usuario (por si la imagen menciona alguna): ${accNames}.`;

  return geminiCall([{ text: prompt }, { inline_data: { mime_type: mimeFromPath(filePath), data } }], apiKey);
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