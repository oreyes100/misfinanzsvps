// db.mjs — Motor SQLite local para Mis Finanzas (reemplaza Vercel Blob).
// Esquema híbrido: capa de documento (sync_docs, fiel a la semántica de sync
// con merge + tombstones) + capa relacional normalizada (users, accounts,
// transactions) para consultas/analítica vía SQL.
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "data");

export function openDb(dbPath) {
  const dbf = dbPath || path.join(DATA_DIR, "misfinanzas.db");
  const db = new Database(dbf);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

export function initSchema(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    email    TEXT,
    role     TEXT NOT NULL DEFAULT 'user',
    sections TEXT,
    accounts TEXT,
    hash     TEXT,
    salt     TEXT,
    created  TEXT,
    updated  INTEGER
  );

  CREATE TABLE IF NOT EXISTS sync_docs (
    sync_code     TEXT PRIMARY KEY,
    state_json    TEXT NOT NULL,
    updated_at    INTEGER,
    sync_version  INTEGER,
    doc_size      INTEGER
  );

  CREATE TABLE IF NOT EXISTS accounts (
    sync_code    TEXT NOT NULL,
    id           TEXT NOT NULL,
    name         TEXT,
    type         TEXT,
    currency     TEXT,
    balance      REAL,
    rate         REAL,
    accrual      TEXT,
    isr_rate     REAL,
    last_accrual TEXT,
    extra_json   TEXT,
    PRIMARY KEY (sync_code, id)
  );

  CREATE TABLE IF NOT EXISTS transactions (
    sync_code     TEXT NOT NULL,
    id            TEXT NOT NULL UNIQUE,
    date          TEXT,
    description   TEXT,
    amount        REAL,
    currency      TEXT,
    category      TEXT,
    subcategory   TEXT,
    account_id    TEXT,
    auto          INTEGER,
    counterpart_id TEXT,
    notes         TEXT,
    _updated_at   INTEGER,
    extra_json    TEXT,
    PRIMARY KEY (sync_code, id)
  );
  CREATE INDEX IF NOT EXISTS idx_tx_date    ON transactions(sync_code, date);
  CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(sync_code, account_id);
  CREATE INDEX IF NOT EXISTS idx_tx_cat     ON transactions(sync_code, category);

  CREATE TABLE IF NOT EXISTS signup_pending (
    email      TEXT PRIMARY KEY,
    hash       TEXT NOT NULL,
    salt       TEXT NOT NULL,
    code       TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0
  );
  `);
}

// ---------- users ----------
export function getUsers(db) {
  return db.prepare("SELECT * FROM users").all().map((r) => ({
    username: r.username,
    email: r.email || undefined,
    role: r.role,
    sections: r.sections ? JSON.parse(r.sections) : undefined,
    accounts: r.accounts ? JSON.parse(r.accounts) : undefined,
    hash: r.hash,
    salt: r.salt,
    created: r.created || undefined,
  }));
}

export function replaceUsers(db, users) {
  const del = db.prepare("DELETE FROM users");
  const ins = db.prepare(
    "INSERT OR REPLACE INTO users (username, email, role, sections, accounts, hash, salt, created, updated) VALUES (?,?,?,?,?,?,?,?,?)"
  );
  const tx = db.transaction((list) => {
    del.run();
    for (const u of list) {
      ins.run(
        String(u.username || ""),
        u.email ? String(u.email) : null,
        String(u.role || "user"),
        u.sections ? JSON.stringify(u.sections) : null,
        u.accounts ? JSON.stringify(u.accounts) : null,
        u.hash ?? null,
        u.salt ?? null,
        u.created ? String(u.created) : null,
        Date.now()
      );
    }
  });
  tx(users);
}

// ---------- sync docs ----------
export function getSyncDoc(db, code) {
  const row = db.prepare("SELECT * FROM sync_docs WHERE sync_code = ?").get(code);
  if (!row) return null;
  return { state: JSON.parse(row.state_json), updatedAt: row.updated_at };
}

function normalizeDoc(db, code, state) {
  const delTx = db.prepare("DELETE FROM transactions WHERE sync_code = ?");
  const insTx = db.prepare(
    `INSERT OR REPLACE INTO transactions
       (sync_code, id, date, description, amount, currency, category, subcategory, account_id, auto, counterpart_id, notes, _updated_at, extra_json)
     VALUES (@sync_code, @id, @date, @description, @amount, @currency, @category, @subcategory, @account_id, @auto, @counterpart_id, @notes, @_updated_at, @extra_json)`
  );
  const delAc = db.prepare("DELETE FROM accounts WHERE sync_code = ?");
  const insAc = db.prepare(
    `INSERT OR REPLACE INTO accounts
       (sync_code, id, name, type, currency, balance, rate, accrual, isr_rate, last_accrual, extra_json)
     VALUES (@sync_code, @id, @name, @type, @currency, @balance, @rate, @accrual, @isr_rate, @last_accrual, @extra_json)`
  );
  const KNOWN_TX = new Set(["id", "date", "description", "amount", "currency", "category", "subcategory", "accountId", "auto", "counterpartId", "notes", "_updatedAt"]);
  const KNOWN_AC = new Set(["id", "name", "type", "currency", "balance", "rate", "accrual", "isrRate", "lastAccrual"]);
  const tx = db.transaction(() => {
    delTx.run(code);
    for (const t of state.transactions || []) {
      if (!t || t.id === undefined) continue;
      const extra = {};
      for (const k of Object.keys(t)) if (!KNOWN_TX.has(k)) extra[k] = t[k];
      insTx.run({
        sync_code: code,
        id: String(t.id),
        date: t.date ?? null,
        description: t.description ?? null,
        amount: typeof t.amount === "number" ? t.amount : parseFloat(t.amount ?? 0) || 0,
        currency: t.currency ?? null,
        category: t.category ?? null,
        subcategory: t.subcategory ?? null,
        account_id: t.accountId ?? null,
        auto: t.auto ? 1 : 0,
        counterpart_id: t.counterpartId ?? null,
        notes: t.notes ?? null,
        _updated_at: t._updatedAt ?? null,
        extra_json: Object.keys(extra).length ? JSON.stringify(extra) : null,
      });
    }
    delAc.run(code);
    for (const a of state.accounts || []) {
      if (!a || a.id === undefined) continue;
      const extra = {};
      for (const k of Object.keys(a)) if (!KNOWN_AC.has(k)) extra[k] = a[k];
      insAc.run({
        sync_code: code,
        id: String(a.id),
        name: a.name ?? null,
        type: a.type ?? null,
        currency: a.currency ?? null,
        balance: typeof a.balance === "number" ? a.balance : parseFloat(a.balance ?? 0) || 0,
        rate: typeof a.rate === "number" ? a.rate : parseFloat(a.rate ?? 0),
        accrual: a.accrual ?? null,
        isr_rate: typeof a.isrRate === "number" ? a.isrRate : parseFloat(a.isrRate ?? 0),
        last_accrual: a.lastAccrual ?? null,
        extra_json: Object.keys(extra).length ? JSON.stringify(extra) : null,
      });
    }
  });
  tx();
}

export function putSyncDoc(db, code, state, updatedAt) {
  const payload = JSON.stringify({ state, updatedAt: updatedAt ?? Date.now() });
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO sync_docs (sync_code, state_json, updated_at, sync_version, doc_size) VALUES (?,?,?,?,?)"
  );
  const tx = db.transaction(() => {
    stmt.run(code, payload, updatedAt ?? Date.now(), state._syncVersion ?? null, payload.length);
    normalizeDoc(db, code, state);
  });
  tx();
}

// ---------- signup pendings ----------
export function getPendings(db) {
  const rows = db.prepare("SELECT * FROM signup_pending").all();
  return rows.map((r) => ({ email: r.email, hash: r.hash, salt: r.salt, code: r.code, expiresAt: r.expires_at, attempts: r.attempts }));
}

export function writePendings(db, pendings) {
  const del = db.prepare("DELETE FROM signup_pending");
  const ins = db.prepare("INSERT OR REPLACE INTO signup_pending (email, hash, salt, code, expires_at, attempts) VALUES (?,?,?,?,?,?)");
  const tx = db.transaction((list) => {
    del.run();
    for (const p of list) ins.run(String(p.email), p.hash, p.salt, String(p.code), p.expiresAt, p.attempts || 0);
  });
  tx(pendings);
}