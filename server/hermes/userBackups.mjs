// userBackups.mjs — W33-i2: Motor de respaldo por usuario.
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
