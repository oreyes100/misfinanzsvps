// utils.ts — Utilidades de Mis Finanzas (tipado completo)
import type {
  Currency, FXRates, Account, AccountType, Category, AppState,
  ParsedIntent,
} from "./types.ts";

// ---------- API base (Capacitor nativo vs. web) ----------

const isNative = typeof window !== "undefined" && window.location.protocol === "capacitor:";
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

/** Remove transactions that reference accounts no longer present in the list.
 * Prevents reappearance of orphaned txs after account deletion (from load/merge/restore/cloud). */
export function cleanOrphanTransactions(accounts: any[], transactions: any[]): any[] {
  if (!Array.isArray(accounts) || accounts.length === 0) return [];
  const accIds = new Set(accounts.map((a: any) => a.id));
  return (Array.isArray(transactions) ? transactions : []).filter((t: any) => t && accIds.has(t.accountId));
}

// Demo base accounts that user can delete to remove the seed model.
// Once deleted, we strip them on load/restore/merge so they don't regenerate from SEED or cloud.
export const DEMO_ACCOUNT_IDS: string[] = ["acc-corriente", "acc-ahorro", "acc-deposito", "acc-usd"];

export function stripDemoAccounts(accounts: any[], deletedIds: string[]): any[] {
  if (!Array.isArray(accounts)) return [];
  if (!deletedIds || !deletedIds.length) return accounts;
  return accounts.filter((a: any) => !deletedIds.includes(a.id));
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

/**
 * Categorización semántica vía embeddings (Top of Mind A).
 * Llama al endpoint propio `/api/categorize` (server.mjs → motor de embeddings
 * de Hermes en el VPS). Si el backend no responde o no hay key, cae a reglas.
 * @param {string} description - Descripción de la transacción
 * @param {Category[]} categories - Categorías del usuario
 * @param {string} [baseUrl] - API_BASE ("" en web, Vercel en capacitor)
 * @returns {Promise<{category:string, confidence:number}>}
 */
export async function categorizeSemanticAsync(
  description: string,
  categories: Category[] = DEFAULT_CATEGORIES,
  baseUrl: string = API_BASE
): Promise<{ category: string; confidence: number }> {
  const fallback = () => categorize(description, categories);
  if (!description?.trim()) return fallback();
  try {
    const res = await fetch(`${baseUrl}/api/categorize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: description, categories: categories.map(({ id, name, type, color, keywords, subcategories, system }) => ({ id, name, type, color, keywords, subcategories, system })) }),
    });
    if (!res.ok) return fallback();
    const data = await res.json();
    if (!data || data.semantic !== true || !data.category) return fallback();
    return { category: data.category, confidence: data.confidence ?? 0.5 };
  } catch {
    return fallback();
  }
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

export function findPotentialDuplicateGroups(transactions: any[]) {
  const map: Record<string, any[]> = {};
  for (const t of transactions) {
    const key = [
      (t.description || '').toLowerCase().trim(),
      t.date || '',
      t.amount,
      t.accountId || ''
    ].join('|');
    if (!map[key]) map[key] = [];
    map[key].push(t);
  }
  return Object.values(map).filter((g: any[]) => g.length > 1);
}

/** Detecta días con demasiadas txs automáticas de interés para una cuenta.
 *  Agrupa por accountId|date y marca el grupo si la suma del día excede el cap matemático. */
export function findInterestAnomalyGroups(transactions: any[], accounts: any[]) {
  const accMap: Record<string, any> = {};
  for (const a of accounts) accMap[a.id] = a;

  const dailyCap = (acc: any, days: number = 1) => {
    const maxRate = Math.max(acc.rate || 0, acc.rate1 || 0, acc.rate2 || 0);
    if (maxRate <= 0 || !acc.balance) return Infinity;
    return acc.balance * (maxRate / 360) * days * 2;
  };

  const byDay: Record<string, any[]> = {};
  for (const t of transactions) {
    if (!t.auto || !['Intereses', 'Impuestos'].includes(t.category)) continue;
    const key = `${t.accountId}|${t.date}`;
    if (!byDay[key]) byDay[key] = [];
    byDay[key].push(t);
  }

  const groups = [];
  for (const [key, txs] of Object.entries(byDay)) {
    const [accId, date] = key.split('|');
    const acc = accMap[accId];
    const positives = txs.filter((t: any) => t.amount > 0);
    if (positives.length < 2) continue; // solo 1 depósito positivo → normal
    const sum = positives.reduce((s: number, t: any) => s + t.amount, 0);
    const cap = acc ? dailyCap(acc, 4) : 0; // 4 días máx para fin de semana largo
    if (sum > cap || positives.length > 3) {
      groups.push({ txs, date, accId, accName: acc?.name || accId, sum, cap });
    }
  }
  return groups;
}

async function callGeminiForDuplicateAnalysis(prompt: string, key: string) {
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { response_mime_type: "application/json", temperature: 0 }
  };
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const out = await res.json();
  const text = out.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  return JSON.parse(text);
}

export async function analyzeDuplicateValidity(txs: any[], geminiKey: string | null | undefined) {
  if (!geminiKey) {
    // Sin IA: duplicados exactos (misma desc+fecha+monto+cuenta) NUNCA son válidos — ocurren por bug de sync
    return {
      isValid: false,
      reason: 'Duplicado exacto (misma descripción, fecha, monto y cuenta). Probable error de sincronización.',
      confidence: 0.85
    };
  }
  const prompt = `Eres un experto en finanzas personales y contabilidad. Estas transacciones tienen exactamente la misma descripción, fecha, monto y cuenta. Determina si es una transacción legítima que ocurre más de una vez el mismo día (por ejemplo, intereses generados durante el fin de semana que se registran el lunes con el mismo monto) o si es un duplicado erróneo causado por un bug de sincronización o respaldo.

Transacciones:
${txs.map((t, i) => `${i+1}. Desc: ${t.description} | Fecha: ${t.date} | Monto: ${t.amount} ${t.currency} | Categoría: ${t.category} | Cuenta: ${t.accountId}`).join('\n')}

Responde SOLO con un objeto JSON válido (sin texto extra):
{"isValid": true o false, "reason": "explicación breve en español", "confidence": número entre 0 y 1}`;
  try {
    return await callGeminiForDuplicateAnalysis(prompt, geminiKey);
  } catch (e) {
    const cat = txs[0]?.category || '';
    const isInterestLike = cat === 'Intereses' || cat === 'Impuestos';
    return {
      isValid: isInterestLike,
      reason: 'Error llamando a la IA. Usando regla local: ' + (isInterestLike ? 'parece válido' : 'posible error'),
      confidence: 0.5
    };
  }
}

export function downloadReportCSV(report: any, filename: string, gran: string, startDate: string, endDate: string, health: any, byGroup?: any, filtered?: any[], fx?: FXRates, baseCur?: Currency) {
  let csv = `# MIS FINAZAS — REPORTE FINANCIERO PERSONAL\n`;
  csv += `# Generado: ${new Date().toISOString()}\n`;
  csv += `# Período: ${startDate || '—'} — ${endDate || '—'} | Agrupación: ${gran}\n`;
  csv += `# (Excluye transferencias internas. Valores convertidos a divisa base.)\n`;
  csv += `# Para gráficas y presentación ejecutiva usa el PDF.\n\n`;

  csv += `## RESUMEN EJECUTIVO\n`;
  csv += `Total Ingresos,${report.totalIncome.toFixed(2)}\n`;
  csv += `Total Gastos,${report.totalExpense.toFixed(2)}\n`;
  csv += `Flujo Neto,${report.net.toFixed(2)}\n`;
  csv += `Tasa de Ahorro,${health ? (health.savingsRate * 100).toFixed(1) + '%' : ''}\n\n`;

  csv += `## POR PERÍODO\n`;
  csv += `Periodo,Ingresos,Gastos,Neto,# Tx\n`;
  report.groups.forEach((g: any) => {
    csv += `${g.period},${g.income.toFixed(2)},${g.expense.toFixed(2)},${(g.income - g.expense).toFixed(2)},${g.count}\n`;
  });
  csv += `\n`;

  csv += `## DESGLOSE INGRESOS POR CATEGORÍA\n`;
  csv += `Categoría,Subtotal,% del Total Ingresos\n`;
  const incTotal = report.totalIncome || 1;
  Object.entries(report.incomeByCat || {}).sort((a: any, b: any) => b[1] - a[1]).forEach(([cat, sub]: any) => {
    csv += `${cat},${sub.toFixed(2)},${((sub / incTotal) * 100).toFixed(1)}%\n`;
  });
  csv += `\n`;

  csv += `## DESGLOSE GASTOS POR CATEGORÍA\n`;
  csv += `Categoría,Subtotal,% del Total Gastos\n`;
  const expTotal = report.totalExpense || 1;
  Object.entries(report.expenseByCat || {}).sort((a: any, b: any) => b[1] - a[1]).forEach(([cat, sub]: any) => {
    csv += `${cat},${sub.toFixed(2)},${((sub / expTotal) * 100).toFixed(1)}%\n`;
  });
  csv += `\n`;

  if (health) {
    csv += `## INDICADORES DE SALUD FINANCIERA\n`;
    csv += `Tasa de Ahorro,${(health.savingsRate * 100).toFixed(1)}%\n`;
    csv += `Fondo de Emergencia (meses),${health.emergencyMonths.toFixed(1)}\n`;
    csv += `Gasto Promedio Mensual,${health.avgExpense.toFixed(2)}\n`;
    csv += `Ingreso Promedio Mensual,${health.avgIncome.toFixed(2)}\n\n`;
    csv += `## RECOMENDACIONES\n`;
    (health.recs || []).forEach((r: any, i: number) => {
      csv += `${i+1}. ${r.text}\n`;
    });
  }

  if (byGroup && Object.keys(byGroup).length > 0) {
    // Monto en divisa base: los totales del reporte están convertidos, el detalle debe cuadrar con ellos.
    const toB = (t: any): number => fx && baseCur ? convert(Math.abs(t.amount || 0), t.currency || baseCur, baseCur, fx) : Math.abs(t.amount || 0);
    csv += `\n## DETALLE DE TRANSACCIONES POR PERÍODO Y CATEGORÍA\n`;
    csv += `# Monto (base) está convertido a la divisa base — esta columna suma igual que los totales del reporte.\n`;
    csv += `Periodo,Categoría,Tipo,Fecha,Descripción,Divisa,Monto original,Monto (base${baseCur ? ' ' + baseCur : ''})\n`;
    let sumIncBase = 0, sumExpBase = 0;
    for (const period of Object.keys(byGroup).sort()) {
      const pg = byGroup[period];
      for (const [cat, txs] of Object.entries(pg.txsByIncomeCat || {})) {
        for (const t of txs as any[]) {
          const b = toB(t); sumIncBase += b;
          csv += `${csvCell(period)},${csvCell(cat)},Ingreso,${csvCell(t.date)},${csvCell(t.description)},${csvCell(t.currency || baseCur || '')},${csvCell(Math.abs(t.amount).toFixed(2))},${csvCell(b.toFixed(2))}\n`;
        }
      }
      for (const [cat, txs] of Object.entries(pg.txsByExpenseCat || {})) {
        for (const t of txs as any[]) {
          const b = toB(t); sumExpBase += b;
          csv += `${csvCell(period)},${csvCell(cat)},Gasto,${csvCell(t.date)},${csvCell(t.description)},${csvCell(t.currency || baseCur || '')},${csvCell(Math.abs(t.amount).toFixed(2))},${csvCell(b.toFixed(2))}\n`;
        }
      }
    }
    csv += `SUMA DETALLE,,Ingreso,,,,,${sumIncBase.toFixed(2)}\n`;
    csv += `SUMA DETALLE,,Gasto,,,,,${sumExpBase.toFixed(2)}\n`;
  }

  csv += `\n# NOTA: Este CSV es datos tabulares. Abre el PDF para gráficas visuales, KPIs ejecutivos y formato profesional de reporte financiero.\n`;

  downloadBlob(csv, filename, 'text/csv;charset=utf-8;');
}

export function downloadReportPDF(report: any, granularity: string, startDate: string, endDate: string, health: any, byGroup?: any, _filtered?: any[], fx?: FXRates, baseCur?: Currency) {
  const title = `MIS FINANZAS — Reporte Financiero Personal`;
  const subtitle = `Estado de Resultados y Análisis por Categorías · ${granularity}`;
  const range = `${startDate || '—'} a ${endDate || '—'}`;
  const gen = new Date().toLocaleString('es-ES');

  const fmt = (n: number) => (n || 0).toFixed(2);
  const pct = (n: number, tot: number) => tot > 0 ? ((n / tot) * 100).toFixed(1) + '%' : '0%';

  const incCats = Object.entries(report.incomeByCat || {}).sort((a: any, b: any) => b[1] - a[1]);
  const expCats = Object.entries(report.expenseByCat || {}).sort((a: any, b: any) => b[1] - a[1]);

  let periodRows = report.groups.map((g: any) =>
    `<tr><td>${g.period}</td><td class="num gain">${fmt(g.income)}</td><td class="num loss">${fmt(g.expense)}</td><td class="num ${g.income - g.expense >= 0 ? 'gain' : 'loss'}">${fmt(g.income - g.expense)}</td><td class="num">${g.count}</td></tr>`
  ).join('');

  let incRows = incCats.map(([cat, sub]: any) =>
    `<tr><td>${cat}</td><td class="num gain">${fmt(sub as number)}</td><td class="num">${pct(sub as number, report.totalIncome)}</td></tr>`
  ).join('') || '<tr><td colspan="3" class="muted">Sin ingresos en el rango</td></tr>';

  let expRows = expCats.map(([cat, sub]: any) =>
    `<tr><td>${cat}</td><td class="num loss">${fmt(sub as number)}</td><td class="num">${pct(sub as number, report.totalExpense)}</td></tr>`
  ).join('') || '<tr><td colspan="3" class="muted">Sin gastos en el rango</td></tr>';

  const recsHtml = (health?.recs || []).map((r: any) => `<li>${r.icon || '•'} ${r.text}</li>`).join('');

  // Inline SVG generators for professional embedded charts (print-safe)
  function makePieSVG(slices: [string, number][], title: string, total: number): string {
    if (!slices.length || total <= 0) return `<div class="muted">Sin datos para ${title}</div>`;
    const R = 58, CX = 68, CY = 68, C = 2 * Math.PI * R;
    let off = 0;
    const colors = ['#0a7d2e', '#2ee6a8', '#5b8cff', '#f5c451', '#ff7ad9', '#8f63ff', '#4dd6e8', '#ff5c7a', '#9be15d', '#c0566e'];
    let paths = '';
    slices.forEach(([, val], i) => {
      const frac = (val as number) / total;
      const dash = `${frac * C} ${C}`;
      const col = colors[i % colors.length];
      paths += `<circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="${col}" stroke-width="22" stroke-dasharray="${dash}" stroke-dashoffset="${-off * C}" transform="rotate(-90 ${CX} ${CY})" />`;
      off += frac;
    });
    const legend = slices.slice(0, 6).map(([lab, val], i) =>
      `<div style="font-size:9px; display:flex; align-items:center; gap:4px; margin:1px 0;">
        <span style="display:inline-block;width:9px;height:9px;background:${colors[i%colors.length]};border-radius:2px;"></span>
        <span>${lab}</span><span style="margin-left:auto; font-family:monospace;">${fmt(val as number)} (${pct(val as number, total)})</span>
      </div>`
    ).join('');
    return `<div style="display:flex; align-items:flex-start; gap:12px;">
      <svg width="136" height="136" viewBox="0 0 136 136">${paths}</svg>
      <div style="min-width:160px;">${legend}</div>
    </div>`;
  }

  function makePeriodBarsSVG(groups: any[]): string {
    if (!groups || !groups.length) return '<div class="muted">Sin periodos</div>';
    const max = Math.max(1, ...groups.map((g: any) => Math.max(g.income, g.expense)));
    const W = 520, H = 92, pad = 6, bw = Math.max(4, (W - pad * 2) / groups.length * 0.42);
    let bars = '';
    groups.forEach((g: any, i: number) => {
      const x = pad + i * ((W - pad * 2) / groups.length);
      const hi = (g.income / max) * (H - 18);
      const he = (g.expense / max) * (H - 18);
      bars += `<rect x="${x}" y="${H - 10 - hi}" width="${bw}" height="${hi}" fill="#0a7d2e" rx="1" />`;
      bars += `<rect x="${x + bw + 1}" y="${H - 10 - he}" width="${bw}" height="${he}" fill="#c41e3a" rx="1" />`;
    });
    return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" style="max-width:100%;height:auto;">${bars}</svg>
    <div style="font-size:8px;color:#555;margin-top:2px;">Verde = Ingresos · Rojo = Gastos (barras lado a lado por período)</div>`;
  }

  const pieIncome = makePieSVG(incCats as any, 'Ingresos', report.totalIncome);
  const pieExpense = makePieSVG(expCats as any, 'Gastos', report.totalExpense);
  const barsSVG = makePeriodBarsSVG(report.groups);

  const totalTx = report.groups.reduce((s: number, g: any) => s + (g.count || 0), 0);

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
  @page { size: A4; margin: 12mm; }
  @media print { body { margin:0; -webkit-print-color-adjust: exact; print-color-adjust: exact; } .no-print{display:none;} }
  body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; font-size: 10.5px; color:#111; background:#fff; padding:12px 18px; line-height:1.35; }
  .brand { color:#1a3c6e; font-weight:700; letter-spacing:.5px; }
  .header { border-bottom:3px solid #1a3c6e; padding-bottom:8px; margin-bottom:10px; }
  h1 { font-size:17px; margin:0; color:#1a3c6e; }
  h2 { font-size:12px; margin:10px 0 4px; color:#1a3c6e; border-bottom:1px solid #d1d5db; padding-bottom:2px; text-transform:uppercase; letter-spacing:0.5px; }
  .kpi-grid { display:grid; grid-template-columns: repeat(4, 1fr); gap:6px; margin:8px 0; }
  .kpi { border:1px solid #d1d5db; background:#f8fafc; padding:6px 8px; border-radius:4px; }
  .kpi .lab { font-size:8px; color:#475569; text-transform:uppercase; }
  .kpi .val { font-size:13px; font-weight:700; font-family: ui-monospace, monospace; }
  .gain { color:#0a7d2e; font-weight:600; }
  .loss { color:#c41e3a; font-weight:600; }
  table { width:100%; border-collapse:collapse; margin:4px 0 10px; font-size:9.5px; }
  th, td { border:1px solid #64748b; padding:3px 5px; text-align:left; }
  th { background:#e0e7ff; font-weight:600; color:#1e3a5f; }
  .num { text-align:right; font-family:ui-monospace, monospace; }
  .section { margin-bottom:8px; }
  .charts { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin:8px 0; }
  .chartbox { border:1px solid #cbd5e1; padding:6px; background:#fff; }
  .muted { color:#64748b; font-style:italic; }
  .footer { margin-top:14px; font-size:8px; color:#475569; border-top:1px solid #cbd5e1; padding-top:6px; }
  .disclaimer { font-size:7.5px; color:#64748b; }
  .meta { font-size:9px; color:#334155; }
</style>
</head><body>
<div class="header">
  <div style="display:flex; justify-content:space-between; align-items:flex-end;">
    <div>
      <h1><span class="brand">MIS FINANZAS</span></h1>
      <div class="meta">${subtitle}</div>
    </div>
    <div style="text-align:right; font-size:9px;">
      <div><strong>Período:</strong> ${range}</div>
      <div>Generado: ${gen}</div>
      <div class="disclaimer">Uso personal · Confidencial</div>
    </div>
  </div>
</div>

<h2>Resumen Ejecutivo (KPIs)</h2>
<div class="kpi-grid">
  <div class="kpi"><div class="lab">Ingresos Totales</div><div class="val gain">${fmt(report.totalIncome)}</div></div>
  <div class="kpi"><div class="lab">Gastos Totales</div><div class="val loss">${fmt(report.totalExpense)}</div></div>
  <div class="kpi"><div class="lab">Flujo Neto</div><div class="val ${report.net >= 0 ? 'gain' : 'loss'}">${fmt(report.net)}</div></div>
  <div class="kpi"><div class="lab"># Transacciones</div><div class="val">${totalTx}</div></div>
</div>

${health ? `<div class="kpi-grid" style="grid-template-columns:repeat(4,1fr);">
  <div class="kpi"><div class="lab">Tasa de Ahorro</div><div class="val ${health.savingsRate >= 0.2 ? 'gain' : ''}">${(health.savingsRate * 100).toFixed(1)}%</div></div>
  <div class="kpi"><div class="lab">Fondo Emergencia</div><div class="val">${Number.isFinite(health.emergencyMonths) ? health.emergencyMonths.toFixed(1) + ' meses' : '—'}</div></div>
  <div class="kpi"><div class="lab">Gasto Prom. / Período</div><div class="val">${fmt(health.avgExpense)}</div></div>
  <div class="kpi"><div class="lab">Ingreso Prom. / Período</div><div class="val">${fmt(health.avgIncome)}</div></div>
</div>` : ''}

<h2>Estado de Resultados — Por Período</h2>
<table>
<thead><tr><th>Período</th><th class="num">Ingresos</th><th class="num">Gastos</th><th class="num">Neto</th><th class="num"># Tx</th></tr></thead>
<tbody>${periodRows}</tbody>
<tfoot><tr style="font-weight:700;background:#f1f5f9;">
  <td>TOTAL</td>
  <td class="num gain">${fmt(report.totalIncome)}</td>
  <td class="num loss">${fmt(report.totalExpense)}</td>
  <td class="num ${report.net >= 0 ? 'gain' : 'loss'}">${fmt(report.net)}</td>
  <td class="num">${totalTx}</td>
</tr></tfoot>
</table>

<div class="section">
  <h2>Distribución por Categorías (Subtotales)</h2>
  <div class="charts">
    <div class="chartbox">
      <strong style="font-size:10px;">Ingresos por Categoría</strong>
      ${pieIncome}
    </div>
    <div class="chartbox">
      <strong style="font-size:10px;">Gastos por Categoría</strong>
      ${pieExpense}
    </div>
  </div>

  <table style="margin-top:4px;">
    <thead><tr><th>Ingresos por Categoría</th><th class="num">Subtotal</th><th class="num">%</th></tr></thead>
    <tbody>${incRows}</tbody>
  </table>
  <table>
    <thead><tr><th>Gastos por Categoría</th><th class="num">Subtotal</th><th class="num">%</th></tr></thead>
    <tbody>${expRows}</tbody>
  </table>
</div>

<h2>Tendencia por Período (Gráfica de Barras)</h2>
<div class="chartbox" style="padding:8px 4px;">${barsSVG}</div>

${health ? `<div class="section">
  <h2>Salud Financiera y Recomendaciones</h2>
  <div style="background:#f8fafc;border:1px solid #cbd5e1;padding:6px 8px;font-size:9.5px;">
    Tasa de ahorro: <strong>${(health.savingsRate * 100).toFixed(1)}%</strong> (objetivo ≥20%) &nbsp;|&nbsp;
    Fondo emergencia: <strong>${Number.isFinite(health.emergencyMonths) ? health.emergencyMonths.toFixed(1) : '∞'} meses</strong> (meta 3–6)
  </div>
  <ul style="margin:6px 0 2px 16px;padding:0;font-size:9.5px;">${recsHtml}</ul>
</div>` : ''}

${(() => {
  if (!byGroup || Object.keys(byGroup).length === 0) return '';
  // Monto base convertido: el detalle debe cuadrar con los totales del reporte (que están en divisa base).
  const toB = (t: any): number => fx && baseCur ? convert(Math.abs(t.amount || 0), t.currency || baseCur, baseCur, fx) : Math.abs(t.amount || 0);
  let rows = '';
  let count = 0;
  let sumIncBase = 0, sumExpBase = 0;
  const MAX = 500;
  for (const period of Object.keys(byGroup).sort()) {
    const pg = byGroup[period];
    for (const [cat, txs] of Object.entries(pg.txsByIncomeCat || {})) {
      for (const t of txs as any[]) {
        const b = toB(t); sumIncBase += b;
        if (count >= MAX) continue;
        rows += `<tr><td>${period}</td><td>${cat}</td><td class="gain">Ingreso</td><td>${t.date}</td><td>${t.description || ''}</td><td>${t.currency || baseCur || ''}</td><td class="num">${fmt(Math.abs(t.amount))}</td><td class="num gain">${fmt(b)}</td></tr>`;
        count++;
      }
    }
    for (const [cat, txs] of Object.entries(pg.txsByExpenseCat || {})) {
      for (const t of txs as any[]) {
        const b = toB(t); sumExpBase += b;
        if (count >= MAX) continue;
        rows += `<tr><td>${period}</td><td>${cat}</td><td class="loss">Gasto</td><td>${t.date}</td><td>${t.description || ''}</td><td>${t.currency || baseCur || ''}</td><td class="num">${fmt(Math.abs(t.amount))}</td><td class="num loss">${fmt(b)}</td></tr>`;
        count++;
      }
    }
  }
  const truncNote = count >= MAX ? `<div class="muted" style="font-size:8px;margin-top:4px;">Mostrando primeras ${MAX} transacciones. Detalle completo en el CSV. Las sumas del pie incluyen TODO el rango.</div>` : '';
  return `<h2>Detalle de Transacciones por Período y Categoría</h2>
<div class="muted" style="font-size:8px;">"Monto (base)" está convertido a la divisa base${baseCur ? ` (${baseCur})` : ''} — esa columna suma igual que los totales del reporte.</div>
<table style="font-size:8.5px;">
<thead><tr><th>Período</th><th>Categoría</th><th>Tipo</th><th>Fecha</th><th>Descripción</th><th>Divisa</th><th class="num">Monto orig.</th><th class="num">Monto (base)</th></tr></thead>
<tbody>${rows || '<tr><td colspan="8" class="muted">Sin transacciones en el rango</td></tr>'}</tbody>
<tfoot>
<tr style="font-weight:700;background:#f1f5f9;"><td colspan="7">SUMA DETALLE — Ingresos (base)</td><td class="num gain">${fmt(sumIncBase)}</td></tr>
<tr style="font-weight:700;background:#f1f5f9;"><td colspan="7">SUMA DETALLE — Gastos (base)</td><td class="num loss">${fmt(sumExpBase)}</td></tr>
</tfoot>
</table>${truncNote}`;
})()}

<div class="footer">
  <div>Mis Finanzas • Reporte generado automáticamente desde datos locales/sincronizados • Valores en divisa base • Excluye transferencias internas.</div>
  <div class="disclaimer">Este documento es solo para uso personal y no constituye asesoría financiera, fiscal o de inversión.</div>
</div>
</body></html>`;

  const w = window.open('', '_blank');
  if (w) {
    w.document.write(html);
    w.document.close();
    setTimeout(() => { w.print(); w.focus(); }, 260);
  }
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
