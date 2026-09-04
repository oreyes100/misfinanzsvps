// userBackups.mjs — W33-i2: Motor de respaldo por usuario. W33-i4: verifyBackup
// (veredicto sin lanzar: JSON parseable + hash correcto) + retención por usuario
// (7 diarios + 4 semanales, applyRetention).
// backupUser(syncId) exporta el estado del sync doc a
//   <DATA_DIR>/backups/users/<syncId>/<fecha>.json
// con hash de integridad SHA-256 sobre JSON canónico (claves ordenadas).
// Aislamiento: cada syncId vive en su propio directorio y el id se valida
// contra /^[a-zA-Z0-9_-]+$/ (anti path-traversal → ningún usuario puede
// alcanzar el árbol de otro). No toca el backup global diario de W1 Fortress
// (server.mjs → data/backups/misfinanzas-<fecha>.db).
// db.mjs se importa lazy (igual que apply.mjs); en tests se inyecta
// opts.getState / opts.root para no leer ni escribir en server/data/**.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const SYNC_ID_RE = /^[a-zA-Z0-9_-]{1,100}$/;

// JSON canónico: ordena claves recursivamente → hash determinista
// independiente del orden de inserción y estable entre ejecuciones.
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonicalize(value[k])])
    );
  }
  return value;
}

export function stateHash(state) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(state)))
    .digest("hex");
}

export function usersBackupRoot(root) {
  return path.join(root, "backups", "users");
}

async function loadUserState(syncId, opts) {
  if (typeof opts.getState === "function") return opts.getState(syncId);
  const { getSyncDoc, openDb } = await import("../db.mjs");
  const db = opts.db || openDb();
  const doc = getSyncDoc(db, syncId);
  if (!doc || !doc.state) throw new Error(`sync doc ${syncId} no encontrado`);
  return doc.state;
}

/**
 * Respalda el estado de UN usuario a <root>/backups/users/<syncId>/<fecha>.json.
 * opts: { root?, db?, getState?, now? } — root/getState/now inyectables para tests.
 * Re-respaldo el mismo día sobrescribe (escritura atómica tmp+rename).
 * Devuelve { ok, syncId, date, path, hash, bytes, backedUpAt, syncVersion, counts }.
 */
export async function backupUser(syncId, opts = {}) {
  const id = String(syncId ?? "");
  if (!SYNC_ID_RE.test(id)) {
    throw new Error(`syncId inválido (se permite [a-zA-Z0-9_-]): ${JSON.stringify(id).slice(0, 80)}`);
  }
  const state = await loadUserState(id, opts);
  if (!state || typeof state !== "object") throw new Error(`sync doc ${id} no encontrado`);
  const root = opts.root || (await import("../db.mjs")).DATA_DIR;
  const now = opts.now instanceof Date ? opts.now : opts.now ? new Date(opts.now) : new Date();
  const date = now.toISOString().slice(0, 10);
  const hash = stateHash(state);

  const payload = {
    meta: {
      syncId: id,
      date,
      backedUpAt: now.toISOString(),
      syncVersion: state._syncVersion ?? null,
      counts: {
        accounts: (state.accounts || []).length,
        transactions: (state.transactions || []).length,
      },
    },
    state,
    integrity: { algorithm: "sha256", hash },
  };

  const dir = path.join(usersBackupRoot(root), id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${date}.json`);
  // Escritura atómica: tmp + rename → nunca queda un backup parcial si el
  // proceso muere a mitad de escritura.
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, file);

  return {
    ok: true,
    syncId: id,
    date,
    path: file,
    hash,
    bytes: fs.statSync(file).size,
    backedUpAt: payload.meta.backedUpAt,
    syncVersion: payload.meta.syncVersion,
    counts: payload.meta.counts,
  };
}

/**
 * Verifica la integridad de un respaldo: recalcula el hash del estado y lo
 * compara con integrity.hash. Devuelve { valid, hash, expected, syncId }.
 */
export function verifyUserBackup(backupPath) {
  const doc = JSON.parse(fs.readFileSync(backupPath, "utf8"));
  const expected = doc?.integrity?.hash;
  if (!expected) return { valid: false, reason: "sin hash de integridad", expected: null, hash: null };
  const hash = stateHash(doc.state);
  return {
    valid: hash === expected,
    reason: hash === expected ? null : "el estado fue mutado después del respaldo",
    hash,
    expected,
    syncId: doc?.meta?.syncId ?? null,
  };
}

// ── W33-i4: verificación robusta + retención (7 diarios + 4 semanales) ────────

/**
 * Verificación robusta de un respaldo (W33-i4): NUNCA lanza — cualquier fallo
 * (lectura, JSON corrupto, estructura inválida, hash distinto) devuelve un
 * veredicto { valid:false, reason }. Valida que el contenido sea JSON parseable
 * y que el hash SHA-256 canónico del estado coincida con integrity.hash.
 * Devuelve { valid, reason, hash, expected, syncId, date, path }.
 */
export async function verifyBackup(backupPath) {
  const verdict = (over) => ({
    valid: false,
    reason: null,
    hash: null,
    expected: null,
    syncId: null,
    date: null,
    path: backupPath,
    ...over,
  });
  let raw;
  try {
    raw = fs.readFileSync(backupPath, "utf8");
  } catch (e) {
    return verdict({ reason: `no se pudo leer el respaldo: ${e?.code || e?.message || e}` });
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (e) {
    return verdict({ reason: `JSON no parseable: ${String(e?.message || e).slice(0, 120)}` });
  }
  if (!doc || typeof doc !== "object" || !doc.state || typeof doc.state !== "object") {
    return verdict({ reason: "estructura del respaldo inválida (falta state)" });
  }
  const expected = doc?.integrity?.hash;
  if (typeof expected !== "string" || !expected) {
    return verdict({ reason: "sin hash de integridad" });
  }
  const hash = stateHash(doc.state);
  const valid = hash === expected;
  return verdict({
    valid,
    reason: valid ? null : "el estado fue mutado después del respaldo",
    hash,
    expected,
    syncId: doc?.meta?.syncId ?? null,
    date: doc?.meta?.date ?? null,
  });
}

// ── Retención (W33-i4): esquema abuelo-padre-hijo (grandfather-father-son retention) ──
// Por usuario se conservan:
//   - los RETENTION_DAILY (7) respaldos más recientes (diarios), y
//   - el respaldo más antiguo de cada una de las RETENTION_WEEKLY (4) semanas
//     ISO más recientes, contando hacia atrás desde `now` (semanales → máxima
//     profundidad histórica).
// Todo lo demás se elimina (limpieza automática). Los archivos que no cuadran
// con <YYYY-MM-DD>.json se ignoran: nunca se toca lo que no creó este módulo.

export const RETENTION_DAILY = 7;
export const RETENTION_WEEKLY = 4;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const BACKUP_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;

const isoDateOf = (date) => date.toISOString().slice(0, 10);

/**
 * Clave de semana ISO-8601 ("2026-W36") de una fecha "YYYY-MM-DD" (UTC).
 * La semana la define su jueves (norma ISO). Devuelve null si la fecha es
 * inválida (incluye imposibles tipo "2026-02-30").
 */
export function isoWeekKey(isoDate) {
  if (typeof isoDate !== "string" || !ISO_DATE_RE.test(isoDate)) return null;
  const [y, m, d] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  const day = date.getUTCDay() || 7; // domingo=7
  date.setUTCDate(date.getUTCDate() + 4 - day); // jueves de esa semana
  const week = Math.ceil((date.getTime() - Date.UTC(date.getUTCFullYear(), 0, 1)) / 86_400_000 + 1) / 7;
  return `${date.getUTCFullYear()}-W${String(Math.ceil(week)).padStart(2, "0")}`;
}

/**
 * planRetention: función PURA de retention — decide qué fechas conservar y
 * cuáles eliminar. dates: ["YYYY-MM-DD"...]; opts: { now?, daily?, weekly? }.
 * Conserva los `daily` más recientes + el más antiguo de cada una de las
 * `weekly` semanas ISO más recientes (ventana temporal desde now: si el usuario
 * dejó de respaldar, los weeklies viejos envejecen y se limpian).
 * Devuelve { keep, delete } — ambas ordenadas ascendente, disjuntas y
 * completas (keep ∪ delete = fechas válidas).
 */
export function planRetention(dates, opts = {}) {
  const daily = Math.max(0, Number.isFinite(opts.daily) ? opts.daily : RETENTION_DAILY);
  const weekly = Math.max(0, Number.isFinite(opts.weekly) ? opts.weekly : RETENTION_WEEKLY);
  const now = opts.now instanceof Date ? opts.now : opts.now ? new Date(opts.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error(`now inválido: ${String(opts.now).slice(0, 60)}`);

  const valid = [...new Set(dates)].filter((d) => isoWeekKey(d) !== null).sort();
  const keep = new Set(daily > 0 ? valid.slice(-daily) : []);

  const window = new Set();
  for (let k = 0; k < weekly; k++) {
    window.add(isoWeekKey(isoDateOf(new Date(now.getTime() - k * 7 * 86_400_000))));
  }
  const oldestOfWeek = new Map(); // weekKey → fecha más antigua de esa semana
  for (const d of valid) {
    const wk = isoWeekKey(d);
    if (window.has(wk) && !oldestOfWeek.has(wk)) oldestOfWeek.set(wk, d);
  }
  for (const d of oldestOfWeek.values()) keep.add(d);

  return {
    keep: valid.filter((d) => keep.has(d)),
    delete: valid.filter((d) => !keep.has(d)),
  };
}

/**
 * applyRetention: limpieza automática sobre <root>/backups/users/<syncId>/.
 * Lista los respaldos del usuario, calcula el plan de retention (planRetention)
 * y elimina los sobrantes. Nunca borra archivos fuera del patrón
 * <YYYY-MM-DD>.json ni toca el árbol de otro usuario (syncId validado con
 * SYNC_ID_RE, anti path-traversal). Si el directorio no existe → ok sin borrados.
 * Devuelve { ok, syncId, kept, deleted, errors } (errors: fallos de unlink).
 */
export async function applyRetention(syncId, opts = {}) {
  const id = String(syncId ?? "");
  if (!SYNC_ID_RE.test(id)) {
    throw new Error(`syncId inválido (se permite [a-zA-Z0-9_-]): ${JSON.stringify(id).slice(0, 80)}`);
  }
  const root = opts.root || (await import("../db.mjs")).DATA_DIR;
  const dir = path.join(usersBackupRoot(root), id);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (e) {
    if (e && e.code === "ENOENT") return { ok: true, syncId: id, kept: [], deleted: [], errors: [] };
    throw e;
  }
  const dates = entries.map((f) => (BACKUP_FILE_RE.exec(f) || [])[1]).filter(Boolean);
  const retentionPlan = planRetention(dates, opts);
  const errors = [];
  for (const date of retentionPlan.delete) {
    try {
      fs.unlinkSync(path.join(dir, `${date}.json`));
    } catch (e) {
      errors.push({ date, error: String(e?.message || e) });
    }
  }
  return { ok: errors.length === 0, syncId: id, kept: retentionPlan.keep, deleted: retentionPlan.delete, errors };
}
