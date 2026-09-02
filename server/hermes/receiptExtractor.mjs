// receiptExtractor.mjs — W28: extractor unificado de recibos IMG + PDF.
// PDF con capa de texto → texto directo (sin OCR, sin IA).
// PDF escaneado (sin texto) → el caller lo manda a Gemini vision, que lee
// PDFs nativamente (application/pdf inline_data) — no se necesita node-canvas.
// Reutiliza pdfjs-dist (ya presente para la Auditoría del cliente, W20).

import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { createRequire } from "node:module";

// Fuentes estándar de pdfjs (Helvetica etc. sin embeber): sin esta ruta, pdfjs 6
// trunca el texto de PDFs generados con fuentes estándar (recibos típicos).
// En el build legacy de Node va Ruta de filesystem (no file:// URL).
const require = createRequire(import.meta.url);
const STANDARD_FONTS_PATH =
  require.resolve("pdfjs-dist/package.json").replace(/package\.json$/, "standard_fonts/");

export const MAX_PDF_PAGES = 10;
// Debajo de este total de caracteres consideramos el PDF "escaneado" (sin capa
// de texto útil) → el caller debe irse a visión.
export const MIN_TEXT_CHARS = 50;

/**
 * Extrae el texto de un PDF (Buffer/Uint8Array).
 * @param {Buffer|Uint8Array} buffer
 * @param {{maxPages?: number}} opts
 * @returns {Promise<{numPages: number, text: string|null, pages: Array<{page:number, text:string}>, scanned: boolean}>}
 *   text: texto concatenado (null si scanned), scanned: true si no hay capa de texto útil.
 */
export async function extractPdfText(buffer, opts = {}) {
  const maxPages = Math.min(Number(opts.maxPages) || MAX_PDF_PAGES, MAX_PDF_PAGES);
  // pdfjs-dist 6 exige Uint8Array PURO (un Buffer es instanceof Uint8Array pero
  // pdfjs lo rechaza explícitamente) → copia siempre a Uint8Array nativo.
  const data = new Uint8Array(buffer);
  const loadingTask = getDocument({ data, useSystemFonts: false, isEvalSupported: false, standardFontDataUrl: STANDARD_FONTS_PATH });
  const pdf = await loadingTask.promise;
  try {
    const pages = [];
    for (let i = 1; i <= Math.min(pdf.numPages, maxPages); i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const text = content.items
        .map((it) => (typeof it.str === "string" ? it.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (text) pages.push({ page: i, text });
      page.cleanup?.();
    }
    const total = pages.map((p) => p.text).join("\n").trim();
    const scanned = total.length < MIN_TEXT_CHARS;
    return {
      numPages: pdf.numPages,
      text: scanned ? null : total,
      pages,
      scanned,
    };
  } finally {
    await loadingTask.destroy?.();
  }
}

/**
 * W28 Fase 1: entrada unificada. Imagen → pasa tal cual (el caller hace OCR).
 * PDF → texto directo o flag scanned.
 * @param {{buffer: Buffer|Uint8Array, mimeType?: string, filePath?: string}} input
 * @returns {Promise<{type: "image"|"pdf", buffer: Buffer|Uint8Array, text: string|null, scanned: boolean, numPages?: number}>}
 */
export async function extractReceipt(input) {
  const { buffer, mimeType, filePath } = input || {};
  if (!buffer && !filePath) throw new Error("extractReceipt requiere buffer o filePath");
  const isPdf = mimeType === "application/pdf" || (filePath && /\.pdf$/i.test(filePath));
  if (isPdf) {
    const buf = buffer || (await import("node:fs")).readFileSync(filePath);
    const pdf = await extractPdfText(buf);
    return { type: "pdf", buffer: buf, text: pdf.text, scanned: pdf.scanned, numPages: pdf.numPages, pages: pdf.pages };
  }
  if (!mimeType || /^image\//.test(mimeType) || (filePath && /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(filePath))) {
    return { type: "image", buffer: buffer || null, text: null, scanned: false };
  }
  throw new Error(`Formato no soportado: ${mimeType || filePath}`);
}
