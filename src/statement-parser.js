// ---------- Statement Parser — Reconocimiento inteligente de EDCs ----------
// Detecta el banco/origen, aplica patrones específicos y usa aprendizaje
// de correcciones previas del usuario para mejorar el parsing.

// Normalización de texto OCR (quita ruido, normaliza caracteres)
const CLEAN = (s) =>
  (s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9\s$€.,\-/():]/g, " ")
    .replace(/[ \t]+/g, " ") // colapsa espacios/tabs pero preserva \n
    .trim();

const NORM = (s) => CLEAN(s).toLowerCase();

// ---------- Detección de banco/origen ----------

const BANK_PATTERNS = [
  {
    id: "liverpool",
    name: "Liverpool",
    keywords: ["liverpool", "tarjeta clasica", "departamento", "credito liverpool"],
    isTransfer: (d) => /pago (para|a favor|recibido)|abono|deposito|transferencia|spei/i.test(d),
    dateFormats: [
      /(\d{2})\/(\d{2})\/(\d{4})/,
      /(\d{2})-(\d{2})-(\d{4})/,
    ],
  },
  {
    id: "bbva",
    name: "BBVA",
    keywords: ["bbva", "bancomer", "cuenta de cheques", "tarjeta de credito bbva", "linea bbva"],
    isTransfer: (d) => /transferencia|spei|traspaso|pago de servicios?/i.test(d),
    dateFormats: [
      /(\d{2})\/(\d{2})\/(\d{4})/,
      /(\d{2})-(\d{2})-(\d{2,4})/,
    ],
  },
  {
    id: "banamex",
    name: "Citibanamex",
    keywords: ["banamex", "citibanamex", "tarjeta banamex", "cuenta banamex"],
    isTransfer: (d) => /transferencia|spei|traspaso|pago recibido/i.test(d),
    dateFormats: [
      /(\d{2})\/(\d{2})\/(\d{4})/,
    ],
  },
  {
    id: "santander",
    name: "Santander",
    keywords: ["santander", "supercuenta", "tarjeta santander"],
    isTransfer: (d) => /transferencia|spei|traspaso/i.test(d),
    dateFormats: [
      /(\d{2})\/(\d{2})\/(\d{4})/,
    ],
  },
  {
    id: "generic",
    name: "Genérico",
    keywords: ["estado de cuenta", "edc", "movimientos", "cargos", "abonos"],
    isTransfer: (d) => /transferencia|spei|traspaso|pago (para|a favor)|abono (de|por)/i.test(d),
    dateFormats: [
      /(\d{2})\/(\d{2})\/(\d{4})/,
      /(\d{2})-(\d{2})-(\d{4})/,
      /(\d{2})[./-](\d{2})[./-](\d{2,4})/,
    ],
  },
];

// ---------- Parseo de fechas ----------

function parseDate(text, formats) {
  for (const re of formats) {
    const m = text.match(re);
    if (m) {
      let [, d, mo, y] = m;
      if (y.length === 2) y = "20" + y;
      const dd = +d, mm = +mo, yy = +y;
      if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31 && yy >= 2000 && yy <= 2100) {
        return `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
      }
    }
  }
  return null;
}

// ---------- Parseo de importes ----------

// Normaliza un número escrito a la mexicana: 1,234.56 o 1.234,56 → 1234.56
function parseAmount(raw) {
  if (!raw) return null;
  // Quitar símbolos de moneda
  let s = raw.replace(/[$€£MX\s]/g, "");
  // Detectar si usa punto como separador de miles (1.234,56) o como decimal (1,234.56)
  const hasCommaDecimal = /,\d{2}$/.test(s);
  const hasDotDecimal = /\.\d{2}$/.test(s);
  let norm;
  if (hasCommaDecimal) {
    // 1.234,56 → quitar puntos (miles), cambiar coma por punto (decimal)
    norm = s.replace(/\./g, "").replace(",", ".");
  } else if (hasDotDecimal) {
    // 1,234.56 → quitar comas (miles)
    norm = s.replace(/,/g, "");
  } else {
    norm = s.replace(/,/g, "");
  }
  const v = parseFloat(norm);
  return isFinite(v) && v > 0 ? v : null;
}

// Detecta si un texto indica que el importe es negativo (cargo, salida)
function isNegative(line) {
  const l = line.toLowerCase();
  // Indicadores positivos (abonos, pagos recibidos, transferencias entrantes)
  if (/abono|deposito|pago\s+recibido|devolucion|rendimiento|interes\s+a\s+favor|recibid[ao]/i.test(l)) return false;
  // Indicadores negativos (cargos, compras, retiros)
  if (/^-.*|cargo\b|compra|retiro|comision|anualidad|pago\s+(de|realizado|con\s+tarjeta)|salida|cobro|disposicion|impuesto|isr\b/i.test(l)) return true;
  // Default: para tarjetas crédito, la mayoría son cargos
  return true;
}

// ---------- Parseo de líneas individuales ----------

// Agrupa líneas rotas por el OCR que pertenecen al mismo movimiento
function groupLines(lines) {
  const grouped = [];
  let current = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Saltar metadata, encabezados y totales
    if (SKIP_LINES.test(trimmed)) continue;
    const hasDate = /\d{2}[./-]\d{2}[./-]\d{2,4}/.test(trimmed);
    const hasAmount = /\d{1,3}(?:[.,]\d{3})*[.,]\d{2}\b/.test(trimmed);
    if (hasDate && hasAmount && current.length > 0) {
      grouped.push(current.join(" "));
      current = [trimmed];
    } else if (hasDate && hasAmount && current.length === 0) {
      current = [trimmed];
    } else if (current.length > 0 && !hasDate) {
      // Solo anexar si no tiene fecha (es continuación de línea)
      current.push(trimmed);
    }
    // Si no tiene grupo activo y no tiene fecha+importe, ignorar
  }
  if (current.length > 0) grouped.push(current.join(" "));
  return grouped;
}

// Líneas que no son movimientos (metadata, totales, resúmenes)
const SKIP_LINES = /^total\b|subtotal|iva\b|saldo\b|^pago\s+(minimo|para no generar)|fecha corte|limite de credito|tasa\b|cat\b|interes|comision\b|folio\b|referencia|^[A-Z\s]{10,}$/i;

// ---------- Parser principal ----------

/**
 * Parsea texto OCR de un estado de cuenta y extrae movimientos estructurados.
 * Usa patrones aprendidos (statementPatterns) para mejorar precisión.
 *
 * @param {string} rawText — texto OCR completo del estado de cuenta
 * @param {Object} [options]
 * @param {Object} [options.statementPatterns] — patrones aprendidos { rawKey → { description, category, direction, accountId } }
 * @param {Object[]} [options.accounts] — cuentas del usuario (para resolver alias)
 * @returns {{ movements: Array, merchant: string, detectedBank: string|null }}
 */
export function parseStatement(rawText, options = {}) {
  const { statementPatterns = {}, accounts = [] } = options;
  if (!rawText) return { movements: [], merchant: "", detectedBank: null };

  const text = CLEAN(rawText);
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);

  // 1. Detectar banco
  const lower = text.toLowerCase();
  const detectedBank = BANK_PATTERNS.find((b) =>
    b.keywords.some((k) => lower.includes(k))
  ) || BANK_PATTERNS[BANK_PATTERNS.length - 1]; // fallback a genérico

  // 2. Extraer merchant (primeras líneas significativas)
  const merchant = lines
    .slice(0, 3)
    .find((l) => l.length > 5 && l.length < 80 && /[a-záéíóú]/i.test(l))
    ?.replace(/[^a-zA-Záéíóúñ\s]/g, "")
    .trim()
    .slice(0, 50) || "";

  // 3. Agrupar líneas en movimientos
  const grouped = groupLines(lines);

  // 4. Parsear cada grupo
  const movements = [];
  const seen = new Set();

  for (const block of grouped) {
    if (SKIP_LINES.test(block)) continue;

    const date = parseDate(block, detectedBank.dateFormats);
    if (!date) continue;

    // Extraer todos los importes del bloque
    const amounts = [];
    const amountRe = /\d{1,3}(?:[.,]\d{3})*[.,]\d{2}/g;
    let am;
    while ((am = amountRe.exec(block)) !== null) {
      const v = parseAmount(am[0]);
      if (v) amounts.push(v);
    }
    if (amounts.length === 0) continue;

    // El importe principal es el último (suele ser el neto del movimiento)
    const amount = amounts[amounts.length - 1];
    if (!amount || amount > 9999999) continue;

    // Descripción: limpiar fechas e importes del bloque
    let description = block
      .replace(/\d{2}[./-]\d{2}[./-]\d{2,4}/g, "")
      .replace(/\d{1,3}(?:[.,]\d{3})*[.,]\d{2}/g, "")
      .replace(/[-+]\s*/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 60);

    if (!description || description.length < 2) continue;

    // Detectar dirección
    const direction = isNegative(block) ? "out" : "in";
    const isTransfer = detectedBank.isTransfer(description);

    // Evitar duplicados (misma fecha + mismo importe)
    const key = `${date}|${amount}|${direction}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // 5. Aplicar patrones aprendidos
    const patternKey = NORM(description);
    const learned = statementPatterns[patternKey];
    let finalCategory = null;
    if (learned) {
      finalCategory = learned.category || null;
      if (learned.description) description = learned.description;
    }

    movements.push({
      date,
      description,
      amount,
      direction,
      isTransfer,
      category: finalCategory,
      raw: block.slice(0, 200),
    });
  }

  return {
    movements,
    merchant,
    detectedBank: detectedBank.id,
  };
}

// ---------- Aprendizaje: generar patrón desde corrección ----------

/**
 * Genera una clave de patrón a partir del texto raw de un movimiento.
 * Esta clave se guarda en statementPatterns para reutilizarse.
 */
export function makePatternKey(rawText) {
  return NORM(rawText).slice(0, 80);
}

/**
 * Construye el payload para guardar en statementPatterns.
 * Se llama cuando el usuario aplica una corrección.
 */
export function buildPattern(correctionItem, accountId) {
  const rawDesc = correctionItem.mov?.description || correctionItem.description || "";
  const key = makePatternKey(rawDesc);
  if (!key || key.length < 3) return null;

  return {
    key,
    pattern: {
      description: rawDesc,
      category: correctionItem.category || correctionItem.mov?.category || null,
      direction: correctionItem.direction,
      accountId,
      learnedAt: new Date().toISOString(),
      appliedCount: 1,
    },
  };
}

/**
 * Incrementa el contador de uso de un patrón.
 */
export function incrementPattern(pattern) {
  return { ...pattern, appliedCount: (pattern.appliedCount || 0) + 1 };
}

// ---------- Testing ----------

export const __TEST = { CLEAN, NORM, groupLines, parseDate, parseAmount, isNegative, BANK_PATTERNS, SKIP_LINES };

export function testParser() {
  // Ejemplo de texto OCR de un EDC de Liverpool
  const sampleText = `
    ESTADO DE CUENTA LIVERPOOL
    Tarjeta Clásica ************1234
    Fecha de corte: 29/05/2026
    
    FECHA      DESCRIPCION                     IMPORTE
    01/05/2026 Liverpool Perisur               1,250.00
    03/05/2026 Cargo por Anualidad               580.00
    05/05/2026 Pago Recibido                   5,000.00
    10/05/2026 Compra en Amazon MX               849.00
    15/05/2026 Transferencia SPEI Recibida     2,000.00
    20/05/2026 Walmart Supercenter             1,245.50
    25/05/2026 Pago Netflix                      219.00
    
    Pago mínimo: $450.00
    Saldo actual: $4,500.00
    Límite de crédito: $30,000.00
  `;
  return parseStatement(sampleText);
}
