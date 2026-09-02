import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  loadAIConfig,
  withTimeout,
  callWithFallback,
  getAIStatus,
  testProvider,
  resetCircuitsForTests,
  MAX_TIMEOUT_MS,
} from "../server/hermes/aiClient.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_CONFIG = path.join(HERE, "../server/hermes/aiConfig.json");

function tmpConfig(over = {}) {
  const base = {
    ocr: { primary: "paddle", fallback: [], timeoutMs: 60000, maxRetries: 2 },
    llm: { primary: "m-a", fallback: ["m-b", "m-c"], timeoutMs: 60000, maxRetries: 2 },
    embeddings: { primary: "ollama", fallback: [], timeoutMs: 15000, maxRetries: 1 },
    ...over,
  };
  const p = path.join(HERE, `aiConfig-test-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify(base));
  return p;
}

afterEach(() => {
  for (const f of fs.readdirSync(HERE)) if (f.startsWith("aiConfig-test-")) fs.unlinkSync(path.join(HERE, f));
  resetCircuitsForTests();
});

describe("W26 · loadAIConfig", () => {
  it("carga el aiConfig.json real versionado con las 3 tareas", () => {
    const cfg = loadAIConfig(REAL_CONFIG, {});
    expect(cfg.ocr.primary).toBe("paddle");
    expect(cfg.llm.primary).toBe("gemini-2.5-flash");
    expect(cfg.llm.fallback).toContain("gemini-2.0-flash");
    expect(cfg.embeddings.primary).toBe("ollama");
  });

  it("clamp duro: ningún timeout puede exceder 60s (garantía anti-cuelgue)", () => {
    const p = tmpConfig({ llm: { primary: "m-a", fallback: [], timeoutMs: 1200000, maxRetries: 1 } });
    const cfg = loadAIConfig(p, {});
    expect(cfg.llm.timeoutMs).toBeLessThanOrEqual(MAX_TIMEOUT_MS);
    expect(cfg.llm.timeoutMs).toBe(60000);
  });

  it("env override: AI_LLM_PRIMARY, AI_LLM_FALLBACK y AI_LLM_TIMEOUT_MS", () => {
    const cfg = loadAIConfig(REAL_CONFIG, {
      AI_LLM_PRIMARY: "m-x",
      AI_LLM_FALLBACK: "m-y, m-z",
      AI_LLM_TIMEOUT_MS: "30000",
    });
    expect(cfg.llm.primary).toBe("m-x");
    expect(cfg.llm.fallback).toEqual(["m-y", "m-z"]);
    expect(cfg.llm.timeoutMs).toBe(30000);
  });
});

describe("W26 · callWithFallback", () => {
  it("usa el provider primario si responde", async () => {
    const cfg = loadAIConfig(tmpConfig(), {});
    const calls = [];
    const r = await callWithFallback("llm", {
      "m-a": async () => { calls.push("m-a"); return "ok-a"; },
      "m-b": async () => { calls.push("m-b"); return "ok-b"; },
    }, { config: cfg });
    expect(r.provider).toBe("m-a");
    expect(r.result).toBe("ok-a");
    expect(calls).toEqual(["m-a"]);
  });

  it("fallback automático al siguiente provider si el primario falla", async () => {
    const cfg = loadAIConfig(tmpConfig(), {});
    const r = await callWithFallback("llm", {
      "m-a": async () => { throw new Error("down"); },
      "m-b": async () => "ok-b",
    }, { config: cfg });
    expect(r.provider).toBe("m-b");
    expect(r.result).toBe("ok-b");
  });

  it("circuit breaker: 3 fallos consecutivos → OPEN → el provider se salta", async () => {
    // config con maxRetries 1 para que cada provider se llame 1 vez por ciclo
    const p1 = tmpConfig({ llm: { primary: "m-a", fallback: ["m-b"], timeoutMs: 5000, maxRetries: 1 } });
    const c1 = loadAIConfig(p1, {});
    const fns = {
      "m-a": async () => { throw new Error("down"); },
      "m-b": async () => "ok-b",
    };
    // 3 ciclos: m-a falla 3 veces → circuit OPEN
    for (let i = 0; i < 3; i++) {
      await callWithFallback("llm", fns, { config: c1 });
    }
    const status = getAIStatus(c1);
    expect(status.llm.providers.find((x) => x.id === "m-a").circuit.state).toBe("OPEN");
    // 4º ciclo: m-a NO debe invocarse (saltado por circuit), m-b responde
    let aCalls = 0, bCalls = 0;
    await callWithFallback("llm", {
      "m-a": async () => { aCalls++; throw new Error("down"); },
      "m-b": async () => { bCalls++; return "ok"; },
    }, { config: c1 });
    expect(aCalls).toBe(0);
    expect(bCalls).toBe(1);
  });

  it("timeout: la llamada que excede el límite aborta y pasa al siguiente provider", async () => {
    const pFast = tmpConfig({ llm: { primary: "slow", fallback: ["fast"], timeoutMs: 2000, maxRetries: 1 } });
    const cFast = loadAIConfig(pFast, {});
    const r = await callWithFallback("llm", {
      slow: (signal) => new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error(signal.reason?.message || "abort")));
      }),
      fast: async () => "quick",
    }, { config: cFast });
    expect(r.provider).toBe("fast");
  });
});

describe("W26 · withTimeout", () => {
  it("rechaza cuando la operación excede el timeout (mínimo 1s)", async () => {
    await expect(
      withTimeout((signal) => new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error(signal.reason?.message || "abort")));
      }), 1100, "test/timeout")
    ).rejects.toThrow(/timeout de 1100ms/);
  }, 5000);

  it("resuelve si la operación termina a tiempo", async () => {
    const r = await withTimeout(async () => 42, 5000, "test/ok");
    expect(r).toBe(42);
  });
});

describe("W26 · testProvider (sin inferencia pesada)", () => {
  it("provider desconocido → ok:false con error, sin lanzar", async () => {
    const r = await testProvider("llm", "no-existe", { config: loadAIConfig(tmpConfig(), {}) });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/desconocido/);
  });
});
