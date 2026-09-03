// seed.mjs — Seed de datos demo para cuentas recién creadas (w32-i3).
//
// Espejo server-side del SEED del cliente (src/reducer.ts, src/store.jsx):
// misma forma de estado para que un doc sembrado aquí sea hidratable por la
// app sin transformaciones (hydrate/update_fx esperan fx, priceHistory,
// reviewQueue, etc.). Autocontenido: NO importa de src/ (mismo principio que
// api/_merge.js) y es 100% determinista (sin Math.random) → re-seed
// idempotente y testeable.
//
// El doc demo vive en sync_docs con clave demoSyncCode(username) — derivada
// del username (sha256) — así el server resuelve el doc de un usuario sin
// esquema nuevo ni mappings en memoria, y sobrevive reinicios.
import crypto from "node:crypto";

// Ids de las cuentas demo del modelo base (DEMO_ACCOUNT_IDS en src/utils.ts).
// El usuario demo lleva exactamente estos ids en su campo `accounts`, que
// filterAccounts (src/auth.js) usa para conceder la vista.
export const DEMO_ACCOUNT_IDS = ["acc-corriente", "acc-ahorro", "acc-deposito", "acc-usd"];

// Tasas base: 1 unidad de la divisa expresada en EUR (convención W29).
// Snapshot inicial de semilla: useFX (Frankfurter + Coingecko, cada 30 min)
// lo reemplaza por tasas reales en el primer arranque del cliente.
export const DEMO_FX = {
  EUR: 1,
  USD: 0.92,
  GBP: 1.17,
  MXN: 0.05,
  BTC: 61500,
  ETH: 3120,
};

// Espejo de DEFAULT_CATEGORIES (src/utils.ts) — los ids/names/keywords son
// estables: la app los usa para categorizar (categorize) y colorear.
export const DEMO_CATEGORIES = [
  { id: "cat-comida", name: "Comida", type: "expense", color: "#ff8a5c", keywords: ["dominos", "pizza", "restaurante", "cena", "comida", "almuerzo", "desayuno", "burger", "mcdonald", "kebab", "sushi", "bar", "cafe", "café", "glovo", "ubereats", "just eat", "taco", "tacos", "torta", "antojo", "fonda", "lonche", "rappi", "didi food"], subcategories: ["Abarrotes", "Carbohidratos", "Lácteos", "Carnes", "Frutas y verduras", "Bebidas", "Botana"] },
  { id: "cat-super", name: "Supermercado", type: "expense", color: "#2ee6a8", keywords: ["mercadona", "carrefour", "lidl", "aldi", "dia", "supermercado", "eroski", "alcampo", "walmart", "soriana", "chedraui", "costco", "sam's", "oxxo", "bodega aurrera", "heb"], subcategories: [] },
  { id: "cat-transporte", name: "Transporte", type: "expense", color: "#5b8cff", keywords: ["uber", "cabify", "taxi", "metro", "bus", "renfe", "gasolina", "repsol", "cepsa", "parking", "peaje", "tren", "didi", "camion", "camión", "estacionamiento", "caseta"], subcategories: ["Gasolina", "Transporte público", "Taxi/App", "Estacionamiento"] },
  { id: "cat-hogar", name: "Hogar", type: "expense", color: "#8f63ff", keywords: ["alquiler", "renta", "hipoteca", "luz", "agua", "gas", "endesa", "iberdrola", "ikea", "leroy", "comunidad", "predial", "internet", "teléfono", "telefono", "cable"], subcategories: ["Limpieza", "Servicios", "Mantenimiento", "Muebles"] },
  { id: "cat-subs", name: "Suscripciones", type: "expense", color: "#ff5c7a", keywords: ["netflix", "spotify", "hbo", "disney", "prime", "icloud", "youtube", "suscripcion", "suscripción", "gym", "gimnasio"], subcategories: ["Streaming", "Software", "Gimnasio"] },
  { id: "cat-salud", name: "Salud", type: "expense", color: "#4dd6e8", keywords: ["farmacia", "medico", "médico", "dentista", "seguro", "sanitas", "adeslas"], subcategories: ["Farmacia", "Consulta", "Seguro médico"] },
  { id: "cat-ocio", name: "Ocio", type: "expense", color: "#f5c451", keywords: ["cine", "concierto", "viaje", "hotel", "vuelo", "ryanair", "vueling", "airbnb", "juego", "steam"], subcategories: ["Viajes", "Entretenimiento", "Deportes"] },
  { id: "cat-compras", name: "Compras", type: "expense", color: "#ff7ad9", keywords: ["amazon", "zara", "ropa", "el corte", "fnac", "mediamarkt", "apple", "zapatos"], subcategories: ["Ropa", "Electrónica", "Hogar"] },
  { id: "cat-ingresos", name: "Ingresos", type: "income", color: "#2ee6a8", keywords: ["nomina", "nómina", "salario", "sueldo", "factura cobrada", "venta", "devolucion", "devolución", "bizum recibido"], subcategories: ["Nómina", "Freelance", "Ventas", "Devoluciones"] },
  { id: "cat-intereses", name: "Intereses", type: "income", color: "#9be15d", system: true, keywords: ["interes", "interés", "intereses", "rendimiento", "cupon", "cupón", "dividendo"], subcategories: ["Rendimiento", "Dividendos", "Cupones"] },
  { id: "cat-impuestos", name: "Impuestos", type: "expense", color: "#c0566e", system: true, keywords: ["impuesto", "impuestos", "isr", "retención", "retencion"], subcategories: ["ISR intereses"] },
  { id: "cat-transfer", name: "Transferencia", type: "system", color: "#aab8d8", system: true, keywords: [], subcategories: [] },
  { id: "cat-otros", name: "Otros", type: "expense", color: "#7a8db3", system: true, keywords: [], subcategories: [] },
];

const DAY_MS = 86_400_000;

/** Fecha ISO (yyyy-mm-dd) hace `off` días, anclada a `now` (determinismo). */
function seedDate(off, now) {
  return new Date(now - off * DAY_MS).toISOString().slice(0, 10);
}

/** Historial de precio determinista (48 puntos) alrededor de `current`. */
function seedHistory(current) {
  const arr = [];
  for (let i = 0; i < 48; i++) {
    const wave = Math.sin(i / 6) * 0.008; // ±0.8%, sin aleatoriedad
    arr.push(Math.round(current * (1 + wave * (1 - i / 96)) * 1e6) / 1e6);
  }
  return arr;
}

/**
 * Estado demo inicial para un usuario nuevo — misma forma que el SEED del
 * cliente (reducer.ts SEED / store.jsx SEED): hidratable tal cual.
 * @param {{ email?: string, now?: number }} [opts]
 */
export function buildDemoState({ email = "", now = Date.now() } = {}) {
  const at = (off) => seedDate(off, now);
  return {
    settings: { baseCurrency: "MXN", spendLimit: 1200, biometric: true },
    accounts: [
      { id: "acc-corriente", name: "Corriente", type: "checking", currency: "EUR", balance: 2480.55, rate: 0, accrual: "none", lastAccrual: at(0) },
      { id: "acc-ahorro", name: "Ahorro", type: "savings", currency: "EUR", balance: 9300, rate: 0.031, accrual: "daily", lastAccrual: at(9) },
      { id: "acc-deposito", name: "Depósito 12m", type: "deposit", currency: "EUR", balance: 6000, rate: 0.041, accrual: "monthly", lastAccrual: at(34) },
      { id: "acc-usd", name: "Cuenta USD", type: "savings", currency: "USD", balance: 1800, rate: 0.045, accrual: "daily", lastAccrual: at(9) },
    ],
    assets: {
      crypto: [
        { id: "btc", symbol: "BTC", name: "Bitcoin", qty: 0.082, costBasisEUR: 4350 },
        { id: "eth", symbol: "ETH", name: "Ethereum", qty: 1.4, costBasisEUR: 3980 },
      ],
      gold: { grams: 45, costBasisEUR: 2900 },
      realEstate: [
        { id: "re-1", name: "Piso — Calle Luna 12", valueEUR: 215000, costBasisEUR: 189000, source: "API valoración (Idealista/data, sim.)", featured: true },
      ],
      depreciating: [
        { id: "dep-1", name: "Auto — Mazda 3", kind: "auto", valueEUR: 14000, costBasisEUR: 18000, depRate: 0.15 },
      ],
    },
    // Transacciones demo (ids deterministas como reducer.ts SEED → re-seed
    // idempotente: mergeById conserva una sola copia por id).
    transactions: [
      { id: "tx-1", date: at(1), description: "Dominos Pizza", amount: -18.4, currency: "EUR", category: "Comida", accountId: "acc-corriente", auto: true },
      { id: "tx-2", date: at(2), description: "Mercadona", amount: -64.2, currency: "EUR", category: "Supermercado", accountId: "acc-corriente", auto: true },
      { id: "tx-3", date: at(3), description: "Nómina", amount: 2100, currency: "EUR", category: "Ingresos", accountId: "acc-corriente", auto: true },
      { id: "tx-4", date: at(4), description: "Netflix", amount: -12.99, currency: "EUR", category: "Suscripciones", accountId: "acc-corriente", auto: true },
      { id: "tx-5", date: at(5), description: "Uber", amount: -14.3, currency: "EUR", category: "Transporte", accountId: "acc-corriente", auto: true },
      { id: "tx-6", date: at(6), description: "Iberdrola", amount: -78.6, currency: "EUR", category: "Hogar", accountId: "acc-corriente", auto: true },
      { id: "tx-7", date: at(8), description: "Cine", amount: -21.0, currency: "EUR", category: "Ocio", accountId: "acc-corriente", auto: true },
    ],
    scheduled: [],
    categories: DEMO_CATEGORIES,
    transferAliases: {},
    categoryAliases: {},
    statementPatterns: {},
    fx: { ...DEMO_FX },
    priceHistory: {
      BTC: seedHistory(DEMO_FX.BTC),
      ETH: seedHistory(DEMO_FX.ETH),
      GOLD: seedHistory(68.4),
    },
    goldPriceEUR: 68.4,
    _syncVersion: 1,
    _isDemo: true,
    _demoSeededAt: now,
    _seededEmail: String(email || "").toLowerCase(),
    deletedTransactions: {},
    deletedAccountIds: [],
    deletedAssetIds: [],
    reviewQueue: { pending: [], resolved: [], dismissed: [] },
    pipelineEvents: [],
  };
}

/**
 * Clave del doc demo para un usuario: determinista, cumple ID_RE del server
 * (/^[a-z0-9-]{16,64}$/i). No es el sync code personal del cliente (ese sigue
 * siendo un UUID local); solo identifica el doc de semilla del usuario.
 * @param {string} username
 */
export function demoSyncCode(username) {
  return "demo-" + crypto.createHash("sha256").update(String(username || "").toLowerCase().trim()).digest("hex").slice(0, 27);
}

/** Tipos de cuenta que cuentan como "cuenta de dinero" (no activo/pasivo). */
export const MONEY_ACCOUNT_TYPES = new Set(["checking", "savings", "deposit", "cash", "debit"]);
