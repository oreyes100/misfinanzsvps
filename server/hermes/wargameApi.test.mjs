// wargameApi.test.mjs — W34: API del loop omnipresente (helpers puros + resume guard con tracker temporal).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { wargameStatus, validateSpecInput, resumeIssue, createIssuesFromSpec } from "./wargameApi.mjs";
import { createIssue, updateIssue, loadIssues } from "./issues.mjs";

function tmpTracker() {
  return path.join(os.tmpdir(), `w34-tracker-${Math.random().toString(36).slice(2)}.json`);
}

const ISSUES_FIXTURE = [
  { id: "w31-i1", state: "done" },
  { id: "w31-i2", state: "review" },
  { id: "w32-i1", state: "todo" },
  { id: "w32-i2", state: "needs_human" },
];

test("wargameStatus: conteo por estado + total", () => {
  const { total, byState } = wargameStatus(ISSUES_FIXTURE);
  assert.equal(total, 4);
  assert.equal(byState.done, 1);
  assert.equal(byState.review, 1);
  assert.equal(byState.todo, 1);
  assert.equal(byState.needs_human, 1);
});

test("wargameStatus: tracker vacío → total 0", () => {
  const { total, byState } = wargameStatus([]);
  assert.equal(total, 0);
  assert.deepEqual(byState, {});
});

test("validateSpecInput: idea + 7 respuestas requeridas", () => {
  const good = { idea: "export CSV", answers: Array(7).fill("ok"), wargame: 35 };
  assert.equal(validateSpecInput(good).ok, true);
  assert.match(validateSpecInput({ answers: Array(7).fill("ok"), wargame: 35 }).error, /idea/);
  assert.match(validateSpecInput({ idea: "x", answers: Array(6).fill("ok"), wargame: 35 }).error, /7 respuestas/);
  assert.match(validateSpecInput({ idea: "x", answers: Array(7).fill("ok"), wargame: 0 }).error, /wargame/);
  assert.match(validateSpecInput({ idea: "x", answers: [1, 2, 3, 4, 5, 6, 7], wargame: 35 }).error, /strings/);
});

test("resumeIssue: SOLO needs_human vuelve a todo (guard compartido bot+API)", () => {
  const p = tmpTracker();
  const { id } = createIssue({ wargame: 34, title: "bug", acceptanceCriteria: [] }, p);
  // en todo → NO se puede resume
  const r1 = resumeIssue(id, p);
  assert.equal(r1.ok, false);
  assert.match(r1.error, /no está needs_human/);
  // needs_human → resume ok: resetea intentos
  updateIssue(id, { state: "in_progress", buildAttempts: 2 }, p);
  updateIssue(id, { state: "needs_human", lastError: "x" }, p);
  const r2 = resumeIssue(id, p);
  assert.equal(r2.ok, true);
  assert.equal(r2.issue.state, "todo");
  assert.equal(r2.issue.buildAttempts, 0);
  // id inexistente
  assert.match(resumeIssue("w99-i9", p).error, /no existe/);
  fs.unlinkSync(p);
});

test("createIssuesFromSpec: valida y lanza con input inválido (no muta tracker)", async () => {
  const p = tmpTracker();
  await assert.rejects(
    () => createIssuesFromSpec({ idea: "", answers: [], wargame: 34 }, p),
    /idea/
  );
  assert.equal(loadIssues(p).issues.length, 0);
  if (fs.existsSync(p)) fs.unlinkSync(p); // el rechazo NO muta → puede no existir
});
