// push.test.mjs — W25: Bot-Server Integration. El bot escribe vía POST /api/push.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pushDelta, computeDelta, addTransaction, addTransfer } from "./apply.mjs";
import { consolidateAndBump } from "../../api/_merge.js";

const cfg = { syncCode: "mf-test-code", serverUrl: "http://127.0.0.1:3000" };
const noSleep = async () => {};

const okRes = (data) => ({ ok: true, json: async () => ({ ok: true, state: { _syncVersion: 999 }, syncVersion: 999, hash: "abc" , ...data }) });

test("W25: pushDelta hace POST /api/push?id=<syncCode> con el delta y devuelve la respuesta del server", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return okRes();
  };
  const delta = { accounts: [{ id: "a1", balance: 90 }], transactions: [{ id: "tx1" }] };
  const res = await pushDelta(cfg, delta, { fetchImpl, maxRetries: 1, sleep: noSleep });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:3000/api/push?id=mf-test-code");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body).state, delta);
  assert.equal(res.syncVersion, 999);
});

test("W25: pushDelta reintenta y triunfa (fallo transitorio de red no pierde la transacción)", async () => {
  let n = 0;
  const fetchImpl = async () => {
    n++;
    if (n < 3) throw new Error("ECONNREFUSED");
    return okRes();
  };
  const res = await pushDelta(cfg, {}, { fetchImpl, maxRetries: 3, sleep: noSleep });
  assert.equal(n, 3);
  assert.equal(res.ok, true);
});

test("W25 Fase 2: pushDelta lanza si el server nunca confirma ok → el bot NO reporta 'aplicada'", async () => {
  let n = 0;
  const fetchImpl = async () => {
    n++;
    return { ok: false, status: 500 };
  };
  await assert.rejects(
    () => pushDelta(cfg, {}, { fetchImpl, maxRetries: 3, sleep: noSleep }),
    /falló tras 3 intentos/
  );
  assert.equal(n, 3);
});

test("W25: addTransaction marca _updatedAt en la cuenta modificada (para ganar el merge del server)", () => {
  const before = 1725000000000;
  const state = { accounts: [{ id: "a1", balance: 100, _updatedAt: before }], transactions: [] };
  const next = addTransaction(state, { description: "Café", amount: -30, currency: "MXN", accountId: "a1", category: "Comida" });
  const acc = next.accounts.find((a) => a.id === "a1");
  assert.equal(acc.balance, 70);
  assert.ok(acc._updatedAt > before, "la cuenta tocada debe tener _updatedAt más reciente");
});

test("W25: addTransfer marca _updatedAt en ambas cuentas", () => {
  const state = {
    accounts: [
      { id: "from", name: "A", balance: 100, _updatedAt: 1 },
      { id: "to", name: "B", balance: 0, _updatedAt: 1 },
    ],
    transactions: [],
    fx: {},
  };
  const next = addTransfer(state, { fromId: "from", toId: "to", amount: 40 });
  assert.ok(next.accounts.find((a) => a.id === "from")._updatedAt > 1);
  assert.ok(next.accounts.find((a) => a.id === "to")._updatedAt > 1);
});

test("W25: computeDelta devuelve solo transacciones nuevas y cuentas con balance cambiado", () => {
  const prev = {
    accounts: [
      { id: "a1", balance: 100 },
      { id: "a2", balance: 500 },
    ],
    transactions: [{ id: "old1" }],
  };
  const next = {
    accounts: [
      { id: "a1", balance: 70 },
      { id: "a2", balance: 500 },
    ],
    transactions: [{ id: "old1" }, { id: "new1" }, { id: "new2" }],
  };
  const delta = computeDelta(prev, next);
  assert.deepEqual(delta.accounts.map((a) => a.id), ["a1"]);
  assert.deepEqual(delta.transactions.map((t) => t.id), ["new1", "new2"]);
});

test("W25: consolidateAndBump(existing, delta del bot) conserva la transacción del bot y el resto del estado", () => {
  const existing = {
    _syncVersion: 284,
    settings: { softLimit: 100 },
    accounts: [
      { id: "a1", name: "Efectivo", balance: 100, _updatedAt: 1 },
      { id: "web1", name: "Cuenta webapp", balance: 9000, _updatedAt: 5 },
    ],
    transactions: [{ id: "webTx", description: "De la webapp", amount: -10 }],
  };
  const botDelta = {
    accounts: [{ id: "a1", name: "Efectivo", balance: 70, _updatedAt: Date.now() }],
    transactions: [{ id: "botTx", description: "Recibo del bot", amount: -30 }],
  };
  const merged = consolidateAndBump(existing, botDelta);
  const ids = merged.transactions.map((t) => t.id);
  assert.ok(ids.includes("botTx"), "la tx del bot debe sobrevivir la consolidación");
  assert.ok(ids.includes("webTx"), "la tx de la webapp debe sobrevivir");
  assert.equal(merged.accounts.find((a) => a.id === "a1").balance, 70, "balance del bot gana por _updatedAt");
  assert.equal(merged.accounts.find((a) => a.id === "web1").balance, 9000, "cuenta ajena intacta");
  assert.equal(merged.settings.softLimit, 100, "settings intactos");
  assert.equal(merged._syncVersion, 285, "versión consolidada = max+1");
});
