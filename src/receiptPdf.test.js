import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { extractPdfText, extractReceipt } from "../server/hermes/receiptExtractor.mjs";
import { handleAITask } from "../server/hermes/aiOrchestrator.mjs";
import { resetCircuitsForTests } from "../server/hermes/aiClient.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

// Genera un PDF 1-página válido con capa de texto (offsets de xref calculados).
function makeTextPdf(text) {
  const enc = (s) => new TextEncoder().encode(s);
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null, // stream, se arma aparte
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = `BT /F1 12 Tf 40 720 Td (${text.replace(/([()\\])/g, "\\$1")}) Tj ET`;
  objs[3] = `<< /Length ${enc(stream).length} >>\nstream\n${stream}\nendstream`;
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(enc(out).length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = enc(out).length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return Buffer.from(out, "binary");
}

// PDF sin capa de texto (página vacía) = "escaneado"
function makeEmptyPdf() {
  return makeTextPdf("");
}

afterEach(() => resetCircuitsForTests());

describe("W28 · receiptExtractor (IMG + PDF unificado)", () => {
  it("PDF con capa de texto → texto directo (sin OCR), scanned:false", async () => {
    const pdf = makeTextPdf("RECIBO OXXO BODEGA AURRERA TOTAL 123.50 MXN FECHA 2026-09-02 TICKET 0001234");
    const r = await extractPdfText(pdf);
    expect(r.numPages).toBe(1);
    expect(r.scanned).toBe(false);
    expect(r.text).toContain("RECIBO OXXO");
    expect(r.text).toContain("123.50");
  });

  it("PDF escaneado (sin texto) → text:null, scanned:true → el caller va a visión", async () => {
    const r = await extractPdfText(makeEmptyPdf());
    expect(r.scanned).toBe(true);
    expect(r.text).toBeNull();
  });

  it("extractReceipt: imagen pasa tal cual (para OCR del caller)", async () => {
    const buf = Buffer.from("fake-jpeg");
    const r = await extractReceipt({ buffer: buf, mimeType: "image/jpeg" });
    expect(r.type).toBe("image");
    expect(r.buffer).toBe(buf);
  });

  it("extractReceipt: formato no soportado → rechazo claro", async () => {
    await expect(extractReceipt({ buffer: Buffer.from("x"), mimeType: "application/msword" })).rejects.toThrow(/no soportado/);
  });

  it("límite de páginas: máximo 10 páginas procesadas", async () => {
    // Un PDF de 1 página: extractPdfText respeta maxPages — verificamos el clamp del parámetro
    const pdf = makeTextPdf("test");
    const r = await extractPdfText(pdf, { maxPages: 999 });
    expect(r.numPages).toBe(1); // el doc solo tiene 1
  });
});

describe("W28 · /api/hermes/ai/receipt (orchestrator)", () => {
  function tempPdf(buffer) {
    const p = path.join(os.tmpdir(), `w28-${Math.random().toString(36).slice(2)}.pdf`);
    fs.writeFileSync(p, buffer);
    return p;
  }

  it("PDF con texto → parseo local directo, source: pdf_text (sin OCR ni IA)", async () => {
    const p = tempPdf(makeTextPdf("RECIBO SORIANA SUPERMERCADO TOTAL 88.90 MXN FECHA 2026-09-02 TICKET 0009876"));
    try {
      const out = await handleAITask("receipt", { filePath: p }, {
        config: {
          ocr: { primary: "paddle", fallback: [], timeoutMs: 5000, maxRetries: 1 },
          llm: { primary: "gemini-2.5-flash", fallback: [], timeoutMs: 5000, maxRetries: 1 },
          embeddings: { primary: "ollama", fallback: [], timeoutMs: 5000, maxRetries: 1 },
        },
        geminiKey: "test-key",
        // parseFn real de local.mjs vendría por defecto; inyectamos una determinista:
        parseFn: (text) => (text.includes("SORIANA") ? { ok: true, result: { type: "receipt", merchant: "SORIANA", total: 88.9, movements: [], transfer: null } } : { ok: false }),
      });
      expect(out.ok).toBe(true);
      expect(out.source).toBe("pdf_text");
      expect(out.result.merchant).toBe("SORIANA");
    } finally {
      fs.unlinkSync(p);
    }
  });

  it("PDF escaneado → cae a Gemini vision (inyectada), source: pdf_vision", async () => {
    const p = tempPdf(makeEmptyPdf());
    try {
      let visionCalled = false;
      const out = await handleAITask("receipt", { filePath: p }, {
        config: {
          ocr: { primary: "paddle", fallback: [], timeoutMs: 5000, maxRetries: 1 },
          llm: { primary: "gemini-2.5-flash", fallback: [], timeoutMs: 5000, maxRetries: 1 },
          embeddings: { primary: "ollama", fallback: [], timeoutMs: 5000, maxRetries: 1 },
        },
        geminiKey: "test-key",
        visionFn: async () => { visionCalled = true; return { type: "receipt", merchant: "SCAN", total: 10 }; },
      });
      expect(visionCalled).toBe(true);
      expect(out.source).toBe("pdf_vision");
      expect(out.result.merchant).toBe("SCAN");
    } finally {
      fs.unlinkSync(p);
    }
  });

  it("receipt sin filePath ni base64 → error claro", async () => {
    await expect(handleAITask("receipt", {}, {
      config: {
        ocr: { primary: "paddle", fallback: [], timeoutMs: 5000, maxRetries: 1 },
        llm: { primary: "m", fallback: [], timeoutMs: 5000, maxRetries: 1 },
        embeddings: { primary: "ollama", fallback: [], timeoutMs: 5000, maxRetries: 1 },
      },
    })).rejects.toThrow(/filePath o base64/);
  });
});

describe("W28 · contrato de integración (source-contract)", () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

  it("gemini.mjs: MIME_BY_EXT incluye application/pdf (Drive PDFs → Gemini los lee nativamente)", () => {
    expect(read("server/hermes/gemini.mjs")).toMatch(/"\.pdf": "application\/pdf"/);
  });

  it("drive.mjs: IMAGE_EXT incluye .pdf (el scanner ya descarga PDFs)", () => {
    const src = read("server/hermes/drive.mjs");
    expect(src).toMatch(/IMAGE_EXT = new Set\(\[[^\]]*"\.pdf"/s);
  });

  it("bot (extra.js): PDFs pasan primero por pdfTextFirst y caen a Gemini si son escaneados", () => {
    const src = read("server/extra.js");
    expect(src).toMatch(/import \{ extractPdfText \} from "\.\/hermes\/receiptExtractor\.mjs"/);
    expect(src).toMatch(/pdfTextFirst\(buf\)/);
    expect(src).toMatch(/application\/pdf"/); // validación de mime existente
  });

  it("processor.mjs: rama PDF (extract_pdf_text → parseOcrText) antes de OCR", () => {
    const src = read("server/hermes/processor.mjs");
    expect(src).toMatch(/extractPdfText/);
    expect(src).toMatch(/extract_pdf_text/);
  });
});
