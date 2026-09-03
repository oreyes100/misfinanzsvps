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
  if (!issue || issue.state !== "ready_to_merge") {
    return `⚠️ ${issueId || "nada"} no está ready_to_merge`;
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

    // push main
    run("git push -q origin main", { quiet: true, timeout: 120_000 });

    // build + deploy VPS
    run("npm run build", { quiet: true, timeout: 5 * 60_000 });
    run("sudo rm -rf /var/www/misfinanzas/assets && sudo cp -r dist/. /var/www/misfinanzas/ && sudo chown -R www-data:www-data /var/www/misfinanzas", { timeout: 120_000 });
    try { run("sudo systemctl restart misfinanzas-server.service", { quiet: true, timeout: 60_000 }); } catch { /* puede requerir tty; el deploy de server files es manual si aplica */ }

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
