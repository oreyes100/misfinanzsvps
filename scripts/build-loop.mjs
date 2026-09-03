#!/usr/bin/env node
// build-loop.mjs — W30 Fase 3: toma el issue en "todo", invoca opencode headless
// en una branch aislada, corre tests, commitea y pasa a "review".
// Corre en el VPS (systemd timer cada 5 min). Uso: node scripts/build-loop.mjs [--dry]
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { nextIssueInState, updateIssue, buildPrompt, MAX_BUILD_ATTEMPTS } from "../server/hermes/issues.mjs";

// W30-mejora 4: modelo según complejidad del issue. Diagnostic → modelo más
// capaz (configurable con W30_MODEL_DIAGNOSTIC si se añade auth de otro
// proveedor al VPS); feature → el rápido/barato por defecto.
const MODEL_FEATURE = process.env.W30_MODEL_FEATURE || "opencode-go/glm-5.3-flash";
const MODEL_DIAGNOSTIC = process.env.W30_MODEL_DIAGNOSTIC || process.env.W30_MODEL_FEATURE || "opencode-go/glm-5.3-flash";
import { notify } from "../server/hermes/notifications.mjs";

const REPO = "/home/devops/mis-finanzas";
const DRY = process.argv.includes("--dry");
const log = (m, extra) => console.log(`[build-loop] ${new Date().toISOString()} ${m}${extra ? " " + JSON.stringify(extra) : ""}`);
const run = (cmd, opts = {}) =>
  execSync(cmd, { cwd: REPO, encoding: "utf8", timeout: opts.timeout || 20 * 60_000, stdio: opts.quiet ? "pipe" : ["ignore", "pipe", "pipe"] });

async function main() {
  const issue = nextIssueInState("todo");
  if (!issue) { log("sin issues en todo"); process.exit(0); }
  log(`INICIO ${issue.id}: ${issue.title}`);
  updateIssue(issue.id, { state: "in_progress", buildAttempts: issue.buildAttempts + 1 });
  await notify(`🔨 Build loop: ${issue.id} — ${issue.title} (intento ${issue.buildAttempts + 1}/${MAX_BUILD_ATTEMPTS})`);

  if (DRY) { log("dry: sin agente"); updateIssue(issue.id, { state: "needs_human" }); process.exit(0); }

  try {
    // repo limpio + branch aislada desde origin/main
    run("git add -A && git stash -q 2>/dev/null || true", { quiet: true });
    run("git fetch origin -q && git checkout main -q && git reset --hard origin/main -q", { quiet: true });
    run(`git checkout -B "${issue.branch}" origin/main`, { quiet: true });

    // prompt a archivo (evita problemas de quoting con backticks/$ en checks)
    const promptFile = path.join(os.tmpdir(), `w30-prompt-${issue.id}.txt`);
    fs.writeFileSync(promptFile, buildPrompt(issue));

    const model = issue.complexity === "diagnostic" ? MODEL_DIAGNOSTIC : MODEL_FEATURE;
    log("agente opencode headless iniciando…", { model, complexity: issue.complexity || "feature" });
    let agentOut = "";
    try {
      agentOut = run(`"$HOME/.npm-global/bin/opencode" run --model ${model} "$(cat ${promptFile})"`, { timeout: 30 * 60_000, quiet: true });
    } finally {
      fs.unlinkSync(promptFile);
      if (agentOut) fs.writeFileSync(path.join(os.tmpdir(), `w30-agent-${issue.id}.log`), String(agentOut).slice(-4000));
    }

    // tests reales (exit code, no parsing)
    let testsOk = true;
    try { run("npm test -- --run", { quiet: true, timeout: 12 * 60_000 }); }
    catch { testsOk = false; }

    // cambios: el agente puede commitear él mismo → comparar HEAD vs origin/main
    const head = run("git rev-parse HEAD", { quiet: true }).trim();
    const base = run("git rev-parse origin/main", { quiet: true }).trim();
    const status = run("git status --porcelain", { quiet: true });
    if (head === base && !status.trim()) {
      updateIssue(issue.id, { state: "needs_fix", lastError: "agente sin cambios" });
      await notify(`⚠️ ${issue.id}: el agente no produjo cambios → needs_fix`);
      run("git checkout main -q", { quiet: true });
      process.exit(0);
    }
    if (status.trim()) {
      run(`git add -A && git commit -q -m "feat(${issue.id}): ${issue.title.replace(/["`]/g, "'")}"`, { quiet: true });
    }
    run(`git push -q --force-with-lease -u origin "${issue.branch}"`, { quiet: true, timeout: 120_000 });

    if (!testsOk) {
      updateIssue(issue.id, { state: "review", lastError: "tests rojos en build — review decidirá" });
      await notify(`👀 ${issue.id} a REVIEW (branch ${issue.branch}) — ⚠️ tests rojos en build, review decidirá`);
    } else {
      updateIssue(issue.id, { state: "review", lastCommit: run("git rev-parse --short HEAD", { quiet: true }).trim() });
      await notify(`👀 ${issue.id} implementado con tests verdes → REVIEW (branch ${issue.branch})`);
    }
    log("FIN: review", { branch: issue.branch });
    run("git checkout main -q", { quiet: true });
  } catch (e) {
    log(`ERROR: ${e?.message || e}`);
    const agentTail = (() => { try { return fs.readFileSync(path.join(os.tmpdir(), `w30-agent-${issue.id}.log`), "utf8").slice(-600); } catch { return ""; } })();
    try { run("git checkout main -q && git reset --hard origin/main -q", { quiet: true }); } catch {}
    const cur = updateIssue(issue.id, { state: "todo", lastError: String(e?.message || e).slice(0, 200) });
    // W30-mejora 3: 2 fallos del MISMO issue → needs_human con resumen ejecutivo
    if (cur.buildAttempts >= MAX_BUILD_ATTEMPTS) {
      updateIssue(issue.id, {
        state: "needs_human",
        lastError: String(e?.message || e).slice(0, 200),
        lastAgentOutput: agentTail,
      });
      await notify(
        `🧍 ${issue.id} requiere humano.\n` +
        `• Intentos fallidos: ${cur.buildAttempts}\n` +
        `• Último error: ${String(e?.message || e).slice(0, 150)}\n` +
        `• Complejidad: ${issue.complexity || "feature"}\n` +
        (agentTail ? `• Cola del agente: ${agentTail.slice(-200).replace(/\n/g, " | ")}\n` : "") +
        `• Sugerencia: revisa el contexto del issue (${issue.acceptanceCriteria?.map(a => a.desc).join("; ") || issue.title}) y ejecuta /resume ${issue.id} cuando lo resuelvas.`
      );
    } else {
      await notify(`↩️ ${issue.id}: build falló, reintento programado (${cur.buildAttempts}/${MAX_BUILD_ATTEMPTS})`);
    }
    process.exit(1);
  }
}

main().catch((e) => { console.error("[build-loop] fatal:", e); process.exit(1); });
