// spec-skill.mjs — W30 Fase 2: comando /spec del bot → entrevista de 6 preguntas
// → genera issues atómicos con AC verificable (vía LLM del orchestrator).
import { createIssue, loadIssues, ISSUES_PATH } from "./issues.mjs";
import { callOrchestrator } from "./aiClient.mjs";
export const QUESTIONS = [
  "¿Qué problema específico resuelve? (1 frase)",
  "¿Qué NO debe hacer? (non-goals, separados por coma)",
  "¿Qué wargames/módulos previos reutiliza?",
  "¿Qué endpoints o archivos tocará?",
  "¿Cómo se verifica el éxito? (comandos curl/test, uno por línea)",
  "¿Qué puede fallar? (edge cases, separados por coma)",
  "¿Es un bug diagnóstico (requiere entender código existente) o una feature nueva?",
];

// Entrevistas activas en memoria (proceso server persistente).
const interviews = new Map(); // chatId → { idea, answers[], wargame }

export function isInterviewActive(chatId) {
  return interviews.has(String(chatId));
}

function nextWargameNumber() {
  const data = loadIssues(ISSUES_PATH);
  const max = data.issues.reduce((m, i) => Math.max(m, Number(i.wargame) || 0), 30);
  return max + 1;
}

/** Inicia la entrevista con la idea tras /spec. Responde con la pregunta 1. */
export function startSpec(chatId, text) {
  const idea = String(text || "").replace(/^\/spec\b/i, "").trim();
  if (!idea || /^cancel/i.test(idea)) {
    interviews.delete(String(chatId));
    return idea ? "Entrevista cancelada." : "🎯 Uso: /spec <idea>. Ej: /spec Quiero exportar transacciones a CSV";
  }
  const wargameMatch = idea.match(/\bw(\d{1,3})\b/);
  const wargame = wargameMatch ? Number(wargameMatch[1]) : nextWargameNumber();
  interviews.set(String(chatId), { idea: idea.replace(/\bw(\d{1,3})\b/, "").trim(), answers: [], wargame, startedAt: Date.now() });
  return `🎯 Idea recibida (wargame w${wargame}): "${idea}"\n\nPregunta 1/${QUESTIONS.length}: ${QUESTIONS[0]}`;
}

/** Procesa la respuesta N del usuario. Devuelve el texto a enviar (o null si no hay entrevista). */
export async function handleInterviewAnswer(chatId, answer) {
  const key = String(chatId);
  const s = interviews.get(key);
  if (!s) return null;
  s.answers.push(String(answer || "").trim());
  if (s.answers.length < QUESTIONS.length) {
    return `Pregunta ${s.answers.length + 1}/${QUESTIONS.length}: ${QUESTIONS[s.answers.length]}`;
  }
  interviews.delete(key);
  let issues;
  try {
    issues = await generateIssues(s.idea, s.answers, s.wargame);
  } catch (e) {
    return `❌ No pude generar los issues (${String(e?.message || e).slice(0, 120)}). Intenta de nuevo con /spec.`;
  }
  const created = issues.map((iss) => createIssue({ wargame: s.wargame, complexity, ...iss }));
  return `✅ Spec completado: ${created.length} issues creados (${created.map((i) => i.id).join(", ")}).\n🔨 El build loop los tomará en ≤5 min. Te avisaré en cada paso.`;
}

/** Llama al LLM (Hermes orchestrator /api/hermes/ai/text) para generar issues atómicos. */
export async function generateIssues(idea, answers, wargame) {
  const prompt = `Genera issues atómicos para implementar esta mejora en el proyecto Mis Finanzas
(React+Vite frontend en src/, servidor Node ESM en server/, tests con vitest (src/**) y node:test (server/**)).

IDEA: ${idea}
RESPUESTAS DEL USUARIO:
${QUESTIONS.map((q, i) => `${i + 1}. ${q}\n   → ${answers[i]}`).join("\n")}

TIPO: ${complexity === "diagnostic" ? "BUG DIAGNÓSTICO — los issues deben pedir investigar la causa raíz antes de codificar" : "FEATURE NUEVA"}

Devuelve SOLO un JSON válido (sin texto extra) con esta forma exacta:
{"issues":[{"title":"...","context":"instrucciones para el agente de código: archivos a tocar, patrón a seguir","acceptanceCriteria":[{"desc":"...","check":"comando shell verificable (npm test ..., curl -s ..., grep ...)"}],"nonGoals":["..."]}]}

Reglas: 1-5 issues máximo, cada uno implementable en una sesión corta, cada acceptanceCriteria.check debe ser un comando REAL ejecutable en el VPS (localhost:3000), sin credenciales.`;

  const cfg = { serverUrl: process.env.HERMES_SERVER_URL || "http://127.0.0.1:3000" };
  const res = await callOrchestrator(cfg, "text", { prompt }, { timeoutMs: 90_000 });
  const parsed = res?.result;
  const list = Array.isArray(parsed?.issues) ? parsed.issues : [];
  if (!list.length) throw new Error("el LLM no devolvió issues válidos");
  return list.map((i) => ({
    title: String(i.title || "sin título").slice(0, 120),
    context: String(i.context || ""),
    acceptanceCriteria: (i.acceptanceCriteria || []).map((a) => ({ desc: String(a.desc || ""), check: String(a.check || "") })),
    nonGoals: Array.isArray(i.nonGoals) ? i.nonGoals.map(String) : [],
  }));
}

