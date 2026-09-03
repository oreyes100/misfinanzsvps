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

    log("agente opencode headless iniciando…");
    run(`"$HOME/.npm-global/bin/opencode" run --model opencode-go/glm-5.3-flash "$(cat ${promptFile})"`, { timeout: 30 * 60_000 });
    fs.unlinkSync(promptFile);

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
    try { run("git checkout main -q && git reset --hard origin/main -q", { quiet: true }); } catch {}
    const cur = updateIssue(issue.id, { state: "todo", lastError: String(e?.message || e).slice(0, 200) });
    if (cur.buildAttempts >= MAX_BUILD_ATTEMPTS) {
      updateIssue(issue.id, { state: "needs_human" });
      await notify(`🧍 ${issue.id}: ${MAX_BUILD_ATTEMPTS} builds fallaron → necesita humano (${String(e?.message || e).slice(0, 120)})`);
    } else {
      await notify(`↩️ ${issue.id}: build falló, reintento programado (${cur.buildAttempts}/${MAX_BUILD_ATTEMPTS})`);
    }
    process.exit(1);
  }
}

main().catch((e) => { console.error("[build-loop] fatal:", e); process.exit(1); });
