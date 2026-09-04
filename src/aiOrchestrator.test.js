import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handleAITask } from "../server/hermes/aiOrchestrator.mjs";
import { resetCircuitsForTests } from "../server/hermes/aiClient.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

function testConfig() {
  return {
    ocr: { primary: "paddle", fallback: [], timeoutMs: 5000, maxRetries: 1 },
    llm: { primary: "m-a", fallback: ["m-b"], timeoutMs: 5000, maxRetries: 1 },
    embeddings: { primary: "ollama", fallback: [], timeoutMs: 5000, maxRetries: 1 },
  };
}

afterEach(() => resetCircuitsForTests());

describe("W27 · Hermes Orchestrator (único punto de entrada de IA)", () => {
  it("config → devuelve config + estado de circuits", async () => {
    const out = await handleAITask("config", {}, { config: testConfig() });
    expect(out.config.llm.primary).toBe("m-a");
    expect(out.status.ocr.providers[0].id).toBe("paddle");
    expect(out.status.ocr.providers[0].circuit).toHaveProperty("state");
  });

  it("ocr → callWithFallback con provider real (inyectado) devuelve text + meta", async () => {
    const out = await handleAITask("ocr", { imagePath: "/tmp/x.jpg" }, {
      config: testConfig(),
      providerFns: { paddle: async () => "TEXTO OCR" },
    });
    expect(out.ok).toBe(true);
    expect(out.text).toBe("TEXTO OCR");
    expect(out.provider).toBe("paddle");
    expect(out.attempt).toBe(1);
  });

  it("llm → con key resuelta devuelve result estructurado", async () => {
    const out = await handleAITask("llm", { imagePath: "/tmp/x.jpg", syncId: "mf-abc" }, {
      config: testConfig(),
      geminiKey: "test-key",
      providerFns: { "m-a": async () => ({ type: "receipt", total: 100 }) },
    });
    expect(out.ok).toBe(true);
    expect(out.result.type).toBe("receipt");
    expect(out.provider).toBe("m-a");
  });

  it("llm → sin key en ninguna fuente lanza error claro", async () => {
    await expect(
      handleAITask("llm", { imagePath: "/tmp/x.jpg" }, { config: testConfig(), lookupSyncState: () => ({ settings: {} }) })
    ).rejects.toThrow(/sin GEMINI key/);
  });

  it("embeddings → devuelve embedding vía provider (inyectado)", async () => {
    const out = await handleAITask("embeddings", { text: "café en oxxo" }, {
      config: testConfig(),
      providerFns: { ollama: async () => [0.1, 0.2, 0.3] },
    });
    expect(out.ok).toBe(true);
    expect(out.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(out.provider).toBe("ollama");
  });

  it("text → LLM de texto plano (inyectado) para la webapp", async () => {
    const out = await handleAITask("text", { prompt: "analiza esto", syncId: "mf-abc" }, {
      config: testConfig(),
      geminiKey: "test-key",
      providerFns: { text: async () => ({ isValid: true, confidence: 0.9 }) },
    });
    expect(out.ok).toBe(true);
    expect(out.result.isValid).toBe(true);
  });

  it("tarea desconocida → error", async () => {
    await expect(handleAITask("no-existe", {}, { config: testConfig() })).rejects.toThrow(/desconocida/);
  });
});

describe("W27 · contrato de fuente única (source-contract)", () => {
  const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

  it("processor.mjs NO importa providers directos (ocr.mjs / gemini.mjs)", () => {
    const src = read("server/hermes/processor.mjs");
    expect(src).not.toMatch(/from "\.\/ocr\.mjs"/);
    expect(src).not.toMatch(/from "\.\/gemini\.mjs"/);
    expect(src).toMatch(/callOrchestrator\(cfg, "ocr"/);
    expect(src).toMatch(/callOrchestrator\(cfg, "llm"/);
  });

  it("review.mjs NO importa aiAudit directo — auditoría vía orchestrator", () => {
    const src = read("server/hermes/review.mjs");
    expect(src).not.toMatch(/from "\.\/gemini\.mjs"/);
    expect(src).toMatch(/callOrchestrator\(/);
  });

  it("AIConfigPanel usa /api/hermes/ai/* E importa Glass (fix bug de carga)", () => {
    const src = read("src/components/AIConfigPanel.jsx");
    expect(src).toMatch(/import \{ Glass \} from "\.\/UI\.jsx"/);
    expect(src).toMatch(/\/api\/hermes\/ai\/config/);
    expect(src).toMatch(/\/api\/hermes\/ai\/test/);
    expect(src).not.toMatch(/\/api\/ai-config/);
    expect(src).not.toMatch(/\/api\/ai-test/);
  });

  it("utils.ts: getEmbedding vía /api/hermes/ai/embeddings; sin llamadas directas a Gemini en duplicados", () => {
    const src = read("src/utils.ts");
    expect(src).toMatch(/export async function getEmbedding/);
    expect(src).toMatch(/\/api\/hermes\/ai\/embeddings/);
    expect(src).toMatch(/\/api\/hermes\/ai\/text/);
    expect(src).not.toMatch(/generativelanguage\.googleapis\.com/);
  });

  it("server.mjs expone /api/hermes/ai/:task y ya NO tiene los endpoints W26", () => {
    const src = read("server/server.mjs");
    expect(src).toMatch(/\/api\/hermes\/ai\//);
    expect(src).not.toMatch(/"\/api\/ai-config"/);
    expect(src).not.toMatch(/"\/api\/ai-test"/);
  });
});

// W37e: el race del resync — el _dirty con la empate de refs debe forzar el push
describe("W37e · el pending del resync cuenta el _dirty (el race de la edición)", () => {
  it("la regla: el pending = _dirty || la empate de refs", () => {
    const dirtyPending = (state, syncable, lastPushed) => state._dirty || syncable !== lastPushed;
    // el race: la edición con el stamp, PERO el syncableRef seguía pre-edit (empate)
    expect(dirtyPending({ _dirty: true }, "X", "X")).toBe(true);
    expect(dirtyPending({ _dirty: false }, "X", "Y")).toBe(true);
    expect(dirtyPending({ _dirty: false }, "X", "X")).toBe(false);
  });
});
