// ---------- Monedas y conversión ----------

export const CURRENCIES = ["EUR", "USD", "GBP", "MXN", "BTC", "ETH"];

export const CURRENCY_SYMBOL = {
  EUR: "€",
  USD: "$",
  GBP: "£",
  MXN: "MX$",
  BTC: "₿",
  ETH: "Ξ",
};

// Tasas base: 1 unidad de la divisa expresada en EUR.
export const BASE_FX = {
  EUR: 1,
  USD: 0.92,
  GBP: 1.17,
  MXN: 0.05,
  BTC: 61500,
  ETH: 3120,
};

export function toEUR(amount, currency, fx) {
  return amount * (fx[currency] ?? 1);
}

export function convert(amount, from, to, fx) {
  return (amount * (fx[from] ?? 1)) / (fx[to] ?? 1);
}

// Separadores por divisa: MXN/USD usan miles "," y decimal "." (formato en-US);
// EUR/GBP usan miles "." y decimal "," (formato es-ES).
const MONEY_LOCALE = { USD: "en-US", MXN: "en-US", EUR: "es-ES", GBP: "es-ES" };

export function fmtMoney(amount, currency = "EUR", opts = {}) {
  const digits = currency === "BTC" || currency === "ETH" ? 5 : 2;
  if (currency === "BTC" || currency === "ETH") {
    return `${amount.toFixed(digits)} ${currency}`;
  }
  return new Intl.NumberFormat(MONEY_LOCALE[currency] || "es-ES", {
    style: "currency",
    currency,
    maximumFractionDigits: opts.compact ? 0 : digits,
    // Siempre notación estándar: mostrar la cifra completa con separadores de
    // miles (ej. MX$1,234,567), nunca abreviada con "M"/"K".
    notation: "standard",
  }).format(amount);
}

export function fmtPct(x, digits = 2) {
  const sign = x > 0 ? "+" : "";
  return `${sign}${(x * 100).toFixed(digits)} %`;
}

// ---------- Categorías (editables por el usuario; estas son las de fábrica) ----------

export const DEFAULT_CATEGORIES = [
  { id: "cat-comida", name: "Comida", type: "expense", color: "#ff8a5c", keywords: ["dominos", "pizza", "restaurante", "cena", "comida", "almuerzo", "desayuno", "burger", "mcdonald", "kebab", "sushi", "bar", "cafe", "café", "glovo", "ubereats", "just eat"] },
  { id: "cat-super", name: "Supermercado", type: "expense", color: "#2ee6a8", keywords: ["mercadona", "carrefour", "lidl", "aldi", "dia", "supermercado", "eroski", "alcampo"] },
  { id: "cat-transporte", name: "Transporte", type: "expense", color: "#5b8cff", keywords: ["uber", "cabify", "taxi", "metro", "bus", "renfe", "gasolina", "repsol", "cepsa", "parking", "peaje", "tren"] },
  { id: "cat-hogar", name: "Hogar", type: "expense", color: "#8f63ff", keywords: ["alquiler", "hipoteca", "luz", "agua", "gas", "endesa", "iberdrola", "ikea", "leroy", "comunidad"] },
  { id: "cat-subs", name: "Suscripciones", type: "expense", color: "#ff5c7a", keywords: ["netflix", "spotify", "hbo", "disney", "prime", "icloud", "youtube", "suscripcion", "suscripción", "gym", "gimnasio"] },
  { id: "cat-salud", name: "Salud", type: "expense", color: "#4dd6e8", keywords: ["farmacia", "medico", "médico", "dentista", "seguro", "sanitas", "adeslas"] },
  { id: "cat-ocio", name: "Ocio", type: "expense", color: "#f5c451", keywords: ["cine", "concierto", "viaje", "hotel", "vuelo", "ryanair", "vueling", "airbnb", "juego", "steam"] },
  { id: "cat-compras", name: "Compras", type: "expense", color: "#ff7ad9", keywords: ["amazon", "zara", "ropa", "el corte", "fnac", "mediamarkt", "apple", "zapatos"] },
  { id: "cat-ingresos", name: "Ingresos", type: "income", color: "#2ee6a8", keywords: ["nomina", "nómina", "salario", "sueldo", "factura cobrada", "venta", "devolucion", "devolución", "bizum recibido"] },
  { id: "cat-intereses", name: "Intereses", type: "income", color: "#9be15d", system: true, keywords: ["interes", "interés", "intereses", "rendimiento", "cupon", "cupón", "dividendo"] },
  { id: "cat-transfer", name: "Transferencia", type: "system", color: "#aab8d8", system: true, keywords: [] },
  { id: "cat-otros", name: "Otros", type: "expense", color: "#7a8db3", system: true, keywords: [] },
];

/** Categorización inteligente por reglas + puntuación sobre las categorías del usuario. */
export function categorize(description, categories = DEFAULT_CATEGORIES) {
  const d = (description || "").toLowerCase();
  let best = { cat: "Otros", score: 0 };
  for (const c of categories) {
    const score = (c.keywords || []).reduce((s, w) => (w && d.includes(w) ? s + w.length : s), 0);
    if (score > best.score) best = { cat: c.name, score };
  }
  return { category: best.cat, confidence: best.score > 0 ? Math.min(0.6 + best.score / 25, 0.99) : 0.3 };
}

export function catColor(name, categories = DEFAULT_CATEGORIES) {
  return categories.find((c) => c.name === name)?.color || "#7a8db3";
}

export const ACCOUNT_TYPES = {
  checking: "Corriente",
  savings: "Ahorro",
  deposit: "Depósito",
  investment: "Inversión",
  sofipo: "Sofipo",
  credit: "Tarjeta de crédito",
  auto_loan: "Préstamo auto",
};

// Tipos que generan intereses a favor del usuario (configuran tasa + abono).
export const INTEREST_ACCOUNT_TYPES = ["savings", "deposit", "investment", "sofipo"];
// Pasivos: el saldo representa deuda (resta del patrimonio).
export const LIABILITY_ACCOUNT_TYPES = ["credit", "auto_loan"];

const ACCOUNT_TYPE_ORDER = ["checking", "savings", "deposit", "investment", "sofipo", "credit", "auto_loan"];

/** Ordena cuentas: tipo (corriente → ahorro → depósito → inversión → sofipo → crédito → préstamo) y dentro de cada tipo alfabéticamente. */
export function sortedAccounts(accounts) {
  return [...accounts].sort((a, b) => {
    const oa = ACCOUNT_TYPE_ORDER.indexOf(a.type);
    const ob = ACCOUNT_TYPE_ORDER.indexOf(b.type);
    const diff = (oa < 0 ? 99 : oa) - (ob < 0 ? 99 : ob);
    if (diff !== 0) return diff;
    return a.name.localeCompare(b.name, "es");
  });
}

/** Agrupa cuentas por tipo en el orden canónico, con nombre de grupo. Cada grupo: { type, label, accounts }. */
export function groupedAccounts(accounts) {
  const map = {};
  for (const a of sortedAccounts(accounts)) {
    if (!map[a.type]) map[a.type] = [];
    map[a.type].push(a);
  }
  return ACCOUNT_TYPE_ORDER
    .filter((t) => map[t]?.length)
    .map((t) => ({ type: t, label: ACCOUNT_TYPES[t] || t, accounts: map[t] }));
}

// ---------- Parser de lenguaje natural (voz y chat) ----------

const NUM_WORDS = {
  un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6,
  siete: 7, ocho: 8, nueve: 9, diez: 10, veinte: 20, treinta: 30,
  cuarenta: 40, cincuenta: 50, cien: 100, doscientos: 200, quinientos: 500, mil: 1000,
};

function parseAmount(text) {
  const m = text.match(/(\d+(?:[.,]\d+)?)/);
  if (m) return parseFloat(m[1].replace(",", "."));
  for (const [w, n] of Object.entries(NUM_WORDS)) {
    if (new RegExp(`\\b${w}\\b`).test(text)) return n;
  }
  return null;
}

function parseCurrency(text) {
  if (/euro|eur|€/.test(text)) return "EUR";
  if (/d[oó]lar|usd|\$/.test(text)) return "USD";
  if (/libra|gbp|£/.test(text)) return "GBP";
  if (/peso|mxn/.test(text)) return "MXN";
  if (/bitcoin|btc/.test(text)) return "BTC";
  return "EUR";
}

/**
 * Convierte una frase natural en una intención estructurada.
 * Ejemplos: "gasté 20 euros en cena", "ingreso de 1500 nómina",
 * "transfiere 200 de Corriente a Ahorro", "programa una transferencia de 100 el viernes",
 * "ajusta mi límite de gasto a 900".
 */
export function parseIntent(raw, categories = DEFAULT_CATEGORIES) {
  const text = (raw || "").toLowerCase().trim();
  const amount = parseAmount(text);
  const currency = parseCurrency(text);

  if (/l[ií]mite/.test(text) && amount != null) {
    return { type: "set_limit", amount, summary: `Ajustar límite de gasto mensual a ${fmtMoney(amount)}` };
  }

  if (/transfier|transferencia|mueve|pasa\b/.test(text) && amount != null) {
    const scheduled = /programa|mañana|viernes|lunes|martes|mi[eé]rcoles|jueves|s[aá]bado|domingo|d[ií]a (\d+)/.test(text);
    const between = text.match(/de (?:la )?(?:cuenta )?["']?([\wáéíóúñ ]+?)["']? a (?:la )?(?:cuenta )?["']?([\wáéíóúñ ]+)["']?$/);
    return {
      type: scheduled ? "schedule_transfer" : "transfer",
      amount,
      currency,
      fromName: between?.[1]?.trim() || null,
      toName: between?.[2]?.trim() || null,
      summary: `${scheduled ? "Programar transferencia" : "Transferir"} ${fmtMoney(amount, currency)}${between ? ` de «${between[1].trim()}» a «${between[2].trim()}»` : ""}`,
    };
  }

  const isIncome = /ingres|cobr|recib|n[oó]mina|salario|me pagaron/.test(text);
  const isExpense = /gast|pagu[eé]|compr|pag[oé]\b/.test(text) || (!isIncome && amount != null);

  if ((isExpense || isIncome) && amount != null) {
    const descMatch = text.match(/(?:en|de|por)\s+([\wáéíóúñ' ]+)$/);
    const description = descMatch ? descMatch[1].trim() : isIncome ? "Ingreso" : "Gasto";
    const { category, confidence } = categorize(isIncome ? "nómina " + description : description, categories);
    return {
      type: isIncome ? "income" : "expense",
      amount,
      currency,
      description: description.charAt(0).toUpperCase() + description.slice(1),
      category: isIncome ? "Ingresos" : category,
      confidence,
      summary: `${isIncome ? "Registrar ingreso" : "Registrar gasto"} de ${fmtMoney(amount, currency)} — «${description}» (${isIncome ? "Ingresos" : category})`,
    };
  }

  return { type: "unknown", summary: null };
}

// ---------- Fechas ----------

export const DAY_MS = 86_400_000;
export const todayISO = () => new Date().toISOString().slice(0, 10);

export function daysBetween(isoA, isoB) {
  return Math.floor((new Date(isoB) - new Date(isoA)) / DAY_MS);
}

export function fmtDate(iso) {
  return new Date(iso).toLocaleDateString("es-ES", { day: "numeric", month: "short" });
}

export const uid = () => Math.random().toString(36).slice(2, 10);

// ---------- Respaldo / exportación ----------

const BACKUP_VERSION = 1;

/** Slice persistente del estado (sin precios/FX en vivo). */
export function backupPayload(state) {
  const { settings, accounts, assets, transactions, scheduled, categories } = state;
  return {
    app: "mis-finazas",
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    state: { settings, accounts, assets, transactions, scheduled, categories },
  };
}

/** Valida y extrae el estado de un respaldo subido. Lanza si es inválido. */
export function parseBackup(text) {
  const data = JSON.parse(text);
  const state = data?.state ?? data; // admite respaldo nuevo o estado plano
  if (!state || typeof state !== "object" || !Array.isArray(state.accounts)) {
    throw new Error("El archivo no es un respaldo válido de Mis finazas.");
  }
  return state;
}

function downloadBlob(content, filename, type) {
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

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

export function downloadBackup(state) {
  downloadBlob(JSON.stringify(backupPayload(state), null, 2), `mis-finazas-respaldo-${stamp()}.json`, "application/json");
}

// ---- CSV ----

function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csvRow = (cells) => cells.map(csvCell).join(",");

/** CSV único con todas las secciones (cuentas, movimientos, categorías, activos). */
export function buildCSV(state) {
  const acc = (id) => state.accounts.find((a) => a.id === id)?.name || id || "";
  const out = [];

  out.push("# MIS FINAZAS — EXPORTACIÓN COMPLETA");
  out.push(`# Generado: ${new Date().toISOString()}`);
  out.push("");

  out.push("## CUENTAS");
  out.push(csvRow(["Nombre", "Tipo", "Divisa", "Saldo", "Tasa TAE %", "Abono"]));
  for (const a of state.accounts) {
    out.push(csvRow([a.name, ACCOUNT_TYPES[a.type] || a.type, a.currency, a.balance, (a.rate * 100).toFixed(2), a.accrual]));
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

export function downloadCSV(state) {
  // BOM para que Excel reconozca UTF-8 (acentos).
  downloadBlob("﻿" + buildCSV(state), `mis-finazas-export-${stamp()}.csv`, "text/csv;charset=utf-8");
}
