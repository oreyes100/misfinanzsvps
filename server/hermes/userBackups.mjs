// userBackups.mjs — W33-i2: Motor de respaldo por usuario. W33-i4: verifyBackup
// (veredicto sin lanzar: JSON parseable + hash correcto) + retención por usuario
// (7 diarios + 4 semanales, applyRetention). W33-i5: restoreUser(syncId, fecha)
// con confirmación explícita (human-in-the-loop) y verificación post-restore
// (hash del estado escrito === hash del respaldo).
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

// ── W33-i5: restauración por usuario ──────────────────────────────────────────

async function peekUserState(syncId, opts) {
  if (typeof opts.getState === "function") {
    const s = await opts.getState(syncId);
    return s ?? null;
  }
  const { getSyncDoc, openDb } = await import("../db.mjs");
  const db = opts.db || openDb();
  const doc = getSyncDoc(db, syncId);
  return doc?.state ?? null;
}

async function persistUserState(syncId, state, opts, updatedAt) {
  if (typeof opts.putState === "function") {
    await opts.putState(syncId, state);
    return;
  }
  const { putSyncDoc, openDb } = await import("../db.mjs");
  const db = opts.db || openDb();
  putSyncDoc(db, syncId, state, updatedAt);
}

const summarizeState = (state) =>
  state
    ? {
        syncVersion: state._syncVersion ?? null,
        counts: {
          accounts: (state.accounts || []).length,
          transactions: (state.transactions || []).length,
        },
      }
    : null;

/**
 * Restaura el estado de UN usuario desde SU respaldo
 * <root>/backups/users/<syncId>/<fecha>.json (W33-i5). Flujo human-in-the-loop:
 *   1) Sin opts.confirm → NO toca nada: devuelve { ok:false,
 *      needsConfirmation:true, preview } con hash/syncVersion/counts del
 *      respaldo y del estado actual (materia para la confirmación).
 *   2) Con opts.confirm === true → verifica el respaldo (verifyBackup: JSON
 *      parseable + hash correcto), escribe el estado (putState inyectable /
 *      putSyncDoc en producción) y RE-VERIFICA leyendo el estado escrito:
 *      hash(estado post-restore) DEBE ser igual al hash del respaldo, si no
 *      devuelve { ok:false, verified:false }.
 * Aislamiento: solo lee su propio árbol (syncId validado, anti path-traversal)
 * y además exige meta.syncId === syncId — nunca expone ni mezcla respaldos de
 * otro usuario. No toca el backup global diario de W1 Fortress.
 * opts: { confirm?, root?, db?, getState?, putState?, now? } — root/db/getState/
 * putState/now inyectables para tests (getState+putState juntos o ninguno: la
 * verificación post-restore exige leer el estado escrito).
 * Lanza SOLO por argumentos inválidos (syncId/fecha, anti path-traversal);
 * los fallos operativos (respaldo inexistente, corrupto, de otro usuario,
 * hash post-restore distinto) devuelven { ok:false, reason } sin lanzar.
 * Devuelve { ok, verified, syncId, date, path, hash, restoredAt, syncVersion,
 * counts, overwritten } en éxito.
 */
export async function restoreUser(syncId, fecha, opts = {}) {
  const id = String(syncId ?? "");
  if (!SYNC_ID_RE.test(id)) {
    throw new Error(`syncId inválido (se permite [a-zA-Z0-9_-]): ${JSON.stringify(id).slice(0, 80)}`);
  }
  const date = String(fecha ?? "");
  if (!BACKUP_FILE_RE.test(`${date}.json`)) {
    throw new Error(`fecha inválida (se espera YYYY-MM-DD): ${JSON.stringify(date).slice(0, 80)}`);
  }
  const hasGet = typeof opts.getState === "function";
  const hasPut = typeof opts.putState === "function";
  if (hasGet !== hasPut) {
    throw new Error("restoreUser: inyecta getState y putState JUNTOS (o ninguno) — la verificación post-restore exige leer el estado escrito");
  }
  const root = opts.root || (await import("../db.mjs")).DATA_DIR;
  const file = path.join(usersBackupRoot(root), id, `${date}.json`);
  const now = opts.now instanceof Date ? opts.now : opts.now ? new Date(opts.now) : new Date();
  const restoredAt = now.toISOString();

  const verdict = (over) => ({
    ok: false,
    needsConfirmation: false,
    verified: false,
    reason: null,
    syncId: id,
    date,
    path: file,
    ...over,
  });

  const v = await verifyBackup(file);
  if (!v.valid) return verdict({ reason: v.reason });

  // Aislamiento (non-goal: no exponer respaldos de un usuario a otro): el
  // respaldo debe pertenecer AL usuario solicitado, no basta con su ruta.
  if (v.syncId !== id) {
    return verdict({ reason: `el respaldo pertenece a otro usuario (${v.syncId ?? "desconocido"}), restauración denegada` });
  }

  // Re-parse seguro: verifyBackup acaba de validar JSON + estructura + hash.
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return verdict({ reason: `el respaldo cambió durante la restauración: ${String(e?.message || e).slice(0, 120)}` });
  }
  const expectedHash = doc.integrity.hash;
  const overwritten = summarizeState(await peekUserState(id, opts));

  const preview = {
    syncId: id,
    date,
    path: file,
    hash: expectedHash,
    syncVersion: doc.meta?.syncVersion ?? doc.state._syncVersion ?? null,
    counts: doc.meta?.counts ?? summarizeState(doc.state).counts,
    backedUpAt: doc.meta?.backedUpAt ?? null,
    current: overwritten,
  };

  if (opts.confirm !== true) {
    return verdict({
      needsConfirmation: true,
      reason: "restauración requiere confirmación explícita (opts.confirm: true) — no se modificó nada",
      hash: expectedHash,
      preview,
    });
  }

  await persistUserState(id, doc.state, opts, now.getTime());

  // Verificación post-restore: hash(estado escrito y leído) === hash del respaldo
  const readBack = await peekUserState(id, opts);
  const postHash = readBack ? stateHash(readBack) : null;
  if (postHash !== expectedHash) {
    return verdict({
      reason: "verificación post-restore falló: hash del estado restaurado ≠ hash del respaldo",
      hash: expectedHash,
      overwritten,
    });
  }

  return {
    ok: true,
    verified: true,
    reason: null,
    syncId: id,
    date,
    path: file,
    hash: expectedHash,
    restoredAt,
    syncVersion: doc.state._syncVersion ?? null,
    counts: preview.counts,
    overwritten,
  };
}

// ── W33-i6: notificaciones + visibilidad ──────────────────────────────────────
// Al completar el respaldo diario por usuario se envía UN aviso Telegram
// (éxito/fallo) por el canal de bindings ya vinculado (notifications.mjs).
// El mensaje se construye con backupSummaryMessage (función PURA, testeable) y
// el envío es inyectable (opts.notify) para que los tests NUNCA toquen red ni
// server/data/**. listUserBackups alimenta el listado de Ajustes (solo
// metadatos del PROPIO usuario — jamás del árbol de otro).

const fmtBytes = (n) =>
  !Number.isFinite(n) || n < 0
    ? "?"
    : n < 1024
      ? `${n} B`
      : n < 1024 * 1024
        ? `${(n / 1024).toFixed(1)} kB`
        : `${(n / (1024 * 1024)).toFixed(1)} MB`;

/**
 * Lista los respaldos del PROPIO usuario: metadatos de cada
 * <root>/backups/users/<syncId>/<fecha>.json (fecha, bytes, hash, veredicto de
 * integridad vía verifyBackup, backedUpAt, syncVersion, counts), ascendente.
 * Aislamiento: solo lee el árbol del syncId (validado, anti path-traversal);
 * no toca el backup global de W1 Fortress (data/backups/*.db).
 * Devuelve { syncId, found, backups } — found:false si el usuario aún no tiene
 * respaldos. Lanza SOLO por syncId inválido.
 */
export async function listUserBackups(syncId, opts = {}) {
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
    if (e && e.code === "ENOENT") return { syncId: id, found: false, backups: [] };
    throw e;
  }
  const dates = entries
    .map((f) => (BACKUP_FILE_RE.exec(f) || [])[1])
    .filter(Boolean)
    .sort();
  const backups = [];
  for (const date of dates) {
    const p = path.join(dir, `${date}.json`);
    const v = await verifyBackup(p);
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(p, "utf8"))?.meta ?? null; } catch { /* verifyBackup ya lo marcó */ }
    let bytes = null;
    try { bytes = fs.statSync(p).size; } catch { /* desapareció a mitad de listado */ }
    backups.push({
      date,
      path: p,
      bytes,
      hash: v.hash,
      valid: v.valid,
      reason: v.reason,
      backedUpAt: meta?.backedUpAt ?? null,
      syncVersion: meta?.syncVersion ?? null,
      counts: meta?.counts ?? null,
    });
  }
  return { syncId: id, found: backups.length > 0, backups };
}

/**
 * Mensaje de resumen del respaldo diario (función PURA): una línea por usuario,
 * ✅ con éxito (cuentas/movs/versión/tamaño) y ❌ con fallo (motivo), encabezado
 * con la fecha y el conteo global. Truncado a 3500 chars (límite Telegram 4096
 * con margen). results: salida de backupUser ({ok,...}) o fallos capturados
 * ({ok:false, syncId, reason}).
 */
export function backupSummaryMessage(results, now = new Date()) {
  const date = (now instanceof Date ? now : new Date(now)).toISOString().slice(0, 10);
  const ok = results.filter((r) => r && r.ok);
  const fail = results.filter((r) => r && !r.ok);
  const lines = [
    `🗂 Respaldo por usuario — ${date}`,
    results.length
      ? `✅ ${ok.length} con éxito · ❌ ${fail.length} con fallo`
      : "Sin usuarios con sync activo: nada que respaldar",
  ];
  for (const r of ok) {
    lines.push(
      `✅ ${r.syncId} · ${r.counts?.accounts ?? "?"} cuentas · ${r.counts?.transactions ?? "?"} movs · v${r.syncVersion ?? "?"} · ${fmtBytes(r.bytes)}${r.retentionDeleted ? ` · retención: -${r.retentionDeleted}` : ""}`
    );
  }
  for (const r of fail) lines.push(`❌ ${r.syncId} · ${r.reason || "fallo desconocido"}`);
  return lines.join("\n").slice(0, 3500);
}

/**
 * Envía el resumen por Telegram. opts.notify inyectable (tests); por defecto
 * usa notify de notifications.mjs (import lazy: los tests con stub no cargan
 * red). NUNCA lanza: un fallo del canal no rompe el job de respaldo.
 * Devuelve el texto enviado, o null si el envío falló / no había canal.
 */
export async function notifyBackupResults(results, opts = {}) {
  try {
    const send =
      typeof opts.notify === "function"
        ? opts.notify
        : (await import("./notifications.mjs")).notify;
    const text = backupSummaryMessage(results, opts.now);
    await send(text);
    return text;
  } catch (e) {
    console.error("[user-backups] aviso Telegram falló:", e?.message || e);
    return null;
  }
}

/**
 * Respaldo diario de TODOS los usuarios con sync activo (W33-i6): para cada
 * syncId ejecuta backupUser + applyRetention, captura fallos por usuario (un
 * usuario caído no aborta el lote) y al final envía UN aviso Telegram con el
 * resumen éxito/fallo (opts.notify === false lo desactiva; fn inyectable en
 * tests). opts se propaga a backupUser/applyRetention ({root, db, getState,
 * now,...}) — en tests siempre inyectados, sin tocar server/data/**.
 * Devuelve { ok, results, notified } — ok:true solo si TODOS los respaldos
 * succeeded (con lote vacío ok:true); notified: texto enviado o null.
 */
export async function runDailyUserBackups(syncIds, opts = {}) {
  const ids = [...new Set((syncIds || []).map((id) => String(id ?? ""))).values()].filter(Boolean);
  const results = [];
  for (const id of ids) {
    try {
      const r = await backupUser(id, opts);
      const ret = await applyRetention(id, opts);
      results.push({ ...r, retentionDeleted: ret.deleted?.length ?? 0, retentionErrors: ret.errors ?? [] });
    } catch (e) {
      results.push({ ok: false, syncId: id, reason: String(e?.message || e).slice(0, 160) });
    }
  }
  const notified = opts.notify === false ? null : await notifyBackupResults(results, opts);
  return { ok: results.every((r) => r.ok), results, notified };
}
