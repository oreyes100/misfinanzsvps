// spec-skill.test.mjs — W33: normalizador de complejidad tolerante a typos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeComplexity } from "./spec-skill.mjs";

test("typos comunes de 'feature' → feature", () => {
  assert.equal(normalizeComplexity("feuture nueva"), "feature");
  assert.equal(normalizeComplexity("Feture"), "feature");
  assert.equal(normalizeComplexity("feat nueva"), "feature");
  assert.equal(normalizeComplexity("una feature nueva"), "feature");
});

test("bug/diagnóstico → diagnostic", () => {
  assert.equal(normalizeComplexity("bug diagnóstico"), "diagnostic");
  assert.equal(normalizeComplexity("Diag"), "diagnostic");
  assert.equal(normalizeComplexity("es un fix de un error"), "diagnostic");
});

test("respuestas vagas o vacías → feature (default seguro)", () => {
  assert.equal(normalizeComplexity("no lo se"), "feature");
  assert.equal(normalizeComplexity(""), "feature");
  assert.equal(normalizeComplexity(undefined), "feature");
  assert.equal(normalizeComplexity(null), "feature");
  assert.equal(normalizeComplexity("cualquier cosa"), "feature");
});

test("nunca lanza con entrada rara", () => {
  assert.equal(normalizeComplexity(123), "feature");
  assert.equal(normalizeComplexity({}), "feature");
});
