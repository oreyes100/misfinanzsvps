// merge-skill.mjs — W30 Fase 5: merge por gesto (🚀 / callback "mg:").
// Merge --no-ff de la branch del issue + tests post-merge (revert si rojos)
// + build + deploy VPS + push main + estado done. Corre en el server (extra.js).
import { execSync } from "node:child_process";
import { getIssue, updateIssue } from "./issues.mjs";
import { notify } from "./notifications.mjs";

const REPO = "/home/devops/mis-finanzas";
const run = (cmd, opts = {}) =>
  execSync(cmd, { cwd: REPO, encoding: "utf8", timeout: opts.timeout || 12 * 60_000, stdio: opts.quiet ? "pipe" : ["ignore", "pipe", "pipe"] });

/**
 * Ejecuta el merge + deploy del issue ready_to_merge. Devuelve texto del resultado.
 * Solo permite UN merge a la vez (flag en memoria).
 */
let merging = false;
export async function handleMerge(issueId) {
  const issue = issueId ? getIssue(issueId) : null;
  if (!issue) return `⚠️ ${issueId || "nada"} no existe`;
  // W30-fix: idempotencia — si la branch ya está mergeada a main, marcar done y salir.
  try {
    run(`git merge-base --is-ancestor "${issue.branch}" main`, { quiet: true });
    if (issue.state !== "done") updateIssue(issue.id, { state: "done" });
    return `ℹ️ ${issue.id} ya estaba mergeado y desplegado`;
  } catch { /* no mergeado aún: continuar */ }
  if (issue.state !== "ready_to_merge") {
    return `⚠️ ${issue.id} no está ready_to_merge (está ${issue.state})`;
  }
  if (merging) return "⏳ Ya hay un merge en curso";
  merging = true;
  const log = (m) => console.log(`[merge] ${new Date().toISOString()} ${issue.id}: ${m}`);
  try {
    log("inicio");
    run("git checkout main -q && git reset --hard origin/main -q", { quiet: true });
    run(`git merge --no-ff "${issue.branch}" -m "merge(${issue.id}): ${issue.title.replace(/["`]/g, "'")}"`, { quiet: true });

    // tests post-merge: si rojos → revert automático
    try {
      run("npm test -- --run", { quiet: true, timeout: 12 * 60_000 });
    } catch (e) {
      log("tests rojos tras merge → REVERT");
      run("git merge --abort -q 2>/dev/null || true; git reset --hard origin/main -q", { quiet: true });
      updateIssue(issue.id, { state: "needs_fix", lastError: "tests rojos en merge → revert automático" });
      await notify(`❌ ${issue.id}: tests rojos tras merge → REVERT automático. Vuelve a build.`);
      return `❌ ${issue.id}: tests rojos tras el merge → revertido automáticamente`;
    }

    // W30-fix: push de main con reintentos anti-carrera (si otro escritor —
    // la Mac del humano — empujó durante el merge, re-integrar y reintentar)
    let pushed = false;
    for (let attempt = 1; attempt <= 3 && !pushed; attempt++) {
      try {
        run("git push -q origin main", { quiet: true, timeout: 120_000 });
        pushed = true;
      } catch (e) {
        const blob = String(e.stdout || "") + String(e.message || "");
        if (!/fetch first|rejected|non-fast-forward/i.test(blob)) throw e;
        log(`push rechazado (intento ${attempt}/3) → re-integrando origin/main`);
        run("git fetch origin -q && git pull --no-rebase -q origin main", { quiet: true, timeout: 60_000 });
      }
    }
    if (!pushed) throw new Error("push de main rechazado tras 3 intentos");

    // build + deploy VPS
    run("npm run build", { quiet: true, timeout: 5 * 60_000 });
    run("sudo rm -rf /var/www/misfinanzas/assets && sudo cp -r dist/. /var/www/misfinanzas/ && sudo chown -R www-data:www-data /var/www/misfinanzas", { timeout: 120_000 });
    // W30-fix: NO reiniciar el server desde dentro del server (se suicide a sí
    // mismo → 502 y sin confirmación). Si el merge tocó server/**, programar el
    // restart DESACOPLADO; si solo tocó frontend, no hace falta.
    const serverFiles = run(`git diff --name-only origin/main@{1} origin/main -- server/ 2>/dev/null || true`, { quiet: true });
    if (serverFiles.trim()) {
      run("nohup sudo systemctl restart misfinanzas-server.service >/dev/null 2>&1 &", { quiet: true, timeout: 10_000 });
      await new Promise((r) => setTimeout(r, 3000));
    }

    updateIssue(issue.id, { state: "done" });
    run(`git branch -d "${issue.branch}" -q 2>/dev/null || true; git push -q origin --delete "${issue.branch}" 2>/dev/null || true`, { quiet: true });
    await notify(`🎉 ${issue.id} MERGEADO + desplegado en el VPS (${issue.title})`);
    log("done");
    return `🎉 ${issue.id} mergeado, tests verdes y desplegado (${issue.title})`;
  } catch (e) {
    try { run("git merge --abort -q 2>/dev/null || true; git reset --hard origin/main -q", { quiet: true }); } catch {}
    log(`ERROR: ${e?.message || e}`);
    await notify(`❌ ${issue.id}: error en merge/deploy → ${String(e?.message || e).slice(0, 120)}`);
    return `❌ ${issue.id}: error — ${String(e?.message || e).slice(0, 150)}`;
  } finally {
    merging = false;
  }
}
