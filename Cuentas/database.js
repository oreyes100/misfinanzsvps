const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

// En Vercel (serverless) el filesystem del proyecto es de solo lectura; solo
// /tmp es escribible y efímero. La copia durable vive en Vercel Blob.
const IS_VERCEL = !!process.env.VERCEL;
const dbPath = IS_VERCEL ? '/tmp/contabilidad.db' : path.join(__dirname, 'contabilidad.db');
const BLOB_KEY = 'cuentas/contabilidad.db';

let db;
let _dirty = false;
// Resultado de la última carga desde Blob: 'loaded' (había copia), 'absent'
// (no hay copia aún → primer arranque legítimo) o 'error' (fallo transitorio).
let _loadState = 'none';

function getLoadState() { return _loadState; }

/** Descarga la BD desde Vercel Blob a /tmp usando el pathname del blob. */
async function loadFromBlob() {
  if (!IS_VERCEL || !process.env.BLOB_READ_WRITE_TOKEN) { _loadState = 'absent'; return false; }
  try {
    const { get } = require('@vercel/blob');
    // get acepta el pathname directamente (no hace falta construir la URL del store).
    const result = await get(BLOB_KEY, { access: 'private', useCache: false });
    if (!result) { _loadState = 'absent'; return false; }
    const buffer = Buffer.from(await new Response(result.stream).arrayBuffer());
    fs.writeFileSync(dbPath, buffer);
    _loadState = 'loaded';
    return true;
  } catch (e) {
    // No tragarse el error: marcar 'error' para que initDB NO siembre vacío
    // encima de los datos durables (eso provocaba pérdida total al hacer flush).
    _loadState = 'error';
    console.error('loadFromBlob falló:', e.message);
    return false;
  }
}

/** Sube la BD actual (/tmp) a Vercel Blob si hay cambios pendientes. */
async function flushToBlob() {
  if (!IS_VERCEL || !_dirty || !process.env.BLOB_READ_WRITE_TOKEN) return;
  try {
    const { put } = require('@vercel/blob');
    const buffer = fs.readFileSync(dbPath);
    await put(BLOB_KEY, buffer, {
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/octet-stream',
    });
    _dirty = false;
  } catch (e) {
    console.error('flushToBlob falló:', e.message);
  }
}

function saveDB() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
  _dirty = true; // marcar para que el wrapper serverless lo suba a Blob
}

async function initDB() {
  // locateFile resuelve el .wasm de sql.js de forma robusta tanto en local como
  // en el bundle serverless de Vercel (require.resolve lo marca para node-file-trace).
  const SQL = await initSqlJs({
    locateFile: (file) => {
      // Local: resolver desde node_modules. Vercel: copia incluida en public/ (includeFiles).
      try { return require.resolve('sql.js/dist/' + file); } catch {}
      const inPublic = path.join(__dirname, 'public', file);
      if (fs.existsSync(inPublic)) return inPublic;
      return file;
    },
  });

  // En la nube: intentar traer la copia durable antes de leer el archivo local.
  if (IS_VERCEL) {
    await loadFromBlob();
    // CRÍTICO: si la carga falló por un error (no por ausencia), abortar el
    // arranque. Continuar arrancaría con una BD vacía sembrada y el flush
    // posterior la subiría a Blob, DESTRUYENDO los datos reales. Mejor 500
    // transitorio (el request se reintenta) que pérdida permanente de datos.
    if (_loadState === 'error') {
      throw new Error('BD no disponible temporalmente (fallo al leer Blob). Reintenta en unos segundos.');
    }
  }

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

  // Create accounts
  const accCount = db.exec('SELECT COUNT(*) as c FROM accounts');
  if (!accCount.length || accCount[0].values[0][0] === 0) {
    db.run("INSERT INTO accounts (id, name, balance, type) VALUES (?, ?, ?, ?)", ['corriente', 'Cuenta Principal (Banco)', 0, 'bank']);
    db.run("INSERT INTO accounts (id, name, balance, type) VALUES (?, ?, ?, ?)", ['caja', 'Caja de Efectivo', 0, 'cash']);
    db.run("INSERT INTO accounts (id, name, balance, type) VALUES (?, ?, ?, ?)", ['sucursal', 'Fondos en la Sucursal', 0, 'branch']);
  }

  // Create codes (based on S-27c standard codes)
  const codeCount = db.exec('SELECT COUNT(*) as c FROM codes');
  if (!codeCount.length || codeCount[0].values[0][0] === 0) {
    const codes = [
      // Income codes
      ['DC', 'Donación en Caja de Contribuciones', 'income'],
      ['DB', 'Donación por Transferencia Bancaria', 'income'],
      ['DE', 'Donación Electrónica (jw.org)', 'income'],
      ['DO', 'Donación para Obra Mundial (remesa)', 'income'],
      ['DK', 'Donación para Salones del Reino', 'income'],
      ['DA', 'Donación para Asambleas', 'income'],
      ['OI', 'Otros Ingresos', 'income'],
      ['IC', 'Intereses Bancarios', 'income'],
      // Expense codes
      ['RE', 'Remesa a la Sucursal (TO-62)', 'expense'],
      ['GS', 'Gastos de Servicio (predicación)', 'expense'],
      ['GL', 'Gastos de Local (Salón del Reino)', 'expense'],
      ['GM', 'Gastos de Mantenimiento', 'expense'],
      ['GA', 'Gastos Administrativos', 'expense'],
      ['GC', 'Gastos de Circuito/Asamblea', 'expense'],
      ['OT', 'Otros Gastos', 'expense'],
      // Transfer codes
      ['TC', 'Transferencia de Banco a Caja', 'transfer'],
      ['TB', 'Transferencia de Caja a Banco', 'transfer'],
      ['TF', 'Transferencia a Fondos Sucursal', 'transfer'],
    ];
    const seen = new Set();
    for (const [code, desc, cat] of codes) {
      if (!seen.has(code)) {
        db.run("INSERT OR IGNORE INTO codes (code, description, category) VALUES (?, ?, ?)", [code, desc, cat]);
        seen.add(code);
      }
    }
    // Custom codes used by some congregations
    db.run("INSERT OR IGNORE INTO codes (code, description, category) VALUES (?, ?, ?)", ['OR', 'Donaciones obra mundial', 'income']);
    db.run("INSERT OR IGNORE INTO codes (code, description, category) VALUES (?, ?, ?)", ['C', 'Donaciones (Gastos de la congregación)', 'income']);
    db.run("INSERT OR IGNORE INTO codes (code, description, category) VALUES (?, ?, ?)", ['G', 'Gastos de la congregación', 'expense']);
  }

  db.run(`INSERT OR IGNORE INTO config (key, value) VALUES ('congregacion', '')`);
  db.run(`INSERT OR IGNORE INTO config (key, value) VALUES ('ciudad', '')`);
  db.run(`INSERT OR IGNORE INTO config (key, value) VALUES ('provincia', '')`);
  db.run(`INSERT OR IGNORE INTO config (key, value) VALUES ('servicio_year', '')`);

  saveDB();
  return db;
}

function getDB() { return db; }

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

module.exports = { initDB, getDB, query, get, run, transaction, saveDB, flushToBlob, getLoadState, IS_VERCEL };
