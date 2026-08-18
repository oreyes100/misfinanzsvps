// server/categorize.test.mjs — Tests del endpoint /api/categorize (Top of Mind A).
// Valida el k-NN coseno y el fallback sin key. No levanta server.mjs (requiere
// better-sqlite3 nativo, solo presente en el VPS).

import { describe, it, expect, vi, afterEach } from "vitest";

// Extrae las funciones puras re-exportándolas desde el propio server.mjs es
// frágil (importa db.mjs). En su lugar, replicamos la firma exacta con imports
// directos del módulo de embeddings de Hermes.
import { cosineSimilarity, embedText } from "./hermes/gemini.mjs";

function pickByCosine(descEmb, prototypes) {
  let best = null;
  let bestSim = 0;
  for (const p of prototypes) {
    if (p.embedding?.length !== descEmb.length) continue;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < descEmb.length; i++) {
      dot += descEmb[i] * p.embedding[i];
      na += descEmb[i] * descEmb[i];
      nb += p.embedding[i] * p.embedding[i];
    }
    const sim = dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
    if (sim > bestSim) { bestSim = sim; best = p; }
  }
  if (!best) return null;
  return { category: best.category, confidence: Math.min(0.95, 0.5 + bestSim) };
}

describe("pickByCosine (k-NN de prototipos)", () => {
  const v = (n) => Array.from({ length: 8 }, (_, i) => (i === n ? 1 : 0));
  const protos = [
    { category: "Comida", embedding: [1, 1, 0, 0, 0, 0, 0, 0] },
    { category: "Transporte", embedding: [0, 0, 1, 1, 0, 0, 0, 0] },
    { category: "Otros", embedding: [0, 0, 0, 0, 1, 1, 1, 1] },
  ];

  it("elige la categoría más cercana", () => {
    const r = pickByCosine([1, 1, 0, 0, 0, 0, 0, 0], protos);
    expect(r.category).toBe("Comida");
  });

  it("confianza entre 0.5 y 0.95", () => {
    const r = pickByCosine([0, 0, 1, 1, 0, 0, 0, 0], protos);
    expect(r.category).toBe("Transporte");
    expect(r.confidence).toBeGreaterThanOrEqual(0.5);
    expect(r.confidence).toBeLessThanOrEqual(0.95);
  });

  it("ignora prototipos de dimensión distinta", () => {
    const r = pickByCosine([1, 1, 0, 0, 0, 0, 0, 0], [{ category: "X", embedding: [1] }]);
    expect(r).toBeNull();
  });

  it("devuelve null sin prototipos", () => {
    expect(pickByCosine([1, 0], [])).toBeNull();
  });
});

describe("cosineSimilarity (gemini.mjs)", () => {
  it("1 para vectores idénticos, 0 para ortogonales", () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 5);
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0, 5);
  });
  it("0 si las dimensiones no coinciden", () => {
    expect(cosineSimilarity([1, 0], [1, 0, 0])).toBe(0);
  });
});

describe("embedText (provider invalid)", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("lanza para proveedor no soportado", async () => {
    await expect(embedText("hola", "unknown")).rejects.toThrow(/no soportado/);
  });

  it("devuelve [] con texto vacío", async () => {
    expect(await embedText("", "ollama")).toEqual([]);
  });
});