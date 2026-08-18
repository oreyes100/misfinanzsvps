// categoryGuard.test.mjs — Tests de categoryGuard.mjs (Operación NULL HUNTER).
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCategory, ensureCategory } from "./categoryGuard.mjs";

test("resolveCategory: keyword hit", () => {
  const r = resolveCategory("AMAZON - CIUDAD DE MEX0");
  assert.equal(r.category, "Compras");
  assert.equal(r.source, "keywords");
  assert.ok(r.confidence > 0.3);
});

test("resolveCategory: gasolinera -> Transporte", () => {
  const r = resolveCategory("GASOL EL FENIX - LAZARO CARD");
  assert.equal(r.category, "Transporte");
});

test("resolveCategory: farmacia -> Salud", () => {
  const r = resolveCategory("FARM GUADALAJARA 161 MORELIA");
  assert.equal(r.category, "Salud");
});

test("resolveCategory: abarrotes -> Supermercado", () => {
  const r = resolveCategory("ABARROTES AZTECA 4 MORELIA");
  assert.equal(r.category, "Supermercado");
});

test("resolveCategory: descripción desconocida -> fallback Otros", () => {
  const r = resolveCategory("PAGO BIZUM JUAN CARLOS");
  assert.equal(r.category, "Otros");
  assert.equal(r.source, "fallback");
  assert.equal(r.confidence, 0.3);
});

test("ensureCategory: categoría provista se mantiene", () => {
  const g = ensureCategory({ category: "Comida", description: "Dominos" });
  assert.equal(g.category, "Comida");
  assert.equal(g.source, undefined);
  assert.equal(g.needsCategoryReview, false);
});

test("ensureCategory: null -> resuelve por keywords", () => {
  const g = ensureCategory({ category: null, description: "STR*AMAZON - CIUDAD DE MEX0" });
  assert.equal(g.category, "Compras");
  assert.equal(g.needsCategoryReview, false);
  assert.equal(g.categorySource, "keywords");
});

test("ensureCategory: fallback marca needsCategoryReview", () => {
  const g = ensureCategory({ category: null, description: "MOVIMIENTO X" });
  assert.equal(g.category, "Otros");
  assert.equal(g.needsCategoryReview, true);
  assert.equal(g.categorySource, "fallback");
});

test("ensureCategory: string 'null' tratado como ausente", () => {
  const g = ensureCategory({ category: "null", description: "GASOL EL FENIX" });
  assert.equal(g.category, "Transporte");
});