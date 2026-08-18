// categoryGuard.mjs — Resolución de categoría para el pipeline de ingesta Hermes.
// Port a Node de src/utils.ts DEFAULT_CATEGORIES + categorize(): garantiza que
// ninguna transacción insertada por el server quede con category null.
// Fuente: operación NULL HUNTER (implementation_plan-null-hunter.md).

const DEFAULT_CATEGORIES = [
  { name: "Comida", keywords: ["dominos", "pizza", "restaurante", "cena", "comida", "almuerzo", "desayuno", "burger", "mcdonald", "kebab", "sushi", "bar", "cafe", "café", "glovo", "ubereats", "just eat", "taco", "tacos", "torta", "antojo", "fonda", "lonche", "rappi", "didi food"] },
  { name: "Supermercado", keywords: ["mercadona", "carrefour", "lidl", "aldi", "dia", "supermercado", "eroski", "alcampo", "walmart", "soriana", "chedraui", "costco", "sam's", "oxxo", "bodega aurrera", "heb", "aurrera", "abarrotes", "mercado"] },
  { name: "Transporte", keywords: ["uber", "cabify", "taxi", "metro", "bus", "renfe", "gasolina", "repsol", "cepsa", "parking", "peaje", "tren", "didi", "camion", "camión", "estacionamiento", "caseta", "gasol", "gasolinera", "autobuses", "autobus"] },
  { name: "Hogar", keywords: ["alquiler", "renta", "hipoteca", "luz", "agua", "gas", "endesa", "iberdrola", "ikea", "leroy", "comunidad", "predial", "internet", "teléfono", "telefono", "cable", "megacable", "servicio", "villaval"] },
  { name: "Suscripciones", keywords: ["netflix", "spotify", "hbo", "disney", "prime", "icloud", "youtube", "suscripcion", "suscripción", "gym", "gimnasio"] },
  { name: "Salud", keywords: ["farmacia", "farm", "medico", "médico", "dentista", "seguro", "sanitas", "adeslas", "farmacia"] },
  { name: "Ocio", keywords: ["cine", "concierto", "viaje", "hotel", "vuelo", "ryanair", "vueling", "airbnb", "juego", "steam", "undostres", "boletos"] },
  { name: "Compras", keywords: ["amazon", "zara", "ropa", "el corte", "fnac", "mediamarkt", "apple", "zapatos", "paypal", "temu", "wish", "shein"] },
  { name: "Ingresos", keywords: ["nomina", "nómina", "salario", "sueldo", "factura cobrada", "venta", "devolucion", "devolución", "bizum recibido", "pago de tarjeta", "abono"] },
  { name: "Impuestos", keywords: ["impuesto", "impuestos", "isr", "retención", "retencion", "hacienda", "aeat", "secretaria finanzas", "finanzas"] },
  { name: "Donaciones", keywords: ["donacion", "donación", "caridad", "ong", "diezmo"] },
];

const FALLBACK = "Otros";

/**
 * Resolver categoría por keywords de la descripción (port de src/utils.ts categorize).
 * @param {string} description - Descripción del movimiento.
 * @returns {{category: string, confidence: number, source: string}}
 */
export function resolveCategory(description) {
  const d = String(description || "").toLowerCase();
  let best = { cat: FALLBACK, score: 0 };
  for (const c of DEFAULT_CATEGORIES) {
    const score = (c.keywords || []).reduce((s, w) => (w && d.includes(w) ? s + w.length : s), 0);
    if (score > best.score) best = { cat: c.name, score };
  }
  const confidence = best.score > 0 ? Math.min(0.6 + best.score / 25, 0.99) : 0.3;
  return { category: best.cat, confidence, source: best.cat === FALLBACK ? "fallback" : "keywords" };
}

/**
 * Guardián: garantiza categoría no-null para transacciones del server.
 * @param {object} params
 * @param {string|null} params.category - Categoría ya resuelta (parser/Gemini).
 * @param {string} params.description - Descripción del movimiento.
 * @returns {{category: string, needsCategoryReview: boolean, categoryConfidence: number, categorySource: string}}
 */
export function ensureCategory({ category, description }) {
  if (category && String(category).trim() && String(category) !== "null") {
    return { category, needsCategoryReview: false, categoryConfidence: 1, categorySource: "provided" };
  }
  const r = resolveCategory(description);
  return {
    category: r.category,
    needsCategoryReview: r.category === FALLBACK,
    categoryConfidence: r.confidence,
    categorySource: r.source,
  };
}