// issues.test.mjs — W30 Fase 1: tracker de issues + máquina de estados.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STATES, loadIssues, createIssue, getIssue, nextIssueInState, updateIssue, buildPrompt } from "./issues.mjs";

function tmpPath() {
  return path.join(os.tmpdir(), `w30-issues-${Math.random().toString(36).slice(2)}.json`);
}

test("createIssue genera IDs atómicos por wargame y estado inicial todo", () => {
  const p = tmpPath();
  const a = createIssue({ wargame: 31, title: "endpoint CSV", acceptanceCriteria: [{ desc: "curl ok", check: "curl -s localhost:3000/api/export/csv | head -1" }] }, p);
  const b = createIssue({ wargame: 31, title: "botón export" }, p);
  assert.equal(a.id, "w31-i1");
  assert.equal(b.id, "w31-i2");
  assert.equal(a.state, "todo");
  assert.equal(nextIssueInState("todo", p).id, "w31-i1");
  fs.unlinkSync(p);
});

test("máquina de estados: todo → in_progress → review → ready_to_merge → done", () => {
  const p = tmpPath();
  const { id } = createIssue({ wargame: 30, title: "test flujo" }, p);
  updateIssue(id, { state: "in_progress", buildAttempts: 1 }, p);
  updateIssue(id, { state: "review" }, p);
  updateIssue(id, { state: "ready_to_merge" }, p);
  updateIssue(id, { state: "done" }, p);
  assert.equal(getIssue(id, p).state, "done");
  fs.unlinkSync(p);
});

test("transiciones inválidas lanzan error (todo → done prohibido)", () => {
  const p = tmpPath();
  const { id } = createIssue({ wargame: 30, title: "x" }, p);
  assert.throws(() => updateIssue(id, { state: "done" }, p), /transición inválida/);
  fs.unlinkSync(p);
});

test("needs_human existe como salida; desde ahí se puede volver a todo", () => {
  const p = tmpPath();
  const { id } = createIssue({ wargame: 30, title: "x" }, p);
  updateIssue(id, { state: "needs_human" }, p);
  assert.equal(getIssue(id, p).state, "needs_human");
  updateIssue(id, { state: "todo" }, p);
  assert.equal(getIssue(id, p).state, "todo");
  fs.unlinkSync(p);
});

test("buildPrompt incluye título, AC con checks y non-goals", () => {
  const prompt = buildPrompt({
    id: "w31-i1", title: "endpoint CSV",
    acceptanceCriteria: [{ desc: "CSV con headers", check: "curl -s x | head -1" }],
    nonGoals: ["no tocar auth"],
  });
  assert.match(prompt, /w31-i1/);
  assert.match(prompt, /endpoint CSV/);
  assert.match(prompt, /curl -s x \| head -1/);
  assert.match(prompt, /no tocar auth/);
});

test("STATES completos", () => {
  assert.deepEqual(STATES, ["todo", "in_progress", "review", "ready_to_merge", "done", "needs_fix", "needs_human"]);
});
