// seed.test.mjs — w32-i3: seed de datos demo para cuentas nuevas.
// Unit tests puros (sin I/O): el estado sembrado debe ser coherente con el
// SEED del cliente (reducer.ts) y compatible con consolidateAndBump (W23).

import test from "node:test";
import assert from "node:assert/strict";
import { buildDemoState, demoSyncCode, DEMO_ACCOUNT_IDS, DEMO_CATEGORIES, DEMO_FX, MONEY_ACCOUNT_TYPES } from "./seed.mjs";
import { consolidateAndBump } from "../api/_merge.js";

const NOW = 1_788_500_000_000; // ancla fija → determinismo total

test("seed: al menos una cuenta de dinero demo con id y saldo numérico", () => {
  const s = buildDemoState({ email: "a@b.com", now: NOW });
  assert.ok(Array.isArray(s.accounts) && s.accounts.length >= 1);
  const money = s.accounts.filter((a) => MONEY_ACCOUNT_TYPES.has(a.type));
  assert.ok(money.length >= 1, "debe haber ≥1 cuenta de dinero (checking/savings/deposit)");
  for (const a of s.accounts) {
    assert.equal(typeof a.id, "string", "id string");
    assert.ok(a.id.length >= 4, "id con longitud razonable");
    assert.equal(typeof a.name, "string");
    assert.ok(["EUR", "USD", "MXN", "GBP"].includes(a.currency));
    assert.equal(typeof a.balance, "number");
    assert.ok(Number.isFinite(a.balance));
    assert.ok(a.balance > 0, "saldo demo positivo");
    assert.ok(["none", "daily", "monthly"].includes(a.accrual));
    assert.equal(typeof a.rate, "number");
  }
  // Los ids coinciden con los que filterAccounts concede al usuario demo.
  for (const id of DEMO_ACCOUNT_IDS) assert.ok(s.accounts.some((a) => a.id === id), `cuenta ${id} presente`);
});

test("seed: ids de cuentas únicos y transacciones coherentes con cuentas/categorías", () => {
  const s = buildDemoState({ now: NOW });
  const ids = s.accounts.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, "ids de cuenta sin duplicados");

  const catNames = new Set(DEMO_CATEGORIES.map((c) => c.name));
  const txIds = new Set();
  for (const t of s.transactions) {
    assert.equal(typeof t.id, "string");
    assert.ok(!txIds.has(t.id), "id de transacción único");
    txIds.add(t.id);
    assert.ok(ids.includes(t.accountId), `tx ${t.id} referencia cuenta existente`);
    assert.ok(catNames.has(t.category), `tx ${t.id} con categoría conocida (${t.category})`);
    assert.equal(typeof t.amount, "number");
    assert.ok(Number.isFinite(t.amount) && t.amount !== 0);
    assert.match(t.date, /^\d{4}-\d{2}-\d{2}$/, "date yyyy-mm-dd");
  }
  assert.ok(s.transactions.length >= 5, "hay transacciones de ejemplo suficientes");
  // La nómina es ingreso y hay gastos: semilla con ambos lados del flujo.
  assert.ok(s.transactions.some((t) => t.amount > 0), "hay ingreso demo");
  assert.ok(s.transactions.some((t) => t.amount < 0), "hay gasto demo");
});

test("seed: categorías completas con ids únicos y system presentes", () => {
  const ids = DEMO_CATEGORIES.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, "ids de categoría únicos");
  const names = DEMO_CATEGORIES.map((c) => c.name);
  for (const required of ["Comida", "Supermercado", "Transporte", "Hogar", "Suscripciones", "Ingresos", "Intereses", "Impuestos", "Otros"]) {
    assert.ok(names.includes(required), `categoría ${required} presente`);
  }
  const others = DEMO_CATEGORIES.find((c) => c.name === "Otros");
  assert.equal(others.system, true, "Otros es system (fallback de categorize)");
});

test("seed: estado hidratable por el cliente (flags demo, slices, fx/priceHistory)", () => {
  const s = buildDemoState({ now: NOW });
  assert.equal(s._isDemo, true, "marca demo (el reducer la limpia en la primera acción real)");
  assert.equal(typeof s._demoSeededAt, "number");
  assert.equal(s._syncVersion, 1, "arranca en versión 1 (server = fuente de verdad)");
  assert.deepEqual(s.reviewQueue, { pending: [], resolved: [], dismissed: [] }, "reviewQueue presente (hydrate la exige)");
  assert.deepEqual(s.pipelineEvents, []);
  assert.deepEqual(s.deletedAccountIds, []);
  assert.deepEqual(s.deletedTransactions, {});
  assert.deepEqual(s.scheduled, []);
  // fx con la convención W29 (EUR por unidad) + historial para useFX/update_fx.
  assert.equal(s.fx.EUR, 1);
  assert.ok(s.fx.MXN > 0 && s.fx.MXN < 1, "MXN en EUR por unidad");
  for (const k of ["BTC", "ETH", "GOLD"]) {
    assert.ok(Array.isArray(s.priceHistory[k]) && s.priceHistory[k].length === 48, `priceHistory.${k} con 48 puntos`);
  }
  assert.equal(s.goldPriceEUR, 68.4);
  assert.equal(s.settings.baseCurrency, "MXN");
  assert.equal(s.settings.spendLimit, 1200);
});

test("seed: determinista — misma entrada, mismo JSON (re-seed idempotente)", () => {
  const a = buildDemoState({ email: "user@example.com", now: NOW });
  const b = buildDemoState({ email: "user@example.com", now: NOW });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(a._seededEmail, "user@example.com");
});

test("seed: compatible con consolidateAndBump (W23) — merge por id y bump de versión", () => {
  const demo = buildDemoState({ now: NOW });
  const delta = {
    transactions: [
      { id: "tx-nueva", date: "2026-09-03", description: "Taxi", amount: -9.5, currency: "EUR", category: "Transporte", accountId: "acc-corriente", auto: true, _updatedAt: NOW + 1 },
    ],
    _syncVersion: 1,
  };
  const merged = consolidateAndBump(demo, delta);
  assert.ok(merged.accounts.some((a) => a.id === "acc-corriente"), "cuentas demo se conservan");
  assert.ok(merged.transactions.some((t) => t.id === "tx-1"), "transacciones demo se conservan");
  assert.ok(merged.transactions.some((t) => t.id === "tx-nueva"), "delta entra al merge");
  assert.ok(merged._syncVersion >= 2, "versión consolidada ≥ 2");
  assert.ok(merged.categories.length >= DEMO_CATEGORIES.length, "categorías se conservan");
});

test("seed: demoSyncCode determinista, cumple ID_RE del server y separa usuarios", () => {
  const ID_RE = /^[a-z0-9-]{16,64}$/i;
  const c1 = demoSyncCode("alice");
  const c2 = demoSyncCode("bob");
  assert.equal(c1, demoSyncCode("alice"), "determinista por username");
  assert.notEqual(c1, c2, "usuarios distintos → docs distintos");
  assert.match(c1, ID_RE, "válido como sync_code");
  assert.ok(c1.length >= 16 && c1.length <= 64);
  assert.equal(demoSyncCode("Alice"), demoSyncCode("alice"), "normaliza a minúsculas");
  assert.equal(demoSyncCode("  alice  "), demoSyncCode("alice"), "normaliza espacios");
});
