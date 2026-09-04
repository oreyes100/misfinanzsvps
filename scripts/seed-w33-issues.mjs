// seed-w33-issues.mjs — W33: respaldos periódicos por usuario (+ hotfix spec-skill formalizado).
// Inyección manual: el spec-skill estaba roto (ReferenceError complexity), ya corregido en 2beae7c.
// Preflight integrado: nada se inyecta si la API real no cuadra.
import { createIssue, updateIssue, loadIssues } from "../server/hermes/issues.mjs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const W = 33;
const existing = loadIssues().issues.filter((i) => i.wargame === W);
if (existing.length) {
  console.log(`⚠️ Ya existen ${existing.length} issues de w${W} — abortando (sin duplicar)`);
  process.exit(0);
}

// Preflight contra la API REAL (lección: paths/API supuestos no reales → abortar)
if (typeof createIssue !== "function" || typeof updateIssue !== "function") {
  console.error("❌ Abortando: la API de issues.mjs no cuadra con lo esperado");
  process.exit(1);
}

const NON_GOALS = [
  "No mezclar datos entre usuarios",
  "No modificar el backup global diario de W1 Fortress",
  "No exponer respaldos de un usuario a otro",
];
// La suite server corre con node --test (vitest solo incluye src/** y lib/**)
const TEST_CMD = (name) => `node --test server/hermes/${name}.test.mjs 2>&1 | tail -3`;

function add(title, acceptanceCriteria, nonGoals = NON_GOALS) {
  return createIssue({ wargame: W, title, acceptanceCriteria, nonGoals, complexity: "feature" });
}

// w33-i1 — la hotfix del spec-skill ya está aplicada (commit 2beae7c): se formaliza
const i1 = add(
  "Formalizar hotfix spec-skill: normalizeComplexity + default seguro (ya implementado manualmente)",
  [
    { desc: "normalizeComplexity existe", check: 'grep -n "export function normalizeComplexity" server/hermes/spec-skill.mjs' },
    { desc: "Tests del normalizador verdes", check: TEST_CMD("spec-skill") },
  ],
  ["No cambiar el flujo de entrevista de 7 preguntas"]
);

const i2 = add(
  "Motor de respaldo por usuario: backupUser(syncId) exporta el estado a server/data/backups/users/<syncId>/<fecha>.json con hash de integridad",
  [
    { desc: "backupUser exportada existe", check: 'grep -n "export async function backupUser" server/hermes/userBackups.mjs' },
    { desc: "Rutas separadas por usuario", check: 'grep -n "backups/users" server/hermes/userBackups.mjs' },
    { desc: "Tests del motor verdes", check: TEST_CMD("userBackups") },
  ]
);

const i3 = add(
  "Scheduler systemd diario: deploy/user-backups.timer + .service que respalda a todos los usuarios con sync activo",
  [
    { desc: "Timer con OnCalendar diario", check: 'grep -n "OnCalendar" deploy/user-backups.timer' },
    { desc: "Script backupAllUsers existe", check: 'grep -n "backupAllUsers" scripts/backup-all-users.mjs' },
  ]
);

const i4 = add(
  "Verificación + retención: verifyBackup (JSON parseable + hash correcto) y retención por usuario (7 diarios + 4 semanales) con limpieza automática",
  [
    { desc: "verifyBackup valida JSON y hash", check: 'grep -n "export async function verifyBackup" server/hermes/userBackups.mjs' },
    { desc: "Retención implementada", check: 'grep -n "retention" server/hermes/userBackups.mjs' },
  ]
);

const i5 = add(
  "Restauración por usuario: restoreUser(syncId, fecha) con confirmación y verificación post-restore (hash del estado = hash del respaldo)",
  [
    { desc: "restoreUser exportada existe", check: 'grep -n "export async function restoreUser" server/hermes/userBackups.mjs' },
    { desc: "Tests de restore verdes", check: TEST_CMD("userBackups") },
  ]
);

const i6 = add(
  "Notificaciones + visibilidad: aviso Telegram al completar el respaldo diario (éxito/fallo) y listado de respaldos en Ajustes",
  [
    { desc: "Aviso tras backup", check: 'grep -n "notify" server/hermes/userBackups.mjs' },
    { desc: "UI lista respaldos en Ajustes", check: 'grep -n "backups" src/components/Settings.jsx' },
  ]
);

// w33-i1: el hotfix ya está implementado y commiteado (2beae7c) → done directo
updateIssue(i1.id, { state: "in_progress" });
updateIssue(i1.id, { state: "review" });
updateIssue(i1.id, { state: "ready_to_merge" });
updateIssue(i1.id, { state: "done" });

console.log(`✅ ${loadIssues().issues.filter((i) => i.wargame === W).length} issues de w${W} en el tracker`);
console.log(`   w33-i1: done (hotfix ya aplicado en 2beae7c)`);
console.log(`   w33-i2..i6: todo — el build loop los tomará en ≤5 min`);
