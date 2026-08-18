// receiptDetector.js — Detección heurística multi-capa de imágenes financieras.
//
// Capa 1: nombre de archivo (recibo/factura/EDC/comprobante…).
// Capa 2: señales de texto OCR (palabras clave por tipo).
// Capa 3: tamaño del texto extraído (un recibo real rara vez son 2 palabras).
//
// Funciones puras y deterministas → testeables en Node. Alimenta al escáner
// de Google Photos para decidir qué fotos merecen OCR completo.

const RECEIPT_WORDS = [
  "total", "subtotal", "iva", "ticket", "recibo", "caja", "folio", "efectivo",
  "vuelto", "propina", "articulo", "piezas", "mercado", "farmacia", "tienda",
  "compra", "cantidad", "cliente", "atendio",
];

const STATEMENT_WORDS = [
  "estado de cuenta", "edc", "movimientos", "cargo", "abono", "fecha de corte",
  "fecha corte", "saldo", "limite de credito", "tasa", "pago minimo",
  "tarjeta clasica", "disposicion", "referencia", "comision", "anualidad",
];

const TRANSFER_WORDS = [
  "transferencia", "spei", "comprobante", "beneficiario", "enviado", "recibido",
  "clabe", "ordenante", "destino", "abono", "operacion", "confirmacion",
];

const FILE_HINTS = ["recibo", "factura", "ticket", "edc", "estado", "cuenta", "voucher", "comprobante", "transfer"];

const KIND_WEIGHTS = { receipt: 1, statement: 1.5, transfer: 1.3 };

const norm = (s) =>
  (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

/** Filtro barato por nombre de archivo: ¿pinta a documento financiero? */
export function receiptFileNameHint(name = "") {
  const n = norm(name);
  if (!n) return false;
  return FILE_HINTS.some((h) => n.includes(h));
}

function wordHits(text) {
  const t = norm(text);
  const hits = { receipt: 0, statement: 0, transfer: 0 };
  if (!t) return hits;
  const multi = (re) => {
    let m, c = 0;
    while ((m = re.exec(t)) !== null) { c++; if (c > 3) break; }
    return c;
  };
  hits.receipt = multi(new RegExp(`\\b(${RECEIPT_WORDS.join("|")})\\b`, "g"));
  hits.statement = multi(new RegExp(`(${STATEMENT_WORDS.join("|")})`, "g"));
  hits.transfer = multi(new RegExp(`\\b(${TRANSFER_WORDS.join("|")})\\b`, "g"));
  return hits;
}

/** ¿El texto tiene alguna firma financiera reconocible? */
export function hasReceiptSignature(text) {
  const h = wordHits(text);
  return h.receipt > 0 || h.statement > 0 || h.transfer > 0;
}

/**
 * Detecta el tipo de documento y su confianza (0..1).
 * @returns {{kind: "receipt"|"statement"|"transfer"|null, confidence: number, reasons: string[]}}
 */
export function detectReceipt(text, fileName = "") {
  const reasons = [];
  const hits = wordHits(text);

  // Dominancia por peso ponderado.
  const weighted = {
    receipt: hits.receipt * KIND_WEIGHTS.receipt,
    statement: hits.statement * KIND_WEIGHTS.statement,
    transfer: hits.transfer * KIND_WEIGHTS.transfer,
  };
  const best = Object.entries(weighted).sort((a, b) => b[1] - a[1])[0];
  const kind = best[1] > 0 ? best[0] : null;

  if (kind) reasons.push(`${best[1].toFixed(1)} aciertos ponderados de tipo ${kind}`);
  if (receiptFileNameHint(fileName)) reasons.push("nombre de archivo sugiere documento");
  if (norm(text).length >= 30) reasons.push("texto OCR suficientemente largo");

  let confidence = 0;
  if (kind) confidence += Math.min(0.5, 0.12 * best[1]);
  if (receiptFileNameHint(fileName)) confidence += 0.15;
  if (norm(text).length >= 30) confidence += 0.15;
  if (norm(text).length >= 8 && norm(text).length < 30) confidence += 0.05;
  confidence = Math.min(0.95, Math.round(confidence * 100) / 100);

  return { kind, confidence, reasons };
}