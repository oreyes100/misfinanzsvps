// review.test.js — Tests de la cola de revisión MCP (Command Center).
import { describe, it, expect } from "vitest";
import {
  classifyConfidence,
  buildStagedAction,
  emptyQueue,
  enqueueItem,
  acceptItem,
  dismissItem,
  acceptAllReviewable,
  dismissAll,
  cleanupReviewQueue,
  buildEvidence,
  pendingCounts,
  CLASS_NEEDS_FIX,
  CLASS_NEEDS_REVIEW,
  CLASS_AUTO_OK,
} from "./review.js";

const item = (id, over = {}) => ({
  id,
  classification: CLASS_NEEDS_REVIEW,
  confidence: 0.7,
  source: "assistant",
  createdAt: 1000,
  preview: { description: `Item ${id}`, amount: -10, currency: "EUR" },
  ...over,
});

const ACC = [{ id: "a1", name: "Corriente", currency: "EUR", balance: 100 }];

describe("review · classifyConfidence", () => {
  it("clasifica por umbrales", () => {
    expect(classifyConfidence(0.5)).toBe(CLASS_NEEDS_FIX);
    expect(classifyConfidence(0.7)).toBe(CLASS_NEEDS_REVIEW);
    expect(classifyConfidence(0.9)).toBe(CLASS_AUTO_OK);
    expect(classifyConfidence(1)).toBe(CLASS_AUTO_OK);
  });

  it("fallback a needs_review si no es número", () => {
    expect(classifyConfidence(NaN)).toBe(CLASS_NEEDS_REVIEW);
    expect(classifyConfidence(undefined)).toBe(CLASS_NEEDS_REVIEW);
  });
});

describe("review · buildStagedAction", () => {
  it("expense → add_transaction con importe negativo", () => {
    const action = buildStagedAction(
      { type: "expense", amount: 20, description: "Cena", category: "Comida", subcategory: null, _resolvedAccount: ACC[0] },
      ACC
    );
    expect(action.type).toBe("add_transaction");
    expect(action.tx.amount).toBe(-20);
    expect(action.tx.accountId).toBe("a1");
    expect(action.tx.category).toBe("Comida");
  });

  it("income → add_transaction con importe positivo", () => {
    const action = buildStagedAction({ type: "income", amount: 150, description: "Venta", category: "Ingresos", _resolvedAccount: ACC[0] }, ACC);
    expect(action.tx.amount).toBe(150);
  });

  it("transfer → transfer con fromId/toId", () => {
    const action = buildStagedAction({ type: "transfer", amount: 50, _fromAccount: ACC[0], _toAccount: { id: "a2", name: "Ahorro", currency: "EUR" } }, ACC);
    expect(action.type).toBe("transfer");
    expect(action.fromId).toBe("a1");
    expect(action.toId).toBe("a2");
  });

  it("set_limit → set_limit", () => {
    const action = buildStagedAction({ type: "set_limit", amount: 900 }, ACC);
    expect(action).toEqual({ type: "set_limit", amount: 900 });
  });

  it("intent no accionable o sin cuentas → null", () => {
    expect(buildStagedAction({ type: "unknown" }, ACC)).toBeNull();
    expect(buildStagedAction({ type: "expense", amount: 1 }, [])).toBeNull();
  });
});

describe("review · transforms de la cola", () => {
  it("enqueueItem añade con dedupe por id", () => {
    let q = emptyQueue();
    q = enqueueItem(q, item("i1"));
    q = enqueueItem(q, item("i1"));
    expect(q.pending).toHaveLength(1);
    expect(enqueueItem(q, null)).toBe(q);
  });

  it("acceptItem mueve pending → resolved", () => {
    let q = enqueueItem(emptyQueue(), item("i1"));
    q = acceptItem(q, "i1");
    expect(q.pending).toHaveLength(0);
    expect(q.resolved).toHaveLength(1);
    expect(q.resolved[0].id).toBe("i1");
    expect(q.resolved[0].resolvedAt).toBeGreaterThan(0);
    expect(acceptItem(q, "no-existe")).toBe(q);
  });

  it("dismissItem mueve pending → dismissed", () => {
    let q = enqueueItem(emptyQueue(), item("i1"));
    q = dismissItem(q, "i1");
    expect(q.pending).toHaveLength(0);
    expect(q.dismissed).toHaveLength(1);
    expect(q.dismissed[0].dismissedAt).toBeGreaterThan(0);
  });

  it("acceptAllReviewable solo acepta needs_review (no needs_fix)", () => {
    let q = emptyQueue();
    q = enqueueItem(q, item("fix", { classification: CLASS_NEEDS_FIX, confidence: 0.4 }));
    q = enqueueItem(q, item("rev", { classification: CLASS_NEEDS_REVIEW, confidence: 0.7 }));
    q = acceptAllReviewable(q);
    expect(q.pending.map((i) => i.id)).toEqual(["fix"]);
    expect(q.resolved.map((i) => i.id)).toEqual(["rev"]);
  });

  it("dismissAll vacía pending", () => {
    let q = enqueueItem(enqueueItem(emptyQueue(), item("i1")), item("i2"));
    q = dismissAll(q);
    expect(q.pending).toHaveLength(0);
    expect(q.dismissed).toHaveLength(2);
    expect(dismissAll(emptyQueue())).toEqual(emptyQueue());
  });

  it("pendingCounts cuenta por severidad", () => {
    let q = emptyQueue();
    q = enqueueItem(q, item("a", { classification: CLASS_NEEDS_FIX }));
    q = enqueueItem(q, item("b", { classification: CLASS_NEEDS_REVIEW }));
    q = enqueueItem(q, item("c", { classification: CLASS_NEEDS_REVIEW }));
    expect(pendingCounts(q)).toEqual({ total: 3, needsFix: 1, needsReview: 2 });
    expect(pendingCounts(null)).toEqual({ total: 0, needsFix: 0, needsReview: 0 });
  });
});

describe("review · cleanup", () => {
  const DAY = 24 * 60 * 60 * 1000;

  it("podaa resolved > 30d y dismissed > 7d", () => {
    const now = 1_000_000;
    const q = {
      pending: [],
      resolved: [
        { ...item("old", { resolvedAt: now - 31 * DAY }) },
        { ...item("new", { resolvedAt: now - 1 * DAY }) },
      ],
      dismissed: [
        { ...item("dold", { dismissedAt: now - 8 * DAY }) },
        { ...item("dnew", { dismissedAt: now - 2 * DAY }) },
      ],
    };
    const cleaned = cleanupReviewQueue(q, now);
    expect(cleaned.resolved.map((i) => i.id)).toEqual(["new"]);
    expect(cleaned.dismissed.map((i) => i.id)).toEqual(["dnew"]);
  });

  it("cap a MAX_RESOLVED_ITEMS", () => {
    const now = 1_000_000;
    const many = Array.from({ length: 1100 }, (_, i) => item(`r${i}`, { resolvedAt: now - i }));
    const cleaned = cleanupReviewQueue({ ...emptyQueue(), resolved: many }, now);
    expect(cleaned.resolved.length).toBeLessThanOrEqual(1000);
  });
});

describe("buildEvidence (WG10: evidencia completa)", () => {
  it("OCR con recibo → receipt con receiptId", () => {
    const res = buildEvidence({ source: "ocr", receiptId: "rec_1", receiptUrl: "blob:url" });
    expect(res.kind).toBe("receipt");
    expect(res.receiptId).toBe("rec_1");
  });

  it("sync → statement con los datos del movimiento (NUNCA 'sin recibo')", () => {
    const res = buildEvidence({
      source: "sync",
      preview: { accountName: "BBVA Nómina", accountId: "a1", date: "2026-07-15", description: "SPEI Bodega Express", amount: -4000 },
    });
    expect(res.kind).toBe("statement");
    expect(res.accountName).toBe("BBVA Nómina");
    expect(res.amount).toBe(-4000);
  });

  it("ocr sin recibo → kind ocr (verificar importe)", () => {
    const res = buildEvidence({ source: "ocr", preview: { description: "Ticket" } });
    expect(res.kind).toBe("ocr");
  });

  it("manual → none", () => {
    expect(buildEvidence({ source: "manual" }).kind).toBe("none");
  });

  it("item null → none", () => {
    expect(buildEvidence(null).kind).toBe("none");
  });
});