// utils.ts — Utilidades de Mis Finanzas (tipado completo)
import type {
  Currency, FXRates, Account, AccountType, Category, AppState,
  ParsedIntent,
} from "./types.ts";

// ---------- API base (Capacitor nativo vs. web) ----------

const isNative = typeof window !== "undefined" &&
  (window.location.hostname === "localhost" || window.location.protocol === "capacitor:");
export const API_BASE: string = isNative ? "https://mis-finazas-gold.vercel.app" : "";

// ---------- Monedas y conversión ----------

export const CURRENCIES: Currency[] = ["EUR", "USD", "GBP", "MXN", "BTC", "ETH"];

export const CURRENCY_SYMBOL: Record<Currency, string> = {
  EUR: "€",
  USD: "$",
  GBP: "£",
  MXN: "MX$",
  BTC: "₿",
  ETH: "Ξ",
};

// Tasas base: 1 unidad de la divisa expresada en EUR.
export const BASE_FX: FXRates = {
  EUR: 1,
  USD: 0.92,
  GBP: 1.17,
  MXN: 0.05,
  BTC: 61500,
  ETH: 3120,
};

export function toEUR(amount: number, currency: Currency, fx: FXRates): number {
  return amount * (fx[currency] ?? 1);
}

export function convert(amount: number, from: Currency, to: Currency, fx: FXRates): number {
  return (amount * (fx[from] ?? 1)) / (fx[to] ?? 1);
}

// Separadores por divisa: MXN/USD usan miles "," y decimal "." (formato en-US);
// EUR/GBP usan miles "." y decimal "," (formato es-ES).
const MONEY_LOCALE: Partial<Record<Currency, string>> = {
  USD: "en-US", MXN: "en-US", EUR: "es-ES", GBP: "es-ES",
};

interface FmtMoneyOpts { compact?: boolean }

export function fmtMoney(amount: number, currency: Currency = "EUR", opts: FmtMoneyOpts = {}): string {
  const digits = currency === "BTC" || currency === "ETH" ? 5 : 2;
  if (currency === "BTC" || currency === "ETH") {
    return `${amount.toFixed(digits)} ${currency}`;
  }
  return new Intl.NumberFormat(MONEY_LOCALE[currency] || "es-ES", {
    style: "currency",
    currency,
    maximumFractionDigits: opts.compact ? 0 : digits,
    notation: "standard",
  }).format(amount);
}

export function fmtPct(x: number, digits: number = 2): string {
  const sign = x > 0 ? "+" : "";
  return `${sign}${(x * 100).toFixed(digits)} %`;
}

// ---------- Categorías ----------

export const DEFAULT_CATEGORIES: Category[] = [
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

interface CategorizeResult { category: string; confidence: number }

export function categorize(description: string, categories: Category[] = DEFAULT_CATEGORIES): CategorizeResult {
  const d = (description || "").toLowerCase();
  let best: { cat: string; score: number } = { cat: "Otros", score: 0 };
  for (const c of categories) {
    const score = (c.keywords || []).reduce((s, w) => (w && d.includes(w) ? s + w.length : s), 0);
    if (score > best.score) best = { cat: c.name, score };
  }
  return { category: best.cat, confidence: best.score > 0 ? Math.min(0.6 + best.score / 25, 0.99) : 0.3 };
}

export function catColor(name: string, categories: Category[] = DEFAULT_CATEGORIES): string {
  return categories.find((c) => c.name === name)?.color || "#7a8db3";
}

export const ACCOUNT_TYPES: Record<AccountType, string> = {
  checking: "Corriente",
  savings: "Ahorro",
  deposit: "Depósito",
  investment: "Inversión",
  sofipo: "Sofipo",
  credit: "Tarjeta de crédito",
  auto_loan: "Préstamo auto",
};

export const INTEREST_ACCOUNT_TYPES: AccountType[] = ["savings", "deposit", "investment", "sofipo"];
export const LIABILITY_ACCOUNT_TYPES: AccountType[] = ["credit", "auto_loan"];

interface DashboardCard { id: string; label: string }

export const DASHBOARD_CARDS: DashboardCard[] = [
  { id: "intereses", label: "Intereses por día" },
  { id: "criptoOro", label: "Cripto y Oro" },
  { id: "inmuebles", label: "Inmuebles" },
  { id: "inversiones", label: "Total de inversiones" },
  { id: "deudas", label: "Total de deudas" },
  { id: "cuentas", label: "Cuentas" },
  { id: "gastosIngresos", label: "Gastos e ingresos" },
];

export const cardOn = (settings: AppState["settings"] | undefined, id: string): boolean =>
  settings?.dashboardCards?.[id] !== false;

const ACCOUNT_TYPE_ORDER: AccountType[] = ["checking", "savings", "deposit", "investment", "sofipo", "credit", "auto_loan"];

export function sortedAccounts(accounts: Account[]): Account[] {
  return [...accounts].sort((a, b) => {
    const oa = ACCOUNT_TYPE_ORDER.indexOf(a.type);
    const ob = ACCOUNT_TYPE_ORDER.indexOf(b.type);
    const diff = (oa < 0 ? 99 : oa) - (ob < 0 ? 99 : ob);
    if (diff !== 0) return diff;
    return a.name.localeCompare(b.name, "es");
  });
}

interface AccountGroup { type: AccountType; label: string; accounts: Account[] }

export function groupedAccounts(accounts: Account[]): AccountGroup[] {
  const map: Partial<Record<AccountType, Account[]>> = {};
  for (const a of sortedAccounts(accounts)) {
    if (!map[a.type]) map[a.type] = [];
    map[a.type]!.push(a);
  }
  return ACCOUNT_TYPE_ORDER
    .filter((t) => map[t]?.length)
    .map((t) => ({ type: t, label: ACCOUNT_TYPES[t] || t, accounts: map[t]! }));
}

// ---------- Parser de lenguaje natural ----------

const NUM_WORDS: Record<string, number> = {
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6,
  siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13,
  catorce: 14, quince: 15, dieciséis: 16, dieciseis: 16, diecisiete: 17,
  dieciocho: 18, diecinueve: 19, veinte: 20, veintiuno: 21, veintiún: 21,
  veintidós: 22, veintidos: 22, veintitrés: 23, veintitres: 23,
  veinticuatro: 24, veinticinco: 25, treinta: 30, cuarenta: 40,
  cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90,
  cien: 100, ciento: 100, doscientos: 200, trescientos: 300, cuatrocientos: 400,
  quinientos: 500, seiscientos: 600, setecientos: 700, ochocientos: 800,
  novecientos: 900, mil: 1000,
};

function parseAmount(text: string): number | null {
  const compMil = text.match(/\b([\wáéíóúñ]+)\s+mil(?:\s+([\wáéíóúñ]+))?\b/);
  if (compMil) {
    const pre = NUM_WORDS[compMil[1]];
    const post = compMil[2] ? NUM_WORDS[compMil[2]] : undefined;
    if (pre) return pre * 1000 + (post || 0);
  }
  const soloMil = text.match(/\bmil(?:\s+([\wáéíóúñ]+))?\b/);
  if (soloMil) {
    const post = soloMil[1] ? NUM_WORDS[soloMil[1]] : undefined;
    return 1000 + (post || 0);
  }
  const compoundHundred = text.match(/\b(ciento|doscientos|trescientos|cuatrocientos|quinientos|seiscientos|setecientos|ochocientos|novecientos)\s+(?:y\s+)?([\wáéíóúñ]+)\b/);
  if (compoundHundred) {
    const h = NUM_WORDS[compoundHundred[1]];
    const r = NUM_WORDS[compoundHundred[2]];
    if (h && r) return h + r;
  }
  const compoundTen = text.match(/\b(treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa)\s+y\s+([\wáéíóúñ]+)\b/);
  if (compoundTen) {
    const t = NUM_WORDS[compoundTen[1]];
    const u = NUM_WORDS[compoundTen[2]];
    if (t && u) return t + u;
  }
  const m = text.match(/(\d+(?:[.,]\d+)?)/);
  if (m) return parseFloat(m[1].replace(",", "."));
  for (const [w, n] of Object.entries(NUM_WORDS)) {
    if (new RegExp(`\\b${w}\\b`).test(text)) return n;
  }
  return null;
}

function parseCurrency(text: string): Currency {
  if (/euro|eur|€/.test(text)) return "EUR";
  if (/d[oó]lar|usd|\$/.test(text)) return "USD";
  if (/libra|gbp|£/.test(text)) return "GBP";
  if (/peso|mxn/.test(text)) return "MXN";
  if (/bitcoin|btc/.test(text)) return "BTC";
  return "MXN";
}

function parseAccountName(text: string): string | null {
  const m = text.match(/(?:de (?:la )?(?:cuenta|tarjeta) )([\wáéíóúñ ]+?)(?:\s*$|\s+(?:en|por|para|a)\b)/);
  if (m) return m[1].trim();
  const m2 = text.match(/(?:con (?:la )?(?:cuenta|tarjeta) )([\wáéíóúñ ]+?)(?:\s*$|\s+(?:en|por|para)\b)/);
  if (m2) return m2[1].trim();
  return null;
}

interface ParseIntentResult extends ParsedIntent {
  subcategory?: string | null;
  confidence?: number;
  accountName?: string | null;
}

type ParseIntentReturn = ParseIntentResult | { type: "unknown"; summary: null };

export function parseIntent(raw: string, categories: Category[] = DEFAULT_CATEGORIES): ParseIntentReturn {
  const text = (raw || "").toLowerCase().trim();
  const amount = parseAmount(text);
  const currency = parseCurrency(text);

  if (/l[ií]mite/.test(text) && amount != null) {
    return { type: "set_limit", amount, currency, summary: `Ajustar límite de gasto mensual a ${fmtMoney(amount)}` };
  }

  if (/transfier|transferencia|transfiere|mueve|mover|pasa\b|pasar\b|mandar?\b|enviar?\b/.test(text) && amount != null) {
    const scheduled = /programa|mañana|viernes|lunes|martes|mi[eé]rcoles|jueves|s[aá]bado|domingo|d[ií]a (\d+)/.test(text);
    const between = text.match(/de (?:la )?(?:cuenta |tarjeta )?["']?([\wáéíóúñ ]+?)["']?\s+a (?:la )?(?:cuenta |tarjeta )?["']?([\wáéíóúñ ]+?)["']?\s*$/);
    return {
      type: scheduled ? "schedule_transfer" : "transfer",
      amount, currency,
      fromName: between?.[1]?.trim() || null,
      toName: between?.[2]?.trim() || null,
      summary: `${scheduled ? "Programar transferencia" : "Transferir"} ${fmtMoney(amount, currency)}${between ? ` de «${between[1].trim()}» a «${between[2].trim()}»` : ""}`,
    };
  }

  const isIncome = /ingres|cobr[eé]|recib[ií]|n[oó]mina|salario|me pagaron|me depositaron|me dieron/.test(text);
  const isExpense = /gast[eé]|pagu[eé]|compr[eé]|pag[oó]\b|cobr[oó]\b|me cobr/.test(text) || (!isIncome && amount != null);

  if ((isExpense || isIncome) && amount != null) {
    const descMatch = text.match(/(?:en|de|por)\s+([\wáéíóúñ' ]+?)(?:\s+(?:de la cuenta|con la|de mi|con mi)\b.*$|$)/);
    const description = descMatch ? descMatch[1].trim() : isIncome ? "Ingreso" : "Gasto";
    const accountName = parseAccountName(text);
    const { category, confidence } = categorize(isIncome ? "nómina " + description : description, categories);
    const sub = matchSubcategory(description, category, categories);
    return {
      type: isIncome ? "income" : "expense",
      amount, currency,
      description: description.charAt(0).toUpperCase() + description.slice(1),
      category: isIncome ? "Ingresos" : category,
      subcategory: sub,
      confidence,
      accountName,
      summary: `${isIncome ? "Registrar ingreso" : "Registrar gasto"} de ${fmtMoney(amount, currency)} — «${description}» (${isIncome ? "Ingresos" : category}${sub ? " › " + sub : ""})${accountName ? ` en cuenta «${accountName}»` : ""}`,
    };
  }

  return { type: "unknown", summary: null };
}

function matchSubcategory(description: string, categoryName: string, categories: Category[]): string | null {
  const cat = categories.find((c) => c.name === categoryName);
  if (!cat?.subcategories?.length) return null;
  const d = (description || "").toLowerCase();
  for (const sub of cat.subcategories) {
    if (d.includes(sub.toLowerCase())) return sub;
  }
  return null;
}

// ---------- Fechas ----------

export const DAY_MS = 86_400_000;
export const todayISO = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

export function daysBetween(isoA: string, isoB: string): number {
  return Math.floor((new Date(isoB).getTime() - new Date(isoA).getTime()) / DAY_MS);
}

export function fmtDate(iso: string): string {
  return new Date(iso + "T12:00:00").toLocaleDateString("es-ES", { day: "numeric", month: "short" });
}

export const uid = (): string => Math.random().toString(36).slice(2, 10);

// ---------- Respaldo / exportación ----------

const BACKUP_VERSION = 1;

export function backupPayload(state: AppState): { app: string; version: number; exportedAt: string; state: Partial<AppState> } {
  const { settings, accounts, assets, transactions, scheduled, categories } = state;
  return {
    app: "mis-finazas",
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    state: { settings, accounts, assets, transactions, scheduled, categories },
  };
}

export function parseBackup(text: string): Partial<AppState> {
  const data = JSON.parse(text);
  const state = data?.state ?? data;
  if (!state || typeof state !== "object" || !Array.isArray(state.accounts)) {
    throw new Error("El archivo no es un respaldo válido de Mis finazas.");
  }
  return state;
}

function downloadBlob(content: string, filename: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const stamp = (): string => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

export function downloadBackup(state: AppState): void {
  downloadBlob(JSON.stringify(backupPayload(state), null, 2), `mis-finazas-respaldo-${stamp()}.json`, "application/json");
}

// ---- CSV ----

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csvRow = (cells: unknown[]): string => cells.map(csvCell).join(",");

export function buildCSV(state: AppState): string {
  const acc = (id: string): string => state.accounts.find((a) => a.id === id)?.name || id || "";
  const out: string[] = [];

  out.push("# MIS FINAZAS — EXPORTACIÓN COMPLETA");
  out.push(`# Generado: ${new Date().toISOString()}`);
  out.push("");

  out.push("## CUENTAS");
  out.push(csvRow(["Nombre", "Tipo", "Divisa", "Saldo", "Tasa TAE %", "Abono", "Tope", "Tasa1 %", "TopeSaldo1", "TopeGanancia1", "Frec1", "Tasa2 %", "TopeSaldo2", "TopeGanancia2", "Frec2"]));
  for (const a of state.accounts) {
    out.push(csvRow([
      a.name, ACCOUNT_TYPES[a.type] || a.type, a.currency, a.balance, (a.rate * 100).toFixed(2), a.accrual,
      a.capped ? "sí" : "no",
      a.capped ? ((a.rate1 || 0) * 100).toFixed(2) : "", a.capped ? (a.balanceCap1 || 0) : "", a.capped ? (a.gainCap1 || 0) : "", a.capped ? a.accrual1 : "",
      a.capped ? ((a.rate2 || 0) * 100).toFixed(2) : "", a.capped ? (a.balanceCap2 || 0) : "", a.capped ? (a.gainCap2 || 0) : "", a.capped ? a.accrual2 : "",
    ]));
  }
  out.push("");

  out.push("## MOVIMIENTOS");
  out.push(csvRow(["Fecha", "Descripción", "Categoría", "Cuenta", "Importe", "Divisa", "Automático"]));
  for (const t of state.transactions) {
    out.push(csvRow([t.date, t.description, t.category, acc(t.accountId), t.amount, t.currency, t.auto ? "sí" : "no"]));
  }
  out.push("");

  out.push("## CATEGORÍAS");
  out.push(csvRow(["Nombre", "Tipo", "Color", "Palabras clave"]));
  for (const c of state.categories) {
    out.push(csvRow([c.name, c.type, c.color, (c.keywords || []).join(" ")]));
  }
  out.push("");

  out.push("## CRIPTO");
  out.push(csvRow(["Símbolo", "Nombre", "Cantidad", "Coste (EUR)"]));
  for (const c of state.assets.crypto) out.push(csvRow([c.symbol, c.name, c.qty, c.costBasisEUR]));
  out.push("");

  out.push("## ORO");
  out.push(csvRow(["Gramos", "Coste (EUR)"]));
  out.push(csvRow([state.assets.gold.grams, state.assets.gold.costBasisEUR]));
  out.push("");

  out.push("## INMUEBLES");
  out.push(csvRow(["Nombre", "Valor (EUR)", "Coste (EUR)", "Fuente", "Destacado"]));
  for (const r of state.assets.realEstate) {
    out.push(csvRow([r.name, r.valueEUR, r.costBasisEUR, r.source, r.featured ? "sí" : "no"]));
  }

  return out.join("\n");
}

export function downloadCSV(state: AppState): void {
  downloadBlob("\uFEFF" + buildCSV(state), `mis-finazas-export-${stamp()}.csv`, "text/csv;charset=utf-8");
}
