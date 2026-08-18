// apply.test.mjs — Tests de addConflictTransaction (WG11: conflicto OCR).
// Se ejecuta con: node --test server/hermes/apply.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { addConflictTransaction } from "./apply.mjs";

test("addConflictTransaction: crea tx conflictiva sin cuenta ni categoría", () => {
  const state = { accounts: [{ id: "a1", balance: 100 }], transactions: [] };
  const next = addConflictTransaction(state, {
    description: "Transferencia sin resolver: BBVA → UALA",
    amount: -1200,
    currency: "EUR",
    date: "2026-08-18",
    auto: true,
    pendingResolution: { reason: "cuentas no resueltas", from: "BBVA", to: "UALA" },
    evidenceUrl: "1750000000000-abc123.jpg",
  });
  assert.equal(next.transactions.length, 1);
  const tx = next.transactions[0];
  assert.equal(tx.category, null);
  assert.equal(tx.accountId, null);
  assert.equal(tx._needsCategoryReview, true);
  assert.equal(tx._categorySource, "conflict");
  assert.equal(tx.pendingResolution.from, "BBVA");
  assert.equal(tx.evidenceUrl, "1750000000000-abc123.jpg");
  assert.equal(next.accounts[0].balance, 100); // no toca balances
});

test("addConflictTransaction: defaults razonables si faltan campos", () => {
  const state = { accounts: [], transactions: [] };
  const next = addConflictTransaction(state, { amount: -50 });
  const tx = next.transactions[0];
  assert.equal(tx.pendingResolution.reason, "conflicto OCR");
  assert.equal(tx.evidenceUrl, null);
  assert.ok(tx.id);
});