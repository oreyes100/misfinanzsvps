// wargameApi.mjs — W34: única puerta HTTP del loop (/api/wargame/*).
// Principio "un solo escritor" (W23/W25): el ESTADO de issues vive en issues.mjs
// y SOLO se muta vía sus funciones (createIssue/updateIssue — la máquina de
// estados valida cada transición). Esta API no duplica lógica: expone la misma
// semántica que usa el bot de Telegram, y extra.js reutiliza los guards de aquí.
// El bot corre DENTRO del proceso del server (extra.js), así que muta vía los
// mismos módulos — sin HTTP self-call. Escritores externos (CLI/OpenCode) pasan
// por los handlers HTTP con auth W1 (checkLearnAuth).
import { loadIssues, createIssue, updateIssue, getIssue, ISSUES_PATH } from "./issues.mjs";
import { normalizeComplexity, generateIssues } from "./spec-skill.mjs";
import { checkLearnAuth } from "../auth.mjs";

const json = (res, status, payload) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
};

// ---------- Helpers puros (testeables) ----------

/** Conteo de issues por estado. */
export function wargameStatus(issues) {
  const byState = {};
  for (const i of issues || []) byState[i.state] = (byState[i.state] || 0) + 1;
  return { total: (issues || []).length, byState };
}

/** Validación de entrada del spec no interactivo (idea + 7 respuestas). */
export function validateSpecInput(input) {
  const { idea, answers } = input || {};
  if (!idea || typeof idea !== "string" || !idea.trim()) return { ok: false, error: "idea requerida" };
  if (!Array.isArray(answers) || answers.length < 7) return { ok: false, error: "idea + 7 respuestas requeridas" };
  if (answers.some((a) => typeof a !== "string")) return { ok: false, error: "las respuestas deben ser strings" };
  const wargame = Number(input.wargame);
  if (!Number.isInteger(wargame) || wargame <= 0 || wargame > 999) return { ok: false, error: "wargame debe ser un número entero 1-999" };
  return { ok: true };
}

/**
 * Guard de resume compartido (bot + API): SOLO issues needs_human vuelven a todo.
 * Devuelve el issue actualizado o null con motivo.
 */
export function resumeIssue(id, p = ISSUES_PATH) {
  const issue = getIssue(id, p);
  if (!issue) return { ok: false, error: `⚠️ ${id || "nada"} no existe` };
  if (issue.state !== "needs_human") return { ok: false, error: `⚠️ ${issue.id} no está needs_human (está ${issue.state})` };
  const updated = updateIssue(issue.id, { state: "todo", buildAttempts: 0, reviewAttempts: 0, lastError: null }, p);
  return { ok: true, issue: updated };
}

/**
 * Creación de issues desde un spec completo (compartido por bot y API).
 * Reusa normalizeComplexity (fix W33: tolerante a typos como "feuture").
 */
export async function createIssuesFromSpec({ idea, answers, wargame }, p = ISSUES_PATH) {
  const v = validateSpecInput({ idea, answers, wargame });
  if (!v.ok) throw new Error(v.error);
  const complexity = normalizeComplexity(answers[6]);
  const generated = await generateIssues(idea, answers, wargame, complexity);
  const created = generated.map((iss) => createIssue({ wargame, complexity, ...iss }, p));
  return created;
}

// ---------- Handlers HTTP (estilo raw del server) ----------

/** GET /api/wargame/status — público (como /api/health). */
export async function handleWargameStatus(req, res) {
  const { total, byState } = wargameStatus(loadIssues().issues);
  json(res, 200, { ok: true, total, byState });
}

/** GET /api/wargame/issues — público (solo lectura). */
export async function handleWargameIssues(req, res) {
  json(res, 200, { ok: true, issues: loadIssues().issues });
}

/** POST /api/wargame/spec — auth W1 (checkLearnAuth): genera issues vía LLM. */
export async function handleWargameSpec(req, res) {
  const auth = checkLearnAuth(req);
  if (!auth.ok) return json(res, auth.status, { ok: false, error: auth.error });
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return json(res, e.message === "too_large" ? 413 : 400, { ok: false, error: e.message === "too_large" ? "Cuerpo demasiado grande." : "JSON inválido." });
  }
  const v = validateSpecInput(body);
  if (!v.ok) return json(res, 400, { ok: false, error: v.error });
  try {
    const created = await createIssuesFromSpec(body);
    return json(res, 200, { ok: true, ids: created.map((i) => i.id) });
  } catch (e) {
    return json(res, 502, { ok: false, error: String(e?.message || e).slice(0, 200) });
  }
}

/** POST /api/wargame/resume — auth W1: solo issues needs_human. */
export async function handleWargameResume(req, res) {
  const auth = checkLearnAuth(req);
  if (!auth.ok) return json(res, auth.status, { ok: false, error: auth.error });
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return json(res, e.message === "too_large" ? 413 : 400, { ok: false, error: e.message === "too_large" ? "Cuerpo demasiado grande." : "JSON inválido." });
  }
  const result = resumeIssue(String(body?.id || ""));
  return json(res, result.ok ? 200 : 409, { ok: result.ok, ...(result.ok ? { issue: { id: result.issue.id, state: result.issue.state } } : { error: result.error }) });
}

async function readJsonBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("too_large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch {
        reject(new Error("bad_json"));
      }
    });
    req.on("error", (e) => reject(e));
  });
}
