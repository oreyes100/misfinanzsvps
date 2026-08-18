// local.mjs — Parser local de estados de cuenta / recibos (sin Gemini).
// Convierte el texto OCR (líneas "y x\ttexto", ordenadas por posición) en el
// JSON que Hermes espera: { type, merchant, date, total, items, movements, transfer }.
// Sirve como respaldo cuando Gemini no está disponible o como vía principal
// si cfg.ocrOnly es true.

// ---------- utilidades ----------

const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

function parseLines(raw) {
  // Entrada: "y\tx\ttexto" por línea.
  const out = [];
  for (const line of String(raw || "").split("\n")) {
    const m = line.match(/^\s*(\d+)\t(\d+)\t(.*)$/);
    if (!m) continue;
    const text = m[3].trim();
    if (!text) continue;
    out.push({ y: +m[1], x: +m[2], text });
  }
  return out;
}

// ---------- patrones ----------

const MONTHS = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10,
  noviembre: 11, diciembre: 12,
};

// "15 julio 2026" | "15 jul 2026" | "02/06/2026" | "02/06" | "2026-07-15"
function parseDate(t) {
  const s = String(t || "").trim().toLowerCase();
  let m = s.match(/^(\d{1,2})\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\s+(\d{4})$/);
  if (m) return `${m[3]}-${String(MONTHS[m[2]]).padStart(2, "0")}-${String(+m[1]).padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})\s+([a-z]{3})\s+(\d{4})$/);
  if (m) {
    const mon = m[2].slice(0, 3);
    const num = Object.entries(MONTHS).find(([k]) => k.startsWith(mon))?.[1];
    if (num) return `${m[3]}-${String(num).padStart(2, "0")}-${String(+m[1]).padStart(2, "0")}`;
  }
  // dd/mm/yyyy o dd/mm (año por defecto: el más cercano no futuro)
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (m) return `${m[3]}-${String(+m[2]).padStart(2, "0")}-${String(+m[1]).padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[/-](\d{1,2})$/);
  if (m) {
    const dd = +m[1], mm = +m[2];
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      const year = new Date().getFullYear();
      const iso = `${year}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
      return Date.parse(iso) > Date.now() ? `${year - 1}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}` : iso;
    }
  }
  return null;
}

// Importe con $ o signo: "$-9,269.00", "-$368.76", "$300.00", "9,268.96"
function parseAmount(t) {
  const s = String(t || "").replace(/\s/g, "");
  const m = s.match(/^\$?(-?\d[\d,]*\.\d{2})$/);
  if (!m) return null;
  const v = parseFloat(m[1].replace(/,/g, ""));
  if (!isFinite(v)) return null;
  return Math.round(Math.abs(v) * 100) / 100;
}

function isAmountLine(t) {
  const s = String(t || "").replace(/\s/g, "");
  return /^\$?-?\d[\d,]*\.\d{2}$/.test(s);
}

// Importe embebido en una línea: "texto ... $ 535.55" | "$535.55" | "-$368.76" |
// "Enviaste $1,300.00 MXN" | "Monto $ 869.00 M.N."
function embeddedAmount(t) {
  const s = String(t || "").replace(/\s/g, "");
  const m = s.match(/([+-]?\$?\d[\d,]*\.\d{2})(?:MXN|M\.N\.|PESOS|Pesos|USD)?$/i);
  if (!m) return null;
  let v = m[1].replace(/\$/g, "");
  const neg = v.startsWith("-") || /^-\$/.test(m[1]);
  v = v.replace(/,/g, "").replace(/-/g, "");
  const num = parseFloat(v);
  if (!isFinite(num)) return null;
  return { amount: Math.round(Math.abs(num) * 100) / 100, out: !!neg };
}

// Palabras de abono/devolución (direction "in") en tarjetas de crédito.
const IN_WORDS = ["abono", "deposito", "depósito", "devolucion", "devolución", "reembolso", "pago recibido", "spei recibido", "transferencia recibida"];

function isInText(t) {
  const s = norm(t);
  return IN_WORDS.some((w) => s.includes(w));
}

// UI: etiquetas del encabezado/app que no son movimientos (se omiten de la descripción).
const UI_TEXT = ["ultimos movimientos", "movimientos", "ayuda", "volver", "con dinero en cuenta", "consumo", "operacion rechazada", "devolucion", "devolucion amazon"];

function isUI(t) {
  const s = norm(t);
  return UI_TEXT.some((u) => s === u || (s.includes(u) && s.length <= u.length + 8));
}

// Descripciones que delatan transferencias/SPEI/pagos de tarjeta.
const TRANSFER_WORDS = ["spei", "transferencia", "traspaso", "pago de tarjeta", "pago tarjeta", "pago con tarjeta", "retiro cajero", "pago de servicios", "pago servicios", "stp", "clabe"];

function isTransferText(t) {
  const s = norm(t);
  return TRANSFER_WORDS.some((w) => s.includes(w));
}

// Nombres de bancos para resolver la cuenta cuando el estado no lo menciona.
const BANK_HINTS = [
  { bank: "bbva", words: ["bbva", "bancomer"] },
  { bank: "santander", words: ["santander"] },
  { bank: "hsbc", words: ["hsbc"] },
  { bank: "nu", words: ["nu banco", "nu card", "número"] },
  { bank: "invex", words: ["invex"] },
  { bank: "banorte", words: ["banorte"] },
  { bank: "scotiabank", words: ["scotia"] },
  { bank: "amex", words: ["american express", "amex"] },
  { bank: "liverpool", words: ["liverpool"] },
  { bank: "suburbia", words: ["suburbia"] },
  { bank: "didi", words: ["didi"] },
  { bank: "coppel", words: ["coppel"] },
  { bank: "mercado pago", words: ["mercado pago", "mercado"] },
  { bank: "paypal", words: ["paypal"] },
  { bank: "schwab", words: ["schwab"] },
  { bank: "revolut", words: ["revolut"] },
  { bank: "wal mart", words: ["walmart", "waltmart", "wal mart"] },
  { bank: "costco", words: ["costco"] },
  { bank: "bmex", words: ["banco mexicano", "bnmx"] },
];

function guessBank(lines) {
  const all = lines.map((l) => norm(l.text)).join(" ");
  // Estilos de app por formato (más específicos, se evalúan primero):
  // - UALA tarjeta de crédito: "últimos movimientos" + etiquetas "consumo",
  //   "pago de tarjeta de crédito" o "devolución" + fechas dd/mm o dd/mm/yyyy.
  // Va antes que los nombres de banco porque los comercios (MERCADOPAGO, PAYPAL)
  // aparecen como pagos dentro del estado y no deben confundir el banco.
  const hasUltimos = all.includes("ultimos movimientos");
  const hasCardLabels = /consumo|pago de tarjeta|devolucion|operacion rechazada/.test(all);
  const hasShortDate = lines.some((l) => /^\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?$/.test(l.text.trim()));
  if (hasUltimos && hasCardLabels && hasShortDate) return "uala";
  // Nombres explícitos de banco.
  for (const { bank, words } of BANK_HINTS) {
    if (words.some((w) => all.includes(w))) return bank;
  }
  return null;
}

// ---------- parseo por tipo ----------

function parseStatement(lines) {
  // Dos formatos soportados:
  //  A) App BBVA: fecha "15 julio 2026" + línea de importe separada (x alto)
  //     + descripción (x bajo).
  //  B) Tarjeta de crédito: importe embebido al final de la descripción
  //     ("... $ 869.00"), fecha "13/08" en línea propia, etiquetas "Consumo".
  // En ambos, las líneas de un mismo movimiento están verticalmente cercanas
  // (<45px). Agrupamos por proximidad y cada bloque con un importe es un movimiento.
  const ordered = lines.slice().sort((a, b) => a.y - b.y || a.x - b.x);

  // 1) Bloques por proximidad vertical.
  const blocks = [];
  let cur = [];
  let lastY = null;
  for (const l of ordered) {
    if (lastY !== null && l.y - lastY > 45 && cur.length) {
      blocks.push(cur);
      cur = [];
    }
    cur.push(l);
    lastY = l.y;
  }
  if (cur.length) blocks.push(cur);

  // 2) Recorrer bloques: fechas fijan la fecha; bloques con importe = movimiento.
  const movements = [];
  let currentDate = null;
  for (const block of blocks) {
    const dateLine = block.find((l) => parseDate(l.text));
    if (dateLine) currentDate = parseDate(dateLine.text); // la fecha solo actualiza la fecha

    // Importe: línea standalone o embebido al final de una descripción.
    const amtLine = block.find((l) => isAmountLine(l.text));
    const emb = amtLine ? null : block.map((l) => embeddedAmount(l.text)).find((e) => e);
    let amount, out;
    if (amtLine) {
      amount = parseAmount(amtLine.text);
      out = /^-|\$-/.test(amtLine.text);
    } else if (emb) {
      amount = emb.amount;
      out = emb.out;
    } else {
      continue; // bloque de UI sin importe
    }

    const desc = block
      .filter((l) => l !== amtLine && l.text.trim() && !parseDate(l.text))
      .map((l) => l.text.replace(/\s*[+-]?\$\s?\d[\d,]*\.\d{2}$/i, "").replace(/\s+$/g, "").trim()) // quitar importe embebido
      .filter((d) => d && !isUI(d))
      .join(" - ");
    // "Pago de tarjeta de crédito" describe un pago (movimiento in), no es UI.
    const payLine = block.find((l) => /pago de tarjeta/i.test(l.text));
    const description = (payLine ? payLine.text : desc.trim()) || "Movimiento";

    // Dirección: si el importe trae signo - es out; si el bloque dice
    // "Consumo" (cargo de tarjeta) es out; si hay abono/devolución es in.
    const blockText = block.map((l) => l.text).join(" ");
    let direction = out ? "out" : "in";
    if (/consumo|operacion rechazada/i.test(blockText) && !isInText(blockText)) direction = "out";
    else if (isInText(blockText) || /pago de tarjeta/i.test(blockText)) direction = "in";
    movements.push({
      date: currentDate,
      description,
      amount,
      direction,
      isTransfer: isTransferText(description),
      category: null,
    });
  }

  return movements.filter((m) => m.amount > 0);
}

function parseReceipt(lines) {
  // Recibo: total con $ en la parte baja, descripción en la cabecera.
  // items: líneas con importe que no sean el total.
  let merchant = null;
  const items = [];

  // Merchant: primeras líneas no-numéricas.
  for (const l of lines) {
    const t = l.text.trim();
    if (!t) continue;
    if (isAmountLine(t)) break;
    if (t.length > 3 && merchant === null && !/^\d+$/.test(t)) {
      merchant = t;
    }
  }

  // Total: importe asociado a TOTAL/IMPORTE/MONTO. Los tickets de tienda suelen
  // poner "TOTAL" y/o "IMPORTE: $X"; preferimos ese valor sobre el primer
  // importe suelto del documento (que puede ser un subtotal).
  let total = null;
  let labelAmount = null;
  for (const l of lines) {
    const t = l.text.trim();
    if (!t) continue;
    const n = norm(t);
    if (!/(^|\b)(total|importe|monto)(\b|:)/.test(n) || /subtotal/.test(n)) continue;
    const emb = embeddedAmount(t);
    if (emb) {
      labelAmount = emb.amount;
      break;
    }
  }
  if (labelAmount) {
    total = labelAmount;
  } else {
    // Fallback: primer importe del documento.
    for (const l of lines) {
      const t = l.text.trim();
      if (isAmountLine(t)) {
        total = parseAmount(t);
        break;
      }
    }
  }

  for (const l of lines) {
    const t = l.text.trim();
    if (!t || isAmountLine(t)) continue;
    if (isTransferText(t)) continue;
    if (t === merchant) continue;
    items.push({ name: t, amount: null, category: null, subcategory: null });
  }

  return { merchant, total, items: items.slice(0, 20) };
}

function parseTransfer(lines) {
  // Comprobante de transferencia: importe grande + "desde/hacia/para/cuenta".
  // Solo se considera transferencia si hay origen/destino O una keyword fuerte
  // de transferencia (SPEI/CLABE/transferencia), para no confundir un recibo
  // de compra (que tiene importes pero no cuentas) con una transferencia.
  let amount = null;
  let from = null;
  let to = null;
  let keyword = false;
  let title = null;

  // El texto puede venir como "y\tx\ttexto" (parser local) o como líneas planas.
  const ls = lines.map((l) => (typeof l === "string" ? { text: l, y: -1 } : l));

  // Algunas apps ponen la etiqueta ("Cuenta de origen") en una línea y el
  // valor ("...8298") en la siguiente. Cuando detectamos una etiqueta, tomamos
  // el valor de la línea inmediatamente inferior por proximidad de "y".
  const valueBelowLabel = (labelIdx, threshold = 120) => {
    const labelY = ls[labelIdx].y;
    if (labelY < 0) return null;
    for (let i = labelIdx + 1; i < ls.length; i++) {
      const l = ls[i];
      const t = l.text.trim();
      if (!t) continue;
      const dy = l.y - labelY;
      if (dy > threshold) break;
      if (isAmountLine(t) || /(cuenta|origen|destino|destinatario|beneficiario|recibiras|recibirás|recibira|recibirá|enviaste|recibiste|detalle|monto|comision|comisión|estatus|referencia|folio|clave|alias|nombre del)/.test(norm(t))) continue;
      return l;
    }
    return null;
  };

  for (let i = 0; i < ls.length; i++) {
    const l = ls[i];
    const t = l.text.trim();
    if (!t) continue;
    // Importe: standalone ("$1,300.00") o embebido ("Enviaste $1,300.00 MXN").
    const a = isAmountLine(t) ? parseAmount(t) : null;
    const emb = a ? null : embeddedAmount(t);
    if (!amount) {
      if (a) amount = a;
      else if (emb) amount = emb.amount;
    }
    const n = norm(t);
    if (isTransferText(t)) keyword = true;
    if (/enviaste|recibiste|transferencia|comprobante|spei|traspaso/.test(n)) keyword = true;
    // Origen: la línea "CTA **3167" suele estar justo debajo de la etiqueta
    // "Cuenta origen"; capturamos el valor por proximidad y no la etiqueta.
    if (!from) {
      if (/(cuenta origen|cuenta de|de la cuenta|from|desde|origen)/.test(n) && !/recibir/.test(n)) {
        const v = valueBelowLabel(i);
        from = v ? v.text.trim() : t;
      } else if (/^cta\s*\*{2,3}\d/i.test(t)) {
        from = t;
      }
    }
    if (!to) {
      const toLabel = /(cuenta destino|a la cuenta|para la cuenta|hacia la cuenta|destino|beneficiario|a nombre de|transferir a|para el beneficiario|alias del destinatario|destinatario)/.test(n) && !/recibir/.test(n);
      if (toLabel) {
        const v = valueBelowLabel(i);
        to = v ? v.text.trim() : t;
      }
    }
  }

  // En los comprobantes de app, el destinatario es un nombre propio
  // ("Saul Gutierrez Negrete") y el banco ("BBVA MEXICO ...").
  if (!to) {
    const nameLine = ls.find((l) => {
      const t = l.text.trim();
      return /^[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+\s+[A-ZÁÉÍÓÚÑ]/.test(t) && !isAmountLine(t) && !/\d{8,}/.test(t) && !/^\d/.test(t) && !/recibir/.test(t);
    });
    if (nameLine) to = nameLine.text.trim();
  }

  if (amount === null) return null;
  if (!from && !to && !keyword && !title) return null;
  return { amount, from: from ? from.replace(/^.*?:\s*/, "").trim() : null, to: to ? to.replace(/^.*?:\s*/, "").trim() : null };
}

// ---------- API principal ----------

export function parseOcrText(raw) {
  const lines = parseLines(raw);
  if (lines.length === 0) return { ok: false, error: "sin texto OCR" };

  // 1) ¿Estado de cuenta? → hay fecha + varios importes.
  const dates = lines.filter((l) => parseDate(l.text));
  const amounts = lines.filter((l) => isAmountLine(l.text));
  const bank = guessBank(lines);

  if (dates.length >= 1 && amounts.length >= 2) {
    const movements = parseStatement(lines);
    if (movements.length >= 1) {
      return {
        ok: true,
        result: {
          type: "statement",
          merchant: bank,
          date: null,
          total: null,
          items: [],
          movements,
          transfer: null,
          statementBalance: null,
        },
      };
    }
  }

  // 2) ¿Transferencia? → un solo importe + palabras clave.
  const transfer = parseTransfer(lines);
  if (transfer) {
    return {
      ok: true,
      result: { type: "transfer", merchant: bank, date: null, total: transfer.amount, items: [], movements: [], transfer, statementBalance: null },
    };
  }

  // 3) ¿Recibo? → un solo importe.
  const receipt = parseReceipt(lines);
  if (receipt.total > 0) {
    return {
      ok: true,
      result: { type: "receipt", merchant: receipt.merchant || bank, date: null, total: receipt.total, items: receipt.items, movements: [], transfer: null, statementBalance: null },
    };
  }

  return { ok: false, error: "formato de imagen no reconocido" };
}