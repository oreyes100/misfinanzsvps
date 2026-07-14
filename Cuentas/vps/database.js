/**
 * database.js — Versión VPS (sin Vercel Blob, almacenamiento local siempre)
 * Drop-in replacement de ../database.js para deploy en servidor propio.
 */
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const IS_VERCEL = false;
const dbPath = path.join(__dirname, 'data', 'contabilidad.db');

// Asegurar que exista el directorio de datos
if (!fs.existsSync(path.dirname(dbPath))) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
}

let db;
let SQL;
let _dirty = false;

function getLoadState() { return 'local'; }

async function flushToBlob() { /* no-op en VPS */ }

function saveDB() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
  _dirty = true;
  global._dbDirty = true;
}

async function initDB() {
  SQL = await initSqlJs({
    locateFile: (file) => {
      try { return require.resolve('sql.js/dist/' + file); } catch {}
      return file;
    },
  });

  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  db.run('PRAGMA foreign_keys = ON');

  db.run(`CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    balance REAL NOT NULL DEFAULT 0,
    type TEXT DEFAULT 'main'
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    description TEXT NOT NULL,
    code TEXT NOT NULL,
    amount REAL NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('income','expense','transfer','transfer_in')),
    account TEXT NOT NULL,
    from_account TEXT,
    to_account TEXT,
    receipt_path TEXT,
    receipt_text TEXT,
    service_year TEXT,
    to62_ref TEXT,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS codes (
    code TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    category TEXT NOT NULL
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT
  )`);

  const accCount = db.exec('SELECT COUNT(*) as c FROM accounts');
  if (!accCount.length || accCount[0].values[0][0] === 0) {
    db.run("INSERT INTO accounts (id, name, balance, type) VALUES (?, ?, ?, ?)", ['corriente', 'Cuenta Principal (Banco)', 0, 'bank']);
    db.run("INSERT INTO accounts (id, name, balance, type) VALUES (?, ?, ?, ?)", ['caja', 'Caja de Efectivo', 0, 'cash']);
    db.run("INSERT INTO accounts (id, name, balance, type) VALUES (?, ?, ?, ?)", ['sucursal', 'Fondos en la Sucursal', 0, 'branch']);
  }

  const codeCount = db.exec('SELECT COUNT(*) as c FROM codes');
  if (!codeCount.length || codeCount[0].values[0][0] === 0) {
    const codes = [
      ['DC','Donación en Caja de Contribuciones','income'],
      ['DB','Donación por Transferencia Bancaria','income'],
      ['DE','Donación Electrónica (jw.org)','income'],
      ['DO','Donación para Obra Mundial (remesa)','income'],
      ['DK','Donación para Salones del Reino','income'],
      ['DA','Donación para Asambleas','income'],
      ['OI','Otros Ingresos','income'],
      ['IC','Intereses Bancarios','income'],
      ['RE','Remesa a la Sucursal (TO-62)','expense'],
      ['GS','Gastos de Servicio (predicación)','expense'],
      ['GL','Gastos de Local (Salón del Reino)','expense'],
      ['GM','Gastos de Mantenimiento','expense'],
      ['GA','Gastos Administrativos','expense'],
      ['GC','Gastos de Circuito/Asamblea','expense'],
      ['OT','Otros Gastos','expense'],
      ['TC','Transferencia de Banco a Caja','transfer'],
      ['TB','Transferencia de Caja a Banco','transfer'],
      ['TF','Transferencia a Fondos Sucursal','transfer'],
    ];
    for (const [code, desc, cat] of codes) {
      db.run("INSERT OR IGNORE INTO codes (code, description, category) VALUES (?, ?, ?)", [code, desc, cat]);
    }
    db.run("INSERT OR IGNORE INTO codes (code, description, category) VALUES (?, ?, ?)", ['OR','Donaciones obra mundial','income']);
    db.run("INSERT OR IGNORE INTO codes (code, description, category) VALUES (?, ?, ?)", ['C','Donaciones (Gastos de la congregación)','income']);
    db.run("INSERT OR IGNORE INTO codes (code, description, category) VALUES (?, ?, ?)", ['G','Gastos de la congregación','expense']);
  }

  db.run(`INSERT OR IGNORE INTO config (key, value) VALUES ('congregacion', '')`);
  db.run(`INSERT OR IGNORE INTO config (key, value) VALUES ('ciudad', '')`);
  db.run(`INSERT OR IGNORE INTO config (key, value) VALUES ('provincia', '')`);
  db.run(`INSERT OR IGNORE INTO config (key, value) VALUES ('servicio_year', '')`);
  db.run(`INSERT OR IGNORE INTO config (key, value) VALUES ('publishers', '70')`);

  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )`);

  const userCount = db.exec('SELECT COUNT(*) as c FROM users');
  if (!userCount.length || userCount[0].values[0][0] === 0) {
    const { hash } = hashPassword('admin1234');
    run("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)", ['admin', hash, 'admin']);
    console.log('Usuario admin creado. CAMBIE LA CONTRASEÑA en el panel de administración.');
  }

  saveDB();
  return db;
}

function getDB() { return db; }

function restoreFromBuffer(buf) {
  if (!SQL) throw new Error('SQL no listo');
  db = new SQL.Database(buf);
  fs.writeFileSync(dbPath, buf);
  _dirty = true;
  global._dbDirty = true;
}

function query(sql, params = []) {
  const stmt = db.prepare(sql);
  const isSelect = sql.trim().toUpperCase().startsWith('SELECT') || sql.trim().toUpperCase().startsWith('WITH');
  if (isSelect) {
    stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }
  db.run(sql, params);
  const changes = db.getRowsModified();
  stmt.free();
  return { changes };
}

function get(sql, params = []) {
  const rows = query(sql, params);
  return rows.length ? rows[0] : null;
}

function run(sql, params = []) { db.run(sql, params); }

function transaction(fn) {
  db.run('BEGIN');
  try {
    fn();
    db.run('COMMIT');
    saveDB();
  } catch (e) {
    try { db.run('ROLLBACK'); } catch (_) {}
    saveDB();
    throw e;
  }
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return { salt, hash: `${salt}:${hash}` };
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const check = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
  return hash === check;
}

module.exports = { initDB, getDB, query, get, run, transaction, saveDB, flushToBlob, getLoadState, IS_VERCEL, hashPassword, verifyPassword, restoreFromBuffer };
