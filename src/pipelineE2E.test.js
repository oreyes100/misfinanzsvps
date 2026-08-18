// pipelineE2E.test.js — E2E del pipeline MCP (GHOST PIPELINE).
// Ejercita la misma secuencia que el reducer de store.jsx ejecuta: auto-captura de
// transacciones sin categoría/confianza baja al hacer restore, dedupe idempotente,
// aceptar → resolved. Usa SOLO lógica pura (sin React/localStorage).

import { describe, it, expect } from "vitest";
import { buildUnreviewedItems, enqueueItem, acceptItem, dismissItem, pendingCounts, CLASS_NEEDS_FIX, CLASS_NEEDS_REVIEW } from "./review.js";
import { pushPipelineEvents } from "./utils/pipelineDiagnostics.js";

const accounts = [
  { id: "acc-1", name: "Corriente", currency: "EUR" },
  { id: "acc-2", name: "USD", currency: "USD" },
];

// Simula el restore del reducer: encola los items de auto-captura sobre la cola previa.
function simulateRestore(queue, txs) {
  const resolvedIds = new Set([...(queue.resolved || []).map((i) => i.id), ...(queue.dismissed || []).map((i) => i.id)]);
  const items = buildUnreviewedItems(txs, { accounts, resolvedIds });
  return items.reduce((q, item) => enqueueItem(q, item), queue);
}

describe("auto-captura en restore (GP-02)", () => {
  it("encola txs sin categoría como needs_fix", () => {
    const txs = [
      { id: "t1", description: "Compra X", amount: -20, currency: "EUR", accountId: "acc-1", category: null },
    ];
    const queue = simulateRestore({ pending: [], resolved: [], dismissed: [] }, txs);
    expect(pendingCounts(queue).total).toBe(1);
    expect(queue.pending[0].id).toBe("unreviewed-t1");
    expect(queue.pending[0].classification).toBe(CLASS_NEEDS_FIX);
    expect(queue.pending[0].source).toBe("sync");
    expect(queue.pending[0].preview.accountName).toBe("Corriente");
  });

  it("encola txs con needsCategoryReview como revisión", () => {
    const txs = [
      { id: "t2", description: "Taco", amount: -8, currency: "EUR", accountId: "acc-1", category: "Otros", needsCategoryReview: true, _categoryConfidence: 0.7 },
    ];
    const queue = simulateRestore({ pending: [], resolved: [], dismissed: [] }, txs);
    expect(queue.pending.length).toBe(1);
    expect(queue.pending[0].classification).toBe(CLASS_NEEDS_REVIEW);
    expect(queue.pending[0].confidence).toBe(0.7);
  });

  it("encola txs con confianza baja (< 0.8)", () => {
    const txs = [
      { id: "t3", description: "Algo", amount: -5, currency: "EUR", accountId: "acc-1", category: "Otros", _categoryConfidence: 0.55 },
    ];
    const queue = simulateRestore({ pending: [], resolved: [], dismissed: [] }, txs);
    expect(queue.pending.length).toBe(1);
    expect(queue.pending[0].classification).toBe(CLASS_NEEDS_FIX);
  });

  it("NO encola txs con categoría válida y confianza alta (>= 0.8)", () => {
    const txs = [
      { id: "t4", description: "Netflix", amount: -12, currency: "EUR", accountId: "acc-1", category: "Suscripciones", _categoryConfidence: 0.95 },
    ];
    expect(buildUnreviewedItems(txs, { accounts })).toEqual([]);
  });

  it("dedupe: restore repetido no duplica items (idempotente)", () => {
    const txs = [
      { id: "t5", description: "Mercadona", amount: -64, currency: "EUR", accountId: "acc-1", category: null },
    ];
    let queue = { pending: [], resolved: [], dismissed: [] };
    queue = simulateRestore(queue, txs);
    queue = simulateRestore(queue, txs);
    queue = simulateRestore(queue, txs);
    expect(pendingCounts(queue).total).toBe(1);
  });

  it("respeta el cap de batch (no inunda en restores grandes)", () => {
    const txs = Array.from({ length: 200 }, (_, i) => ({
      id: `big-${i}`,
      description: `tx ${i}`,
      amount: -1,
      currency: "EUR",
      accountId: "acc-1",
      category: null,
    }));
    const items = buildUnreviewedItems(txs, { accounts });
    expect(items.length).toBeLessThanOrEqual(50);
  });
});

describe("ciclo completo: enqueue → accept (GP-04)", () => {
  it("aceptar un item auto-capturado lo mueve de pending a resolved", () => {
    const txs = [
      { id: "t10", description: "Gasolina", amount: -45, currency: "EUR", accountId: "acc-1", category: null },
    ];
    let queue = simulateRestore({ pending: [], resolved: [], dismissed: [] }, txs);
    expect(pendingCounts(queue).total).toBe(1);

    queue = acceptItem(queue, "unreviewed-t10");
    expect(pendingCounts(queue).total).toBe(0);
    expect(queue.resolved.length).toBe(1);
    expect(queue.resolved[0].id).toBe("unreviewed-t10");
    expect(queue.resolved[0].resolvedAt).toBeDefined();
  });

  it("un item resuelto no vuelve a encolarse en restore posterior", () => {
    const txs = [
      { id: "t11", description: "Panadería", amount: -3, currency: "EUR", accountId: "acc-1", category: null },
    ];
    let queue = simulateRestore({ pending: [], resolved: [], dismissed: [] }, txs);
    queue = acceptItem(queue, "unreviewed-t11");
    const second = simulateRestore(queue, txs);
    expect(pendingCounts(second).total).toBe(0);
    expect(second.resolved.length).toBe(1);
  });

  it("un item descartado no vuelve a encolarse en restore posterior", () => {
    const txs = [
      { id: "t12", description: "Café", amount: -2, currency: "EUR", accountId: "acc-1", category: null },
    ];
    let queue = simulateRestore({ pending: [], resolved: [], dismissed: [] }, txs);
    queue = dismissItem(queue, "unreviewed-t12");
    const second = simulateRestore(queue, txs);
    expect(pendingCounts(second).total).toBe(0);
  });
});

describe("telemetría (GP-03)", () => {
  it("los eventos de auto-captura son empujables y ordenados", () => {
    const events = pushPipelineEvents([], [{ ts: 1, source: "sync", kind: "auto_capture", detail: "x" }]);
    expect(events.length).toBe(1);
    expect(events[0].source).toBe("sync");
    expect(events[0].kind).toBe("auto_capture");
  });
});