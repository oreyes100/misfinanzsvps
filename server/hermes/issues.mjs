// issues.mjs — W30: tracker de issues + máquina de estados del loop autoconstructivo.
// Estados: todo → in_progress → review → ready_to_merge → done (+ needs_fix, needs_human).
// Path inyectable para tests. En producción: server/data/wargame_issues.json.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ISSUES_PATH = path.join(HERE, "../data/wargame_issues.json");

export const STATES = ["todo", "in_progress", "review", "ready_to_merge", "done", "needs_fix", "needs_human"];
export const MAX_BUILD_ATTEMPTS = 3;

export function loadIssues(p = ISSUES_PATH) {
  try {
    if (!fs.existsSync(p)) return { issues: [] };
    const data = JSON.parse(fs.readFileSync(p, "utf8"));
    return Array.isArray(data?.issues) ? data : { issues: [] };
  } catch {
    return { issues: [] };
  }
}

export function saveIssues(data, p = ISSUES_PATH) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

export function createIssue({ wargame, title, acceptanceCriteria = [], nonGoals = [], context = "" }, p = ISSUES_PATH) {
  const data = loadIssues(p);
  const id = `w${wargame}-i${data.issues.filter((i) => i.wargame === wargame).length + 1}`;
  const issue = {
    id, wargame, title,
    state: "todo",
    acceptanceCriteria, // [{desc, check}] — check = comando shell verificable
    nonGoals, context,
    buildAttempts: 0, reviewAttempts: 0,
    branch: `wargame-${wargame}/${id}`,
    createdAt: Date.now(), lastAction: Date.now(),
  };
  data.issues.push(issue);
  saveIssues(data, p);
  return issue;
}

export function getIssue(id, p = ISSUES_PATH) {
  return loadIssues(p).issues.find((i) => i.id === id) || null;
}

export function nextIssueInState(state, p = ISSUES_PATH) {
  return loadIssues(p).issues.find((i) => i.state === state) || null;
}

export function updateIssue(id, patch, p = ISSUES_PATH) {
  const data = loadIssues(p);
  const issue = data.issues.find((i) => i.id === id);
  if (!issue) return null;
  // transiciones válidas (máquina de estados); done es terminal, needs_* pueden volver
  const TRANSITIONS = {
    todo: ["in_progress", "needs_human"],
    in_progress: ["review", "needs_fix", "needs_human", "todo"],
    review: ["ready_to_merge", "todo", "needs_fix", "needs_human"],
    ready_to_merge: ["done", "needs_fix"],
    needs_fix: ["todo", "in_progress", "review"],
    needs_human: ["todo", "in_progress"],
    done: [],
  };
  if (patch.state && !TRANSITIONS[issue.state]?.includes(patch.state)) {
    throw new Error(`transición inválida: ${issue.state} → ${patch.state}`);
  }
  Object.assign(issue, patch, { lastAction: Date.now() });
  saveIssues(data, p);
  return issue;
}

/** Prompt para el agente de código (opencode headless) — SPEC completo del issue. */
export function buildPrompt(issue) {
  const ac = (issue.acceptanceCriteria || []).map((a) => `- ${a.desc}\n  Verificación: \`${a.check}\``).join("\n");
  return `Implementa el issue ${issue.id} del proyecto Mis Finanzas (React+Vite frontend en src/, servidor Node ESM en server/).

TÍTULO: ${issue.title}

CRITERIOS DE ACEPTACIÓN (todos deben pasar):
${ac || "- (ninguno definido: implementa lo descrito en el título)"}
${issue.context ? `\nCONTEXTO:\n${issue.context}` : ""}
NO HACER (non-goals): ${(issue.nonGoals || []).join("; ") || "(ninguno)"}

REGLAS:
1. Escribe/actualiza tests para lo que implementes (vitest para src/**, node:test para server/**).
2. NO toques server/data/** ni credenciales.
3. Ejecuta la suite ANTES de terminar: npm test (debe estar verde).
4. Commitea con mensaje: feat(${issue.id}): ${issue.title}
5. NO hagas merge ni push a main. Solo commit en la branch actual.`;
}
