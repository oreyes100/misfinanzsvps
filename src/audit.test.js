import { describe, it, expect } from "vitest";
import { auditStatement, aiItemsToChecklist, summarizeChecklist } from "./audit.js";

const ACC = { id: "acc-1", name: "BBVA Nómina", type: "checking", currency: "MXN", balance: 1000 };

const mkExtract = (movements) => ({ type: "statement", merchant: "BBVA Nómina", movements });
const mkTx = (over) => ({ id: over.id, date: over.date, description: over.description, amount: over.amount, accountId: "acc-1", category: over.category || null, ...over });

describe("audit · matching 1-a-1 (consumo)", () => {
  it("dos cargos idénticos del extracto NO matchean la misma transacción registrada", () => {
    const extract = mkExtract([
      { date: "2026-07-01", description: "Oxxo", amount: 50, direction: "out" },
      { date: "2026-07-01", description: "Oxxo", amount: 50, direction: "out" },
    ]);
    const txs = [mkTx({ id: "t1", date: "2026-07-01", description: "Oxxo", amount: -50 })];
    const r = auditStatement(extract, [ACC], txs, { overrideAccountId: "acc-1" });
    // Solo uno matchea; el segundo debe reportarse como faltante
    expect(r.summary.missingTransactions).toBe(1);
    expect(r.summary.exactMatches).toBe(1);
  });

  it("movimiento sin registro se reporta como faltante con proposal", () => {
    const extract = mkExtract([{ date: "2026-07-02", description: "Netflix", amount: 12.99, direction: "out", category: "Suscripciones" }]);
    const r = auditStatement(extract, [ACC], [], { overrideAccountId: "acc-1" });
    expect(r.checklist).toHaveLength(1);
    expect(r.checklist[0].type).toBe("missing_transaction");
    expect(r.checklist[0].proposal.description).toBe("Netflix");
    expect(r.checklist[0].proposal.category).toBe("Suscripciones");
  });
});

describe("audit · asientos fantasma", () => {
  it("tx registrada dentro del período pero ausente del extracto se marca como phantom", () => {
    const extract = mkExtract([
      { date: "2026-07-01", description: "Oxxo", amount: 50, direction: "out" },
      { date: "2026-07-10", description: "Nómina", amount: 5000, direction: "in" },
    ]);
    const txs = [
      mkTx({ id: "t1", date: "2026-07-01", description: "Oxxo", amount: -50 }),
      mkTx({ id: "t2", date: "2026-07-10", description: "Nómina", amount: 5000 }),
      mkTx({ id: "t3", date: "2026-07-05", description: "Gasto inventado", amount: -300 }),
    ];
    const r = auditStatement(extract, [ACC], txs, { overrideAccountId: "acc-1" });
    const phantom = r.checklist.find((c) => c.type === "phantom_transaction");
    expect(phantom).toBeDefined();
    expect(phantom.tx.id).toBe("t3");
    expect(phantom.action).toBe("remove_transaction");
    expect(r.summary.phantomTransactions).toBe(1);
  });

  it("tx fuera del período del extracto NO se marca como phantom", () => {
    const extract = mkExtract([
      { date: "2026-07-01", description: "Oxxo", amount: 50, direction: "out" },
      { date: "2026-07-10", description: "Nómina", amount: 5000, direction: "in" },
    ]);
    const txs = [
      mkTx({ id: "t1", date: "2026-07-01", description: "Oxxo", amount: -50 }),
      mkTx({ id: "t2", date: "2026-07-10", description: "Nómina", amount: 5000 }),
      mkTx({ id: "t4", date: "2026-06-15", description: "Compra vieja", amount: -100 }),
    ];
    const r = auditStatement(extract, [ACC], txs, { overrideAccountId: "acc-1" });
    expect(r.summary.phantomTransactions).toBe(0);
  });
});

describe("audit · detail_mismatch ya no es silencioso", () => {
  it("mismo importe y fecha con descripción muy distinta genera item low", () => {
    const extract = mkExtract([{ date: "2026-07-03", description: "SPEI ENVIADO BANORTE 12345", amount: 200, direction: "out" }]);
    const txs = [mkTx({ id: "t1", date: "2026-07-03", description: "Zapatos", amount: -200 })];
    const r = auditStatement(extract, [ACC], txs, { overrideAccountId: "acc-1" });
    const det = r.checklist.find((c) => c.type === "detail_mismatch");
    expect(det).toBeDefined();
    expect(det.severity).toBe("low");
    expect(det.registeredDescription).toBe("Zapatos");
  });
});

describe("audit · importe incorrecto", () => {
  it("propone corrección con proposal completa", () => {
    const extract = mkExtract([{ date: "2026-07-04", description: "Mercadona", amount: 64.5, direction: "out" }]);
    const txs = [mkTx({ id: "t1", date: "2026-07-04", description: "Mercadona", amount: -60 })];
    const r = auditStatement(extract, [ACC], txs, { overrideAccountId: "acc-1" });
    const amt = r.checklist.find((c) => c.type === "amount_mismatch");
    expect(amt).toBeDefined();
    expect(amt.proposal.amount).toBe(64.5);
    expect(amt.registeredAmount).toBe(60);
  });
});

describe("audit · aiItemsToChecklist", () => {
  const txs = [mkTx({ id: "t1", date: "2026-07-01", description: "Oxxo", amount: -50 })];

  it("convierte hallazgos de IA al formato del checklist", () => {
    const items = [
      { kind: "missing", severity: "high", date: "2026-07-02", description: "Uber", amount: 89, direction: "out", txId: null, explanation: "No registrado", proposal: { description: "Uber viaje", amount: 89, date: "2026-07-02", category: "Transporte", notes: "Detectado en auditoría" } },
      { kind: "phantom", severity: "medium", date: "2026-07-01", description: "Oxxo", amount: 50, direction: "out", txId: "t1", explanation: "Sin respaldo", proposal: null },
    ];
    const list = aiItemsToChecklist(items, txs);
    expect(list).toHaveLength(2);
    expect(list[0].type).toBe("missing_transaction");
    expect(list[0].action).toBe("add_transaction");
    expect(list[0].proposal.category).toBe("Transporte");
    expect(list[1].type).toBe("phantom_transaction");
    expect(list[1].tx.id).toBe("t1");
  });

  it("descarta items con txId alucinado (no existe)", () => {
    const items = [{ kind: "amount_mismatch", severity: "medium", date: "2026-07-01", description: "X", amount: 10, direction: "out", txId: "no-existe", explanation: "", proposal: null }];
    expect(aiItemsToChecklist(items, txs)).toHaveLength(0);
  });

  it("summarizeChecklist no cuenta fantasmas como discrepancias de movimientos", () => {
    const items = [
      { kind: "phantom", severity: "medium", date: "2026-07-01", description: "Oxxo", amount: 50, direction: "out", txId: "t1", explanation: "", proposal: null },
    ];
    const list = aiItemsToChecklist(items, txs);
    const s = summarizeChecklist(list, 5);
    expect(s.exactMatches).toBe(5); // los 5 movimientos del extracto cuadran
    expect(s.phantomTransactions).toBe(1);
  });
});
