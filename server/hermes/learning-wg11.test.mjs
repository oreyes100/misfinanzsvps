// learning-wg11.test.mjs — Tests de la lectura del aprendizaje persistido
// (WG11 Fase 3). Se ejecuta con: node --test server/hermes/learning-wg11.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { categoryFromMap, transferRuleFor } from "./learning.mjs";

test("categoryFromMap: merchant exacto normalizado", () => {
  const cfg = { merchantCategoryMap: { "bodega expres": "Comida", "banorte digital mia": "Deuda" } };
  assert.equal(categoryFromMap(cfg, "Bodega Exprés", null), "Comida");
  assert.equal(categoryFromMap(cfg, "BODEGA EXPRES S.A.", null), "Comida");
});

test("categoryFromMap: match por substring en la descripción", () => {
  const cfg = { merchantCategoryMap: { "farm guadalajara": "Salud" } };
  assert.equal(categoryFromMap(cfg, "Farmacias Guadalajara", "Farm Guadalajara - SAN CRISTOBAL"), "Salud");
});

test("categoryFromMap: sin match devuelve null (fallback a keywords)", () => {
  const cfg = { merchantCategoryMap: { x: "Y" } };
  assert.equal(categoryFromMap(cfg, "Oxxo", null), null);
  assert.equal(categoryFromMap(cfg, null, null), null);
  assert.equal(categoryFromMap(cfg, "", ""), null);
});

test("transferRuleFor: par exacto normalizado en ambos órdenes", () => {
  const cfg = { transferRules: { "obmio|banorte": { fromId: "a1", toId: "a2" } } };
  assert.deepEqual(transferRuleFor(cfg, "OBMIO", "Banorte Digital mía"), { fromId: "a1", toId: "a2" });
  assert.deepEqual(transferRuleFor(cfg, "banorte digital mia", "obmio"), { fromId: "a1", toId: "a2" });
});

test("transferRuleFor: regla con una punta comodín ('' coincide con cualquiera)", () => {
  const cfg = { transferRules: { "|banorte": { toId: "a2" } } };
  assert.deepEqual(transferRuleFor(cfg, "xxxx8298", "Banorte Digital mía"), { toId: "a2" });
});

test("transferRuleFor: sin match devuelve null", () => {
  const cfg = { transferRules: { "obmio|banorte": { fromId: "a1", toId: "a2" } } };
  assert.equal(transferRuleFor(cfg, "otra cosa", "nada"), null);
  assert.equal(transferRuleFor(cfg, null, null), null);
});