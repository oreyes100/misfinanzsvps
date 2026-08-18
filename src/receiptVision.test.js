// receiptVision.test.js — Tests de la OPERACIÓN RECEIPT VISION (RV-04/RV-05).
// Cubre la lógica pura de transferencias atómicas y el storage de recibos.

import { describe, it, expect } from "vitest";
import { findTransferPair, editTransferPair, convertToTransfer, convertFromTransfer, buildTransferPair } from "./transfers.js";

const FX = { EUR: 1, USD: 0.92, GBP: 1.17, MXN: 0.05 };
const EUR = { currency: "EUR" };
const USD = { currency: "USD" };

function state({ accounts = [], transactions = [] } = {}) {
  return {
    accounts: accounts.map((a) => ({ balance: 1000, ...a })),
    transactions,
    fx: FX,
  };
}

function pairTx(amount, fromId = "a", toId = "b", over = {}) {
  const outId = over.outId || "out1";
  const inId = over.inId || "in1";
  return [
    { id: outId, accountId: fromId, counterpartId: toId, amount: -amount, date: "2026-08-18", description: "Transferencia a B", category: "Transferencia", ...(over.out || {}) },
    { id: inId, accountId: toId, counterpartId: fromId, amount, date: "2026-08-18", description: "Transferencia desde A", category: "Transferencia", ...(over.in || {}) },
  ];
}

describe("findTransferPair", () => {
  it("encuentra el par por counterpartId mutuo", () => {
    const txs = pairTx(100);
    const { out, in: inTx } = findTransferPair(txs, txs[0]);
    expect(out.id).toBe("out1");
    expect(inTx.id).toBe("in1");
  });

  it("funciona desde cualquiera de las dos patas", () => {
    const txs = pairTx(100);
    const { out, in: inTx } = findTransferPair(txs, txs[1]);
    expect(out.id).toBe("out1");
    expect(inTx.id).toBe("in1");
  });

  it("retorna null para tx sin counterpartId", () => {
    const tx = { id: "x", accountId: "a", amount: -50 };
    expect(findTransferPair([tx], tx)).toEqual({ out: null, in: null });
  });
});

describe("buildTransferPair", () => {
  it("crea par con counterpartId mutuo y saldos espejados", () => {
    const [out, inTx] = buildTransferPair({
      fromAccountId: "a", toAccountId: "b", amount: 100,
      fromCurrency: "EUR", toCurrency: "EUR", fx: FX,
    });
    expect(out.amount).toBe(-100);
    expect(out.accountId).toBe("a");
    expect(out.counterpartId).toBe("b");
    expect(inTx.amount).toBe(100);
    expect(inTx.accountId).toBe("b");
    expect(inTx.counterpartId).toBe("a");
    expect(inTx.category).toBe("Transferencia");
  });

  it("convierte divisa en el destino", () => {
    const [out, inTx] = buildTransferPair({
      fromAccountId: "a", toAccountId: "b", amount: 100,
      fromCurrency: "EUR", toCurrency: "USD", fx: FX,
    });
    expect(out.amount).toBe(-100);
    expect(inTx.amount).toBe(Math.round((100 * 1) / 0.92 * 100) / 100); // 108.70 USD
  });

  it("propaga metadata (receiptId, tags, notes)", () => {
    const [out] = buildTransferPair({
      fromAccountId: "a", toAccountId: "b", amount: 50,
      fromCurrency: "EUR", toCurrency: "EUR", fx: FX,
      metadata: { receiptId: "rec_1", tags: ["cena"], notes: "n" },
    });
    expect(out.receiptId).toBe("rec_1");
    expect(out.tags).toEqual(["cena"]);
  });
});

describe("editTransferPair (RV-05: swap atómico sin duplicados)", () => {
  it("cambia el destino del par sin duplicar transacciones", () => {
    const s = state({
      accounts: [{ id: "a" }, { id: "b" }, { id: "c" }],
      transactions: pairTx(100),
    });
    const res = editTransferPair(s, { originalId: "out1", newToAccountId: "c" });

    expect(res).not.toBeNull();
    // El par viejo (out1, in1) desaparece; quedan 2 nuevas.
    expect(res.transactions.length).toBe(2);
    expect(res.transactions.some((t) => t.id === "out1")).toBe(false);
    expect(res.transactions.some((t) => t.id === "in1")).toBe(false);
    // Nuevo destino = c
    const newIn = res.transactions.find((t) => t.amount > 0);
    expect(newIn.accountId).toBe("c");
    expect(newIn.counterpartId).toBe("a");
    const newOut = res.transactions.find((t) => t.amount < 0);
    expect(newOut.accountId).toBe("a");
    expect(newOut.counterpartId).toBe("c");
    // Sin duplicados: exactamente 2 transacciones.
    expect(res.transactions.filter((t) => t.accountId === "a").length).toBe(1);
  });

  it("reajusta saldos de forma consistente (invariante de suma)", () => {
    const s = state({
      accounts: [{ id: "a", balance: 1000 }, { id: "b", balance: 500 }, { id: "c", balance: 700 }],
      transactions: pairTx(100),
    });
    // Los saldos YA incluyen el par original: a=1000 (incluye -100), b=500 (incluye +100).
    const before = 1000 + 500 + 700;
    const res = editTransferPair(s, { originalId: "out1", newToAccountId: "c", newAmount: 150 });
    const after = res.accounts.reduce((sum, a) => sum + a.balance, 0);
    // La suma de saldos se conserva (solo se redistribuye).
    expect(after).toBe(before);
    // a: -100 → -150 (revertir + aplicar) = 950; b: 500 - 100 = 400; c: 700 + 150 = 850.
    expect(res.accounts.find((a) => a.id === "a").balance).toBe(950);
    expect(res.accounts.find((a) => a.id === "b").balance).toBe(400);
    expect(res.accounts.find((a) => a.id === "c").balance).toBe(850);
  });

  it("edita monto y fecha propagándolos a ambas patas", () => {
    const s = state({
      accounts: [{ id: "a" }, { id: "b" }],
      transactions: pairTx(100),
    });
    const res = editTransferPair(s, { originalId: "out1", newAmount: 250, newDate: "2026-09-01", newDescription: "Traslado" });
    const [newOut, newIn] = res.transactions;
    expect(Math.abs(newOut.amount)).toBe(250);
    expect(newIn.amount).toBe(250);
    expect(newOut.date).toBe("2026-09-01");
    expect(newOut.description).toBe("Traslado");
  });

  it("no permite origen == destino", () => {
    const s = state({
      accounts: [{ id: "a" }, { id: "b" }],
      transactions: pairTx(100),
    });
    expect(editTransferPair(s, { originalId: "out1", newToAccountId: "a" })).toBeNull();
  });
});

describe("convertToTransfer (RV-04: gasto → transferencia)", () => {
  it("convierte un gasto en par de transferencias sin duplicados", () => {
    const s = state({
      accounts: [{ id: "a" }, { id: "b" }],
      transactions: [
        { id: "exp1", accountId: "a", amount: -30, date: "2026-08-18", description: "Compra", category: "Otros" },
      ],
    });
    const res = convertToTransfer(s, { transactionId: "exp1", toAccountId: "b" });
    expect(res).not.toBeNull();
    expect(res.transactions.length).toBe(2); // reemplaza la tx por el par
    expect(res.transactions.some((t) => t.id === "exp1")).toBe(false);
    const newOut = res.transactions.find((t) => t.amount < 0);
    expect(newOut.accountId).toBe("a");
    expect(newOut.amount).toBe(-30);
    const newIn = res.transactions.find((t) => t.amount > 0);
    expect(newIn.accountId).toBe("b");
  });

  it("reajusta el saldo (el gasto -30 ya está en el saldo; se mantiene el neto en a y b recibe)", () => {
    const s = state({
      accounts: [{ id: "a", balance: 1000 }, { id: "b", balance: 800 }],
      transactions: [
        { id: "exp1", accountId: "a", amount: -30, date: "2026-08-18", description: "Compra", category: "Otros" },
      ],
    });
    const res = convertToTransfer(s, { transactionId: "exp1", toAccountId: "b" });
    // a: revierte el -30 del gasto y aplica -30 de la transferencia → neto igual.
    expect(res.accounts.find((a) => a.id === "a").balance).toBe(1000);
    expect(res.accounts.find((a) => a.id === "b").balance).toBe(830);
  });
});

describe("convertFromTransfer (RV-04: transferencia → gasto)", () => {
  it("convierte el par en un gasto en la cuenta origen", () => {
    const s = state({
      accounts: [{ id: "a" }, { id: "b" }],
      transactions: pairTx(80),
    });
    const res = convertFromTransfer(s, { transactionId: "out1", newType: "expense", newCategoryId: "Comida" });
    expect(res).not.toBeNull();
    expect(res.transactions.length).toBe(1);
    const tx = res.transactions[0];
    expect(tx.amount).toBe(-80);
    expect(tx.accountId).toBe("a");
    expect(tx.category).toBe("Comida");
  });

  it("reajusta saldos al quitar el par (a mantiene neto -80, b pierde el +80)", () => {
    const s = state({
      accounts: [{ id: "a", balance: 1000 }, { id: "b", balance: 800 }],
      transactions: pairTx(80),
    });
    const res = convertFromTransfer(s, { transactionId: "out1", newType: "expense", newCategoryId: "Comida" });
    // a: revierte el -80 del par y aplica el -80 del gasto → neto igual.
    expect(res.accounts.find((a) => a.id === "a").balance).toBe(1000);
    expect(res.accounts.find((a) => a.id === "b").balance).toBe(720);
  });
});