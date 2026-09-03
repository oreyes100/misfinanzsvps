#!/usr/bin/env node
// review-loop.mjs — W30 Fase 4: verifica issues en "review".
// 1) checkout de la branch + suite completa 2) ejecuta los AC checks del issue.
// Verde → ready_to_merge (notify 🚀). Rojo → todo (reintento) o needs_human (≥3).
// Corre en el VPS (systemd timer cada 5 min).
import { execSync } from "node:child_process";
import process from "node:process";
import { nextIssueInState, updateIssue, MAX_BUILD_ATTEMPTS } from "../server/hermes/issues.mjs";
import { notify } from "../server/hermes/notifications.mjs";
import { sendMessage, inlineKeyboard } from "../lib/telegram.js";
import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "../server/db.mjs";

/** Envía el mensaje de merge-ready con botón 🚀 (al binding habilitado). */
async function notifyReady(text, issueId) {
  try {
    const dir = path.join(DATA_DIR, "blobs", "telegram", "bindings");
    for (const f of fs.readdirSync(dir)) {
      const b = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      if (b.enabled && b.botToken) {
        await sendMessage(b.botToken, b.chatId, text, { reply_markup: inlineKeyboard([[{ text: `🚀 Mergear ${issueId}`, data: `mg:${issueId}` }]]) });
      }
    }
  } catch (e) {
    console.error("[review-loop] botón 🚀 falló:", e?.message || e);
  }
}

const REPO = "/home/devops/mis-finanzas";
const log = (m, extra) => console.log(`[review-loop] ${new Date().toISOString()} ${m}${extra ? " " + JSON.stringify(extra) : ""}`);
const run = (cmd, opts = {}) =>
  execSync(cmd, { cwd: REPO, encoding: "utf8", timeout: opts.timeout || 12 * 60_000, stdio: opts.quiet ? "pipe" : ["ignore", "pipe", "pipe"] });

/** Ejecuta un AC check con allowlist de comandos seguros.
 *  W30-mejora 2: acepta asignaciones de env precedentes (VAR="x" VAR2="y" cmd …)
 *  validando el comando FINAL contra la allowlist (el && crudo queda prohibido). */
const ALLOWED_PATTERNS = [
  /^curl\s/, /^npx vitest/, /^npm (test|run)/, /^grep /, /^node -e /,
  /^node --check/, /^ls /, /^git diff/, /^wc /, /^head /, /^tail /,
];
function runCheck(check) {
  let c = String(check || "").trim();
  // strip de asignaciones de env iniciales: VAR="x" → comando final
  let m;
  while ((m = c.match(/^\w+=(?:"[^"]*"|'[^']*'|\S+)\s+/))) c = c.slice(m[0].length);
  if (!ALLOWED_PATTERNS.some((re) => re.test(c))) return { ok: false, out: `comando no permitido: ${c.slice(0, 80)}` };
  try {
    const out = run(c + " 2>&1", { quiet: true, timeout: 120_000 });
    return { ok: true, out: String(out).slice(0, 300) };
  } catch (e) {
    return { ok: false, out: String(e.stdout || e.message || e).slice(0, 300) };
  }
}

async function main() {
  const issue = nextIssueInState("review");
  if (!issue) { log("sin issues en review"); process.exit(0); }
  log(`REVIEW ${issue.id}: ${issue.title}`);
  updateIssue(issue.id, { reviewAttempts: issue.reviewAttempts + 1 });

  try {
    run(`git checkout main -q && git reset --hard origin/main -q`, { quiet: true });
    run(`git checkout "${issue.branch}" -q`, { quiet: true });
  } catch (e) {
    updateIssue(issue.id, { state: "needs_human", lastError: "branch no encontrada" });
    await notify(`🧍 ${issue.id}: branch ${issue.branch} no existe → humano`);
    process.exit(1);
  }

  // 1. suite completa
  let testsOk = true;
  try { run("npm test -- --run", { quiet: true, timeout: 12 * 60_000 }); }
  catch (e) { testsOk = false; log("tests rojos", { out: String(e.stdout || "").slice(-300) }); }

  // 2. acceptance criteria
  const acResults = (issue.acceptanceCriteria || []).map((ac) => ({ ...ac, ...runCheck(ac.check) }));
  const acOk = acResults.length > 0 && acResults.every((r) => r.ok);
  const allOk = testsOk && acOk;

  run("git checkout main -q", { quiet: true });

  if (allOk) {
    updateIssue(issue.id, { state: "ready_to_merge" });
    const detail = acResults.map((r) => `✅ ${r.desc}`).join("\n");
    const text = `✅ ${issue.id} VERDE — tests + ${acResults.length}/${acResults.length} AC\n${detail}\n🚀 Pulsa el botón para mergear y desplegar`;
    await notify(text);
    await notifyReady(text, issue.id);
    log(`VERDE → ready_to_merge`);
  } else {
    const failed = acResults.filter((r) => !r.ok).map((r) => `❌ ${r.desc}: ${r.out.slice(0, 80)}`).join("\n");
    if (issue.reviewAttempts >= MAX_BUILD_ATTEMPTS) {
      updateIssue(issue.id, { state: "needs_human", lastError: `review falló ${issue.reviewAttempts} veces` });
      await notify(`🧍 ${issue.id} → HUMANO tras ${issue.reviewAttempts} reviews fallidas\n${testsOk ? "" : "❌ tests rojos\n"}${failed}`);
    } else {
      updateIssue(issue.id, { state: "todo", lastError: failed.slice(0, 200) });
      await notify(`❌ ${issue.id} falló review (intento ${issue.reviewAttempts}/${MAX_BUILD_ATTEMPTS}) → vuelve a build\n${testsOk ? "" : "❌ tests rojos\n"}${failed}`);
    }
    process.exit(1);
  }
}

main().catch((e) => { console.error("[review-loop] fatal:", e?.message || e); process.exit(1); });
