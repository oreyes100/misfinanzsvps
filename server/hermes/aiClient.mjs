// aiClient.mjs — W26: capa central de llamadas IA para Hermes.
// callWithFallback: cadena primary→fallback con circuit breaker (W1 Fortress)
// y timeout OBLIGATORIO por llamada (hard-clamp 60s: ninguna llamada IA se cuelga más).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeCircuitBreaker } from "../circuit.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AI_CONFIG_PATH = path.join(HERE, "aiConfig.json");

// Garantía W26: ninguna llamada a IA puede colgarse más de 60s.
export const MAX_TIMEOUT_MS = 60_000;
const DEFAULTS = {
  ocr: { primary: "paddle", fallback: [], timeoutMs: 60_000, maxRetries: 2 },
  llm: { primary: "gemini-2.5-flash", fallback: ["gemini-2.0-flash"], timeoutMs: 60_000, maxRetries: 2 },
  embeddings: { primary: "ollama", fallback: [], timeoutMs: 15_000, maxRetries: 1 },
};

function clampTimeout(ms) {
  const n = Number(ms) || 0;
  return Math.max(1_000, Math.min(n, MAX_TIMEOUT_MS));
}

function parseCsv(v) {
  return String(v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Carga aiConfig.json + overrides por env. Timeout siempre ≤ 60s (clamp duro).
 */
export function loadAIConfig(configPath = AI_CONFIG_PATH, env = process.env) {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    /* defaults */
  }
  const cfg = {};
  for (const task of Object.keys(DEFAULTS)) {
    const src = file[task] || {};
    cfg[task] = {
      primary: env[`AI_${task.toUpperCase()}_PRIMARY`] || src.primary || DEFAULTS[task].primary,
      fallback: env[`AI_${task.toUpperCase()}_FALLBACK`]
        ? parseCsv(env[`AI_${task.toUpperCase()}_FALLBACK`])
        : Array.isArray(src.fallback)
          ? src.fallback
          : DEFAULTS[task].fallback,
      timeoutMs: clampTimeout(env[`AI_${task.toUpperCase()}_TIMEOUT_MS`] || src.timeoutMs || DEFAULTS[task].timeoutMs),
      maxRetries: Math.max(1, Number(src.maxRetries ?? DEFAULTS[task].maxRetries) || 1),
    };
  }
  return cfg;
}

/**
 * Ejecuta factory(signal) con timeout duro. El AbortController aborta la
 * petición real (fetch/http) al vencer — no solo "deja de esperar".
 */
export function withTimeout(factory, timeoutMs, label = "ai-call") {
  const ms = clampTimeout(timeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`${label}: timeout de ${ms}ms`)), ms);
  return Promise.resolve()
    .then(() => factory(controller.signal))
    .finally(() => clearTimeout(timer));
}

// Registro de circuit breakers por tarea:provider (proceso-local).
const circuits = new Map();

function circuitFor(task, provider) {
  const key = `${task}:${provider}`;
  if (!circuits.has(key)) {
    circuits.set(key, makeCircuitBreaker({ threshold: 3, resetMs: 300_000 }));
  }
  return circuits.get(key);
}

/** Acceso al circuit de un provider concreto (p. ej. para integraciones que iteran modelos manualmente). */
export const circuitForProvider = circuitFor;

function resetCircuits() {
  circuits.clear();
}

/** Solo para tests: limpia el registro de circuits entre casos. */
export function resetCircuitsForTests() {
  resetCircuits();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * W26 Fase 2: llamada IA con fallback chain + circuit breaker + timeout duro.
 *
 * @param {string} task - "ocr" | "llm" | "embeddings"
 * @param {Record<string, (signal: AbortSignal) => Promise<any>>} providerFns
 *        Mapa provider → factory. Solo se invocan los providers de la cadena.
 * @param {{config?: object, onEvent?: (e: object) => void}} opts
 * @returns {Promise<{result: any, provider: string, attempt: number, latencyMs: number}>}
 * @throws {Error} si TODOS los providers de la cadena fallan (con resumen).
 */
export async function callWithFallback(task, providerFns, opts = {}) {
  const cfg = opts.config || loadAIConfig();
  const taskCfg = cfg[task];
  if (!taskCfg) throw new Error(`tarea IA desconocida: ${task}`);
  const chain = [taskCfg.primary, ...taskCfg.fallback].filter((p) => typeof providerFns[p] === "function");
  if (!chain.length) throw new Error(`sin providers disponibles para ${task}: ${[taskCfg.primary, ...taskCfg.fallback].join(", ")}`);

  const errors = [];
  for (const provider of chain) {
    const circuit = circuitFor(task, provider);
    if (!circuit.canExecute()) {
      opts.onEvent?.({ event: "circuit_open", task, provider, state: circuit.getState() });
      console.warn(`[ai] ⚠️ ${task}/${provider} en circuit breaker ${circuit.getState()}, saltando`);
      continue;
    }
    for (let attempt = 1; attempt <= taskCfg.maxRetries; attempt++) {
      const started = Date.now();
      try {
        const result = await withTimeout(
          (signal) => providerFns[provider](signal),
          taskCfg.timeoutMs,
          `${task}/${provider}`
        );
        const latencyMs = Date.now() - started;
        circuit.onSuccess();
        opts.onEvent?.({ event: "success", task, provider, attempt, latencyMs });
        console.log(`[ai] ✅ ${task}/${provider} respondió en intento ${attempt} (${latencyMs}ms)`);
        return { result, provider, attempt, latencyMs };
      } catch (e) {
        const latencyMs = Date.now() - started;
        const isRateLimit = /429|quota|rate limit|Límite de uso/i.test(String(e?.message || ""));
        if (isRateLimit) circuit.onRateLimit();
        else circuit.onFailure();
        errors.push(`${provider}: ${e?.message || e}`);
        opts.onEvent?.({ event: "failure", task, provider, attempt, latencyMs, error: String(e?.message || e) });
        console.warn(`[ai] ⚠️ ${task}/${provider} falló (intento ${attempt}/${taskCfg.maxRetries}): ${e?.message || e}`);
        if (attempt < taskCfg.maxRetries) await sleep(1000 * attempt);
      }
    }
  }
  throw new Error(`Todos los providers fallaron para ${task} → ${errors.join(" | ")}`);
}

/** Estado de circuits + config (para /api/ai-config — sin secretos). */
export function getAIStatus(config) {
  const cfg = config || loadAIConfig();
  const status = {};
  for (const task of Object.keys(cfg)) {
    status[task] = {
      ...cfg[task],
      providers: [cfg[task].primary, ...cfg[task].fallback].map((p) => ({
        id: p,
        circuit: circuitFor(task, p).snapshot(),
      })),
    };
  }
  return status;
}

/**
 * Ping ligero a un provider (para /api/ai-test). NUNCA hace inferencia pesada.
 * @returns {Promise<{ok: boolean, latencyMs: number, error: string|null}>}
 */
export async function testProvider(task, provider, opts = {}) {
  const started = Date.now();
  const cfg = opts.config || loadAIConfig();
  const taskCfg = cfg[task];
  try {
    let ok = false;
    let error = null;
    if (task === "ocr" && provider === "paddle") {
      const base = (opts.ocrUrl || "http://127.0.0.1:8765").replace(/\/+$/, "");
      const r = await withTimeout((signal) => fetch(`${base}/health`, { signal }).catch((e) => {
        if (String(e?.message).includes("timeout")) throw e;
        // /health puede no existir: cualquier respuesta HTTP = server vivo
        return fetch(base, { signal });
      }), clampTimeout(opts.timeoutMs ?? 10_000), `test/${provider}`);
      ok = r.ok || r.status < 500;
      if (!ok) error = `HTTP ${r.status}`;
    } else if (task === "llm" && provider.startsWith("gemini-")) {
      const key = opts.geminiKey;
      if (!key) return { ok: false, latencyMs: 0, error: "sin GEMINI key (env GEMINI_API_KEY o hermes config.json)" };
      const r = await withTimeout((signal) => fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(provider)}?key=${encodeURIComponent(key)}`,
        { signal }
      ), clampTimeout(opts.timeoutMs ?? 15_000), `test/${provider}`);
      ok = r.ok;
      if (!ok) error = `HTTP ${r.status}`;
    } else if (task === "embeddings" && provider === "ollama") {
      const base = (opts.ollamaBase || "http://localhost:11434").replace(/\/+$/, "");
      const r = await withTimeout((signal) => fetch(`${base}/api/tags`, { signal }), clampTimeout(opts.timeoutMs ?? 10_000), `test/${provider}`);
      ok = r.ok;
      if (!ok) error = `HTTP ${r.status}`;
    } else {
      return { ok: false, latencyMs: 0, error: `provider desconocido: ${task}/${provider}` };
    }
    return { ok, latencyMs: Date.now() - started, error };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - started, error: String(e?.message || e) };
  }
}
