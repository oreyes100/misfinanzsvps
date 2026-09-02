// aiOrchestrator.mjs — W27: Hermes Agent como ÚNICO punto de entrada de IA.
// Bot y webapp NO llaman a providers directamente: todo pasa por aquí
// (endpoints /api/hermes/ai/:task en server.mjs) y de aquí a
// callWithFallback (circuit breaker + timeout ≤60s, W26).
import { loadAIConfig, callWithFallback, getAIStatus, testProvider } from "./aiClient.mjs";
import { ocrImage } from "./ocr.mjs";
import { aiExtractFromFile, embedText, aiTextJSON } from "./gemini.mjs";

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
