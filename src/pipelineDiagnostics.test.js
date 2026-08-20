import { describe, it, expect } from "vitest";
import { diagnosePipeline, summarizeDiagnosis, pushPipelineEvents, MAX_PIPELINE_EVENTS } from "./utils/pipelineDiagnostics.js";

const baseState = {
  reviewQueue: { pending: [], resolved: [], dismissed: [] },
  pipelineEvents: [],
};

describe("diagnosePipeline", () => {
  it("reporta ok con un estado sano (todos los eslabones verdes)", () => {
    const d = diagnosePipeline(baseState);
    expect(d.health).toBe("ok");
    expect(d.okCount).toBe(d.total);
    expect(d.failed).toEqual([]);
  });

  it("reporta broken si el estado es nulo", () => {
    expect(diagnosePipeline(null).health).toBe("broken");
    expect(diagnosePipeline(undefined).health).toBe("broken");
  });

  it("marca degraded si falta un eslabón (sin telemetría)", () => {
    const d = diagnosePipeline({ reviewQueue: { pending: [], resolved: [], dismissed: [] } });
    expect(d.health).toBe("degraded");
    expect(d.failed).toContain("telemetry");
  });

  it("marca broken si falta reviewQueue (cadena completa caída)", () => {
    const d = diagnosePipeline({ pipelineEvents: [] });
    expect(d.failed).toContain("seed");
    expect(d.health).toBe("broken");
  });

  it("cuenta pendientes por severidad en counts", () => {
    const state = {
      reviewQueue: {
        pending: [
          { id: "a", classification: "needs_fix" },
          { id: "b", classification: "needs_review" },
          { id: "c", classification: "auto_ok" },
        ],
        resolved: [],
        dismissed: [],
      },
      pipelineEvents: [{ ts: 1, source: "assistant" }],
    };
    const d = diagnosePipeline(state);
    expect(d.counts.pending).toBe(3);
    expect(d.counts.needsFix).toBe(1);
    expect(d.counts.needsReview).toBe(1);
    expect(d.counts.events).toBe(1);
  });
});

describe("summarizeDiagnosis", () => {
  it("formatea el resumen legible", () => {
    expect(summarizeDiagnosis(diagnosePipeline(baseState))).toBe("ok (6/6)");
    const degraded = diagnosePipeline({ reviewQueue: { pending: [], resolved: [], dismissed: [] } });
    expect(summarizeDiagnosis(degraded)).toContain("degraded");
    expect(summarizeDiagnosis(degraded)).toContain("telemetry");
  });
});

describe("pushPipelineEvents", () => {
  it("prepende eventos y mantiene el más reciente primero", () => {
    const events = [{ ts: 1, source: "a" }, { ts: 2, source: "b" }];
    const next = pushPipelineEvents(events, [{ ts: 3, source: "c" }]);
    expect(next.map((e) => e.ts)).toEqual([3, 1, 2]);
  });

  it("acepta un array de eventos", () => {
    const next = pushPipelineEvents([], [{ ts: 1, source: "a" }, { ts: 2, source: "b" }]);
    expect(next.length).toBe(2);
  });

  it("descarta eventos sin ts o sin source", () => {
    expect(pushPipelineEvents([], [{ ts: 1 }, { source: "a" }, { ts: 2, source: "b" }]).length).toBe(1);
  });

  it("respeta el cap máximo (200)", () => {
    const seed = Array.from({ length: 200 }, (_, i) => ({ ts: i, source: "a" }));
    const next = pushPipelineEvents(seed, [{ ts: 999, source: "b" }]);
    expect(next.length).toBe(MAX_PIPELINE_EVENTS);
    expect(next[0].ts).toBe(999);
  });

  it("no muta el array original", () => {
    const original = [{ ts: 1, source: "a" }];
    const next = pushPipelineEvents(original, [{ ts: 2, source: "b" }]);
    expect(original.length).toBe(1);
    expect(next.length).toBe(2);
  });
});