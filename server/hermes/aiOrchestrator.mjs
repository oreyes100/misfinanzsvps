// aiOrchestrator.mjs — W27: Hermes Agent como ÚNICO punto de entrada de IA.
// Bot y webapp NO llaman a providers directamente: todo pasa por aquí
// (endpoints /api/hermes/ai/:task en server.mjs) y de aquí a
// callWithFallback (circuit breaker + timeout ≤60s, W26).
import { loadAIConfig, callWithFallback, getAIStatus, testProvider } from "./aiClient.mjs";
import { ocrImage } from "./ocr.mjs";
import { aiExtractFromFile, embedText, aiTextJSON } from "./gemini.mjs";
import { extractPdfText } from "./receiptExtractor.mjs";
import { parseOcrText } from "./local.mjs";

/**
 * Resuelve la API key de Gemini: opts.geminiKey → settings del sync doc → env → hermes config.
 * @param {{geminiKey?: string|null, syncId?: string}} input
 * @param {{geminiKey?: string|null, lookupSyncState?: (id: string) => object|null}} opts
 */
function resolveGeminiKey(input, opts) {
  if (opts?.geminiKey) return opts.geminiKey;
  if (input?.syncId && typeof opts?.lookupSyncState === "function") {
    const state = opts.lookupSyncState(input.syncId);
    if (state?.settings?.geminiKey) return state.settings.geminiKey;
  }
  return null;
}

/**
 * Tareas IA soportadas por el orchestrator. Inyectable (providerFns/config)
 * para tests. NUNCA lanza por provider caído: lanza solo si TODA la cadena falla.
 *
 * @param {string} task - "ocr" | "llm" | "embeddings" | "audit" | "config" | "test"
 * @param {object} input
 * @param {object} opts - { config?, providerFns?, geminiKey?, ocrUrl?, lookupSyncState?, auditFn? }
 */
export async function handleAITask(task, input = {}, opts = {}) {
  const config = opts.config || loadAIConfig();

  if (task === "config") {
    return { config, status: getAIStatus(config) };
  }

  if (task === "test") {
    const t = String(input.task || "");
    const provider = String(input.provider || "");
    if (!["ocr", "llm", "embeddings"].includes(t) || !provider) {
      return { ok: false, latencyMs: 0, error: "task y provider requeridos (task: ocr|llm|embeddings)" };
    }
    return await testProvider(t, provider, {
      config,
      geminiKey: opts.geminiKey || resolveGeminiKey(input, opts),
      ocrUrl: opts.ocrUrl,
      ollamaBase: opts.ollamaBase,
    });
  }

  if (task === "ocr") {
    if (!input.imagePath) throw new Error("ocr requiere imagePath");
    const fns = opts.providerFns || {
      paddle: () => ocrImage(input.imagePath, { url: opts.ocrUrl }),
    };
    const r = await callWithFallback("ocr", fns, { config });
    return { ok: true, text: r.result, provider: r.provider, attempt: r.attempt, latencyMs: r.latencyMs };
  }

  if (task === "llm") {
    if (!input.imagePath) throw new Error("llm requiere imagePath");
    const geminiKey = opts.geminiKey || resolveGeminiKey(input, opts);
    if (!geminiKey) throw new Error("sin GEMINI key (env GEMINI_API_KEY, hermes config.json o settings del sync doc)");
    const fns = opts.providerFns || {
      [config.llm.primary]: () => aiExtractFromFile(input.imagePath, geminiKey, {
        categories: input.categories || [],
        accounts: input.accounts || [],
        ocrText: input.ocrText || null,
      }),
    };
    const r = await callWithFallback("llm", fns, { config });
    return { ok: true, result: r.result, provider: r.provider, attempt: r.attempt, latencyMs: r.latencyMs };
  }

  if (task === "embeddings") {
    const text = String(input.text || "").trim();
    if (!text) throw new Error("embeddings requiere text");
    const provider = input.provider || config.embeddings.primary;
    const fns = opts.providerFns || {
      [provider]: () => embedText(text, provider, opts.geminiKey || undefined),
    };
    const r = await callWithFallback("embeddings", fns, { config });
    return { ok: true, embedding: r.result, provider: r.provider, latencyMs: r.latencyMs };
  }

  if (task === "receipt") {
    // W28: entrada unificada IMG/PDF. PDF con texto → parser local (sin OCR ni
    // IA). PDF escaneado o imagen → Gemini vision (PDFs nativos, imágenes con
    // OCR previo según el caller). Inyectable para tests.
    const { filePath, base64, mimeType } = input;
    if (!filePath && !base64) throw new Error("receipt requiere filePath o base64");
    const isPdf = mimeType === "application/pdf" || (filePath && /\.pdf$/i.test(filePath));

    if (isPdf && filePath) {
      const fsMod = await import("node:fs");
      const pdf = await extractPdfText(fsMod.readFileSync(filePath));
      if (pdf.text) {
        const parsed = opts.parseFn ? opts.parseFn(pdf.text) : parseOcrText(pdf.text);
        if (parsed?.ok && parsed.result) {
          return { ok: true, result: parsed.result, source: "pdf_text", numPages: pdf.numPages };
        }
      }
      // PDF escaneado o texto no parseable → Gemini vision (lee PDFs nativamente)
      const geminiKey = opts.geminiKey || resolveGeminiKey(input, opts);
      if (!geminiKey) throw new Error("sin GEMINI key para PDF escaneado");
      if (opts.visionFn) {
        return { ok: true, result: await opts.visionFn(filePath, geminiKey), source: "pdf_vision", numPages: pdf.numPages };
      }
      return { ok: true, result: await aiExtractFromFile(filePath, geminiKey, { categories: input.categories || [], accounts: input.accounts || [] }), source: "pdf_vision", numPages: pdf.numPages };
    }

    if (base64) {
      // Imagen (o PDF) en base64 — la decodifica a un temp file para el flujo existente.
      const fsMod = await import("node:fs");
      const pathMod = await import("node:path");
      const osMod = await import("node:os");
      const ext = mimeType === "application/pdf" ? ".pdf" : /png/.test(mimeType || "") ? ".png" : /webp/.test(mimeType || "") ? ".webp" : ".jpg";
      const tmp = pathMod.join(osMod.tmpdir(), `receipt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
      fsMod.writeFileSync(tmp, Buffer.from(base64, "base64"));
      try {
        return await handleAITask("receipt", { ...input, filePath: tmp, base64: undefined }, opts);
      } finally {
        try { fsMod.unlinkSync(tmp); } catch { /* best-effort */ }
      }
    }

    throw new Error("receipt: solo imágenes o PDFs soportados");
  }

  if (task === "text") {
    const prompt = String(input.prompt || "").trim();
    if (!prompt) throw new Error("text requiere prompt");
    const geminiKey = opts.geminiKey || resolveGeminiKey(input, opts);
    if (!geminiKey) throw new Error("sin GEMINI key para tarea text");
    if (opts.providerFns?.text) {
      return { ok: true, result: await opts.providerFns.text() };
    }
    const result = await aiTextJSON(prompt, geminiKey);
    return { ok: true, result };
  }

  if (task === "audit") {
    if (!Array.isArray(input.movements) || !Array.isArray(input.registered)) {
      throw new Error("audit requiere movements y registered");
    }
    const geminiKey = opts.geminiKey || resolveGeminiKey(input, opts);
    if (!geminiKey) throw new Error("sin GEMINI key para auditoría");
    const auditFn = opts.auditFn;
    if (!auditFn) throw new Error("audit requiere auditFn inyectado (aiAudit)");
    const result = await auditFn(input.movements, input.registered, geminiKey, { categories: input.categories || [] });
    return { ok: true, result };
  }

  throw new Error(`Tarea IA desconocida: ${task}`);
}
