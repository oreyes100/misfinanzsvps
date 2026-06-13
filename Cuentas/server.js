const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { initDB, query, get, run, transaction, saveDB, flushToBlob, IS_VERCEL } = require('./database');
const { parseDate, detectCategory, suggestFromOCR, extractAmountCandidates } = require('./receipt-parser');

const app = express();
const PORT = process.env.PORT || 3002;

let dbReady = false;
let bootPromise = null;

/** Inicializa BD + siembra. Idempotente y cacheado (clave en serverless). */
function boot() {
  if (bootPromise) return bootPromise;
  bootPromise = initDB().then(async () => {
    recalcBalances();
    // Códigos del modelo contable de la congregación (según hoja de cuentas).
    // Siembra de una sola vez: si se ejecutara en cada arranque, resucitaría
    // códigos eliminados por el usuario y pisaría sus ediciones.
    const seeded = get("SELECT value FROM config WHERE key='codes_seed_v2'");
    if (!seeded) {
      run("INSERT OR IGNORE INTO codes (code, description, category) VALUES (?, ?, ?)", ['OM', 'Donación para la obra mundial', 'income']);
      run("INSERT OR IGNORE INTO codes (code, description, category) VALUES (?, ?, ?)", ['C', 'Donaciones para la congregación', 'income']);
      run("INSERT OR IGNORE INTO codes (code, description, category) VALUES (?, ?, ?)", ['D', 'Depósito en la caja de efectivo', 'transfer']);
      run("INSERT OR IGNORE INTO codes (code, description, category) VALUES (?, ?, ?)", ['OV', 'Orador visitante / discursante', 'expense']);
      run("INSERT OR IGNORE INTO codes (code, description, category) VALUES (?, ?, ?)", ['G', 'Gastos de la congregación', 'expense']);
      run("INSERT OR IGNORE INTO codes (code, description, category) VALUES (?, ?, ?)", ['SOM', 'Obra mundial (de la caja)', 'expense']);
      run("INSERT OR IGNORE INTO codes (code, description, category) VALUES (?, ?, ?)", ['ROM', 'Obra mundial (resolución)', 'expense']);
      run("UPDATE codes SET category='income', description='Donaciones para la congregación' WHERE code='C'");
      run("DELETE FROM codes WHERE code='OR' AND NOT EXISTS (SELECT 1 FROM transactions WHERE code='OR')");
      run("INSERT INTO config (key, value) VALUES ('codes_seed_v2', '1')");
    }
    // Cuentas según las columnas de la hoja S-26:
    //   caja → RECIBIDO (donaciones) · corriente → CUENTA PRINCIPAL (caja de dinero) · sucursal → CUENTA SECUNDARIA
    run("UPDATE accounts SET name='Recibido (Donaciones)' WHERE id='caja'");
    run("UPDATE accounts SET name='Cuenta Principal (Caja de dinero)' WHERE id='corriente'");
    run("UPDATE accounts SET name='Cuenta Secundaria' WHERE id='sucursal'");
    run("INSERT OR IGNORE INTO config (key, value) VALUES ('ai_api_key', '')");
    saveDB();
    await flushToBlob(); // persiste la siembra en la nube en el primer arranque
    dbReady = true;
  });
  return bootPromise;
}

// En local arrancamos el servidor HTTP. En Vercel se exporta el app (ver api/index.js).
if (!IS_VERCEL) {
  boot().then(() => {
    const server = app.listen(PORT, () => console.log(`Servidor corriendo en http://localhost:${PORT}`));
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`⚠ El puerto ${PORT} ya está ocupado: el servidor ya estaba corriendo.`);
        console.error(`  Abra http://localhost:${PORT} o cierre la otra instancia con: lsof -ti:${PORT} | xargs kill`);
        process.exit(1);
      }
      throw err;
    });
  });
}

// Middleware serverless (primero): garantiza BD lista antes de cada request y,
// al terminar la respuesta, persiste la BD a Blob si hubo cambios.
app.use(async (req, res, next) => {
  try {
    await boot();
  } catch (e) {
    return res.status(500).json({ error: 'Init BD: ' + e.message });
  }
  if (IS_VERCEL) {
    // Persistir a Blob DESPUÉS de enviar la respuesta, pero manteniendo viva la
    // lambda con waitUntil hasta que el PUT termine (si no, la función se congela
    // antes de completar la escritura y se pierde el cambio).
    let flushed = false;
    const done = new Promise((resolve) => {
      const doFlush = async () => { if (flushed) return; flushed = true; try { await flushToBlob(); } finally { resolve(); } };
      res.on('finish', doFlush);
      res.on('close', doFlush);
    });
    try { require('@vercel/functions').waitUntil(done); } catch { /* fallback: best-effort */ }
  }
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
// En local los recibos se sirven del disco; en Vercel viven en Vercel Blob (URL propia).
if (!IS_VERCEL) app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// En Vercel el filesystem es de solo lectura → guardar el archivo en memoria y subirlo a Blob.
// En local se mantiene el disco para no romper el flujo de OCR existente.
const storage = IS_VERCEL
  ? multer.memoryStorage()
  : multer.diskStorage({
      destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
      // path.basename evita traversal; se normalizan caracteres problemáticos del nombre original
      filename: (req, file, cb) => cb(null, Date.now() + '-' + path.basename(file.originalname).replace(/[^\w.\- ]/g, '_')),
    });
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  // Solo imágenes y PDF: el OCR no procesa otra cosa y evita subir ejecutables
  fileFilter: (req, file, cb) => {
    const ok = /^(image\/(jpe?g|png|webp|heic)|application\/pdf)$/.test(file.mimetype);
    cb(ok ? null : new Error('Tipo de archivo no permitido (solo imágenes o PDF)'), ok);
  }
});

function getServiceYear(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  const m = d.getMonth() + 1;
  const y = d.getFullYear();
  return m >= 9 ? `${y}/${y + 1}` : `${y - 1}/${y}`;
}

function recalcBalances() {
  const accounts = query('SELECT id FROM accounts');
  for (const acc of accounts) {
    const income = get("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE account=? AND type IN ('income','transfer_in')", [acc.id]);
    const expense = get("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE account=? AND type IN ('expense','transfer')", [acc.id]);
    const bal = (income ? income.t : 0) - (expense ? expense.t : 0);
    run('UPDATE accounts SET balance=? WHERE id=?', [bal, acc.id]);
  }
}

// === CONFIG ===
app.get('/api/config', (req, res) => {
  const rows = query('SELECT * FROM config');
  const cfg = {};
  for (const r of rows) cfg[r.key] = r.value;
  res.json(cfg);
});

app.post('/api/config', (req, res) => {
  const { congregacion, ciudad, provincia, ai_api_key } = req.body;
  if (congregacion !== undefined) run("UPDATE config SET value=? WHERE key='congregacion'", [congregacion]);
  if (ciudad !== undefined) run("UPDATE config SET value=? WHERE key='ciudad'", [ciudad]);
  if (provincia !== undefined) run("UPDATE config SET value=? WHERE key='provincia'", [provincia]);
  if (ai_api_key !== undefined) {
    run("INSERT OR IGNORE INTO config (key, value) VALUES ('ai_api_key', '')");
    run("UPDATE config SET value=? WHERE key='ai_api_key'", [ai_api_key.trim()]);
  }
  saveDB();
  res.json({ success: true });
});

// === ACCOUNTS ===
app.get('/api/accounts', (req, res) => {
  res.json(query('SELECT * FROM accounts'));
});

// === TRANSACTIONS ===
app.get('/api/transactions', (req, res) => {
  const { limit, offset, account, type, code, startDate, endDate } = req.query;
  let sql = 'SELECT * FROM transactions WHERE 1=1';
  const p = [];
  if (account) { sql += ' AND account=?'; p.push(account); }
  if (type) { sql += ' AND type=?'; p.push(type); }
  if (code) { sql += ' AND code=?'; p.push(code); }
  if (startDate) { sql += ' AND date>=?'; p.push(startDate); }
  if (endDate) { sql += ' AND date<=?'; p.push(endDate); }
  sql += ' ORDER BY date DESC, id DESC';
  if (limit) { sql += ' LIMIT ?'; p.push(parseInt(limit)); }
  if (offset) { sql += ' OFFSET ?'; p.push(parseInt(offset)); }
  const transactions = query(sql, p);
  const total = get('SELECT COUNT(*) as c FROM transactions');
  res.json({ transactions, total: total ? total.c : 0 });
});

app.post('/api/transactions', (req, res) => {
  const { date, description, code, amount, type, account, from_account, to_account, receipt_text } = req.body;
  if (!date || !description || !code || amount === undefined || !type) {
    return res.status(400).json({ error: 'Faltan campos requeridos' });
  }
  const sy = getServiceYear(date);
  try {
    transaction(() => {
      if (type === 'transfer') {
        if (!from_account || !to_account) throw new Error('Transferencia requiere origen y destino');
        run("INSERT INTO transactions (date,description,code,amount,type,account,from_account,to_account,receipt_text,service_year) VALUES (?,?,?,?,'transfer',?,?,?,?,?)",
          [date, description, code, amount, from_account, from_account, to_account, receipt_text || null, sy]);
        run("INSERT INTO transactions (date,description,code,amount,type,account,from_account,to_account,receipt_text,service_year) VALUES (?,?,?,?,'transfer_in',?,?,?,?,?)",
          [date, description + ' (Transferencia recibida)', code, amount, to_account, from_account, to_account, null, sy]);
      } else {
        run("INSERT INTO transactions (date,description,code,amount,type,account,receipt_text,service_year) VALUES (?,?,?,?,?,?,?,?)",
          [date, description, code, amount, type, account, receipt_text || null, sy]);
      }
      recalcBalances();
    });
    res.status(201).json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/transactions/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const existing = get('SELECT * FROM transactions WHERE id=?', [id]);
  if (!existing) return res.status(404).json({ error: 'Transacción no encontrada' });
  const { date, description, code, amount, type, account } = req.body;
  if (!date || !description || !code || amount === undefined || !type || !account) {
    return res.status(400).json({ error: 'Faltan campos requeridos' });
  }
  const sy = getServiceYear(date);
  try {
    transaction(() => {
      // Si era un traspaso, sincronizar también la contraparte
      if (existing.type === 'transfer' || existing.type === 'transfer_in') {
        const pairType = existing.type === 'transfer' ? 'transfer_in' : 'transfer';
        const pair = get(
          'SELECT id FROM transactions WHERE type=? AND date=? AND code=? AND amount=? AND COALESCE(from_account,"")=COALESCE(?,"") AND COALESCE(to_account,"")=COALESCE(?,"") LIMIT 1',
          [pairType, existing.date, existing.code, existing.amount, existing.from_account, existing.to_account]
        );
        if (pair) {
          run('UPDATE transactions SET date=?, code=?, amount=?, service_year=? WHERE id=?',
            [date, code, amount, sy, pair.id]);
        }
      }
      run('UPDATE transactions SET date=?, description=?, code=?, amount=?, type=?, account=?, service_year=? WHERE id=?',
        [date, description, code, amount, type, account, sy, id]);
      recalcBalances();
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/transactions/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const existing = get('SELECT * FROM transactions WHERE id=?', [id]);
  if (!existing) return res.status(404).json({ error: 'Transacción no encontrada' });
  try {
    transaction(() => {
      run('DELETE FROM transactions WHERE id=?', [id]);
      // Un traspaso se guarda como par (transfer + transfer_in):
      // al borrar una mitad se borra también su contraparte.
      if (existing.type === 'transfer' || existing.type === 'transfer_in') {
        const pairType = existing.type === 'transfer' ? 'transfer_in' : 'transfer';
        const pair = get(
          'SELECT id FROM transactions WHERE type=? AND date=? AND code=? AND amount=? AND COALESCE(from_account,"")=COALESCE(?,"") AND COALESCE(to_account,"")=COALESCE(?,"") LIMIT 1',
          [pairType, existing.date, existing.code, existing.amount, existing.from_account, existing.to_account]
        );
        if (pair) run('DELETE FROM transactions WHERE id=?', [pair.id]);
      }
      recalcBalances();
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// === UPLOAD + OCR ===
// Mindee API key (set MINDEE_API_KEY env var for production use)
// Get free API key at https://platform.mindee.com
const MINDEE_API_KEY = process.env.MINDEE_API_KEY || null;
const sharp = require('sharp');
const crypto = require('crypto');

// === INTERPRETACIÓN CON IA (visión) ===
// El OCR tradicional no puede leer cantidades manuscritas. Si hay una
// clave API configurada (Configuración → "Clave API de IA" o variable
// GEMINI_API_KEY), el recibo se interpreta con Google Gemini Flash
// (capa GRATUITA de Google AI Studio: https://aistudio.google.com/apikey)
// y el OCR local queda como respaldo.
const AI_MODEL = process.env.AI_MODEL || 'gemini-2.5-flash';

function getConfigValue(key) {
  const row = get('SELECT value FROM config WHERE key=?', [key]);
  return row ? row.value : null;
}

function getAiKey() {
  return process.env.GEMINI_API_KEY || (getConfigValue('ai_api_key') || '').trim() || null;
}

const AI_PROMPT = `Analiza esta imagen de un recibo de contabilidad de una congregación.
Normalmente es un formulario "REGISTRO DE TRANSACCIÓN" (S-24-S) con:
- una fecha (a menudo manuscrita),
- cuatro casillas: Donación, Pago, Depósito en la caja de efectivo, Adelanto de efectivo (una está marcada con palomita o X),
- líneas de partidas: "Donaciones (Obra mundial)", "Donaciones (Gastos de la congregación)" y líneas en blanco para otros conceptos, cada una con su cantidad manuscrita a la derecha,
- un TOTAL al final.

Lee con MUCHO cuidado las cantidades manuscritas (suelen llevar "$"). Verifica que la suma de las partidas coincida con el TOTAL; si no coincide, vuelve a leer las cantidades.

Responde SOLO con JSON válido, sin texto adicional:
{
  "fecha": "YYYY-MM-DD o null",
  "tipo_marcado": "donacion" | "pago" | "deposito" | "adelanto" | null,
  "partidas": [ { "descripcion": "texto de la línea", "monto": 123.45 } ],
  "total": 123.45
}
Reglas: usa null cuando un dato no se vea; NO incluyas el TOTAL como partida; NO inventes partidas; incluye solo líneas que realmente tengan cantidad.`;

async function interpretWithAI(filePath, apiKey) {
  const buf = await sharp(filePath)
    .rotate()
    .resize({ width: 1600, withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toBuffer();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${AI_MODEL}:generateContent`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'x-goog-api-key': apiKey,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      contents: [{
        parts: [
          { inline_data: { mime_type: 'image/jpeg', data: buf.toString('base64') } },
          { text: AI_PROMPT }
        ]
      }],
      generationConfig: {
        temperature: 0,
        response_mime_type: 'application/json'
      }
    })
  });
  if (!response.ok) {
    const t = await response.text();
    throw new Error(`API de IA ${response.status}: ${t.slice(0, 300)}`);
  }
  const out = await response.json();
  const textOut = ((out.candidates || [])[0]?.content?.parts || []).map(p => p.text || '').join('');
  const jsonMatch = textOut.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('La IA no devolvió JSON');
  const parsed = JSON.parse(jsonMatch[0]);
  return { text: JSON.stringify(parsed, null, 2), suggested: aiToSuggested(parsed) };
}

/** Convierte la respuesta JSON de la IA al formato de captura sugerida. */
function aiToSuggested(p) {
  let date = null;
  if (p.fecha && /^\d{4}-\d{2}-\d{2}$/.test(String(p.fecha))) date = p.fecha;
  else if (p.fecha) date = parseDate(String(p.fecha));
  if (!date) date = new Date().toISOString().slice(0, 10);

  const marked = ['donacion', 'pago', 'deposito', 'adelanto'].includes(p.tipo_marcado) ? p.tipo_marcado : null;
  const expenseMode = marked === 'pago' || marked === 'adelanto';
  const total = (typeof p.total === 'number' && p.total > 0) ? p.total : null;

  const txns = [];
  for (const it of (Array.isArray(p.partidas) ? p.partidas : [])) {
    const monto = (typeof it.monto === 'number' && it.monto > 0) ? it.monto : null;
    const desc = String(it.descripcion || '').trim();
    if (!desc && monto == null) continue;
    let cat = detectCategory(desc);
    if (cat && expenseMode && cat.type === 'income' && !/obra\s*mundial/i.test(desc)) {
      cat = { description: cat.description, type: 'expense', code: 'G' };
    }
    if (!cat) {
      if (marked === 'deposito') cat = { description: 'Depósito en la caja de efectivo', type: 'transfer', code: 'D' };
      else if (expenseMode) cat = { description: desc || 'Gasto', type: 'expense', code: 'G' };
      else cat = { description: desc || 'Donación', type: 'income', code: 'C' };
    }
    txns.push({
      amount: monto,
      description: desc || cat.description,
      type: cat.type,
      code: cat.code,
      date,
      verified: false
    });
  }

  const sum = txns.reduce((s, t) => s + (t.amount || 0), 0);
  const verified = total != null && txns.length > 0
    && txns.every(t => t.amount != null)
    && Math.abs(sum - total) < 0.011;
  if (verified) txns.forEach(t => { t.verified = true; });

  const main = txns[0] || {};
  return {
    amount: main.amount ?? null,
    description: main.description || '',
    type: main.type || 'income',
    code: main.code || null,
    multi: txns.length > 1,
    allTransactions: txns,
    date, total, verified, marked
  };
}

/**
 * Preprocess receipt image for better OCR:
 * - Grayscale, auto-contrast, sharpen, binarize threshold
 */
async function preprocessImage(inputPath) {
  const outputPath = inputPath.replace(/(\.\w+)$/, '_processed$1');
  await sharp(inputPath)
    .grayscale()
    .normalize({ lower: 5, upper: 95 })
    .sharpen({ sigma: 0.6, m1: 0.2, m2: 1 })
    .linear(1.8, -60)
    .resize({ width: 2200, withoutEnlargement: false })
    .toFile(outputPath);
  return outputPath;
}

/**
 * Recognize text via Mindee API (best for structured receipt line items)
 */
async function recognizeWithMindee(filePath) {
  if (!MINDEE_API_KEY) throw new Error('Mindee API key not configured');
  const FormData = require('form-data');
  const fs = require('fs');
  const form = new FormData();
  form.append('document', fs.createReadStream(filePath));
  const response = await fetch('https://api.mindee.net/v1/products/mindee/expense_receipts/v5/predict', {
    method: 'POST',
    headers: { 'Authorization': `Token ${MINDEE_API_KEY}` },
    body: form
  });
  if (!response.ok) throw new Error(`Mindee API error: ${response.status}`);
  return response.json();
}

/**
 * Recognize text via Tesseract.js with image preprocessing
 */
async function recognizeWithTesseract(filePath) {
  const Tesseract = require('tesseract.js');
  const processedPath = await preprocessImage(filePath);
  const { data } = await Tesseract.recognize(processedPath, 'spa', {
    tessedit_pageseg_mode: '3',
    tessedit_ocr_engine_mode: '1',
    preserve_interword_spaces: '1'
  });
  try { fs.unlinkSync(processedPath); } catch (_) {}
  return { text: data.text, hocr: data.hocr, confidence: data.confidence };
}

/**
 * Segundo pase de OCR: solo la columna derecha del recibo (las cantidades).
 * Recorta el ~42% derecho y el 70% inferior (omite fecha y núm. de recibo),
 * y reconoce únicamente dígitos y símbolos de moneda. Esto mejora mucho la
 * lectura de montos manuscritos. Devuelve los montos en orden de lectura.
 */
async function recognizeAmountsColumn(filePath) {
  const Tesseract = require('tesseract.js');
  const meta = await sharp(filePath).metadata();
  const w = meta.width || 0, h = meta.height || 0;
  if (!w || !h) return [];
  const left = Math.floor(w * 0.58);
  const top = Math.floor(h * 0.30);
  const cropPath = filePath.replace(/(\.\w+)$/, '_amounts$1');
  await sharp(filePath)
    .extract({ left, top, width: w - left, height: h - top })
    .grayscale()
    .normalize({ lower: 5, upper: 95 })
    .linear(1.6, -40)
    .resize({ width: 1200, withoutEnlargement: false })
    .toFile(cropPath);
  const { data } = await Tesseract.recognize(cropPath, 'spa', {
    tessedit_pageseg_mode: '6',
    tessedit_char_whitelist: '0123456789.,$S '
  });
  try { fs.unlinkSync(cropPath); } catch (_) {}
  const amounts = [];
  for (const line of (data.text || '').split('\n')) {
    for (const c of extractAmountCandidates(line)) amounts.push(c.val);
  }
  return amounts;
}

/**
 * Map Mindee predictions to JW receipt format
 */
function mindeeToJwFormat(pred) {
  const transactions = [];
  let date = pred.date?.value || new Date().toISOString().slice(0, 10);
  if (date && date.length === 10) {
    const [y, m, d] = date.split('-');
    date = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  } else {
    const parsed = parseDate(date);
    if (parsed) date = parsed;
  }

  const lineItems = pred.line_items || [];

  // Check if Mindee detected multiple line items
  if (lineItems.length >= 2) {
    for (const item of lineItems) {
      const amount = item.total_amount?.value || item.unit_price?.value;
      if (!amount) continue;
      const desc = (item.description?.value || '').toLowerCase();
      const cat = detectCategory(item.description?.value || '');
      if (cat) {
        transactions.push({
          amount: parseFloat(amount),
          description: cat.description,
          type: cat.type,
          code: cat.code,
          date
        });
      } else {
        // Try to categorize by description
        const isDonation = /donac|aporte|ofrenda/i.test(desc);
        transactions.push({
          amount: parseFloat(amount),
          description: item.description?.value || 'Artículo',
          type: isDonation ? 'income' : 'expense',
          code: isDonation ? 'DO' : 'G',
          date
        });
      }
    }
  }

  // Single transaction
  if (transactions.length === 0 && pred.total_amount?.value) {
    transactions.push({
      amount: parseFloat(pred.total_amount.value),
      description: pred.supplier_name?.value || 'Recibo',
      type: 'expense',
      code: 'G',
      date
    });
  }

  return transactions;
}

app.post('/api/upload-receipt', upload.single('receipt'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se subió ningún archivo' });

  // En Vercel el archivo llega en memoria: escribirlo a /tmp para que el OCR
  // (sharp/tesseract, que leen rutas) funcione, y guardarlo en Blob para servirlo.
  let blobUrl = null;
  if (IS_VERCEL) {
    const safeName = Date.now() + '-' + path.basename(req.file.originalname || 'recibo').replace(/[^\w.\- ]/g, '_');
    const tmpPath = '/tmp/' + safeName;
    fs.writeFileSync(tmpPath, req.file.buffer);
    req.file.path = tmpPath;
    req.file.filename = safeName;
    try {
      const { put } = require('@vercel/blob');
      const blob = await put('cuentas/uploads/' + safeName, req.file.buffer, {
        access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: req.file.mimetype,
      });
      blobUrl = blob.url;
    } catch (e) {
      console.warn('Subida de recibo a Blob falló:', e.message);
    }
  }

  let ocrResult = null;
  let ocrError = null;
  let useMindee = false;
  let engine = null;

  // ── 1) IA con visión (la mejor opción para manuscritos) ─────────
  const aiKey = getAiKey();
  if (aiKey) {
    try {
      ocrResult = await interpretWithAI(req.file.path, aiKey);
      engine = 'ia';
    } catch (e) {
      console.warn('IA falló, usando OCR local:', e.message);
      ocrError = 'IA: ' + e.message;
    }
  }

  // ── 2) Mindee (si está configurado) ─────────────────────────────
  if (!ocrResult && MINDEE_API_KEY) {
    try {
      const mindeeResult = await recognizeWithMindee(req.file.path);
      if (mindeeResult.document?.inference?.prediction) {
        const pred = mindeeResult.document.inference.prediction;
        const transactions = mindeeToJwFormat(pred);

        ocrResult = {
          text: JSON.stringify(pred, null, 2),
          suggested: {
            multi: transactions.length > 1,
            allTransactions: transactions,
            date: transactions.length > 0 ? transactions[0].date : null,
          }
        };
        useMindee = true;
      }
    } catch (e) {
      console.warn('Mindee OCR failed, falling back to Tesseract:', e.message);
    }
  }

  // ── 3) Respaldo: Tesseract (texto completo + pase de cantidades) ─
  if (!ocrResult) {
    try {
      const [tesseractResult, amountsCol] = await Promise.all([
        recognizeWithTesseract(req.file.path),
        recognizeAmountsColumn(req.file.path).catch(e => {
          console.warn('Pase de cantidades falló:', e.message);
          return [];
        })
      ]);
      ocrResult = {
        text: tesseractResult.text,
        suggested: suggestFromOCR(tesseractResult.text, amountsCol),
        amountsColumn: amountsCol
      };
    } catch (err) {
      ocrError = err.message;
    }
  }

  res.json({
    filename: req.file.filename,
    filepath: blobUrl || ('/uploads/' + req.file.filename),
    text: ocrResult?.text || '',
    suggested: ocrResult?.suggested || { amount: null, description: '', type: 'expense', multi: false },
    engine: engine || (useMindee ? 'mindee' : 'tesseract'),
    error: ocrError
  });
});

// === ASISTENTE IA (chat sobre las cuentas) ===
// Responde preguntas en lenguaje natural usando los datos reales de la
// contabilidad como contexto. Usa la misma clave Gemini que el OCR.
app.post('/api/ai-chat', async (req, res) => {
  const question = String(req.body.question || '').trim();
  if (!question) return res.status(400).json({ error: 'Escriba una pregunta' });
  const apiKey = getAiKey();
  if (!apiKey) return res.status(400).json({ error: 'no_key' });

  const accounts = query('SELECT id, name, balance FROM accounts');
  const codes = query('SELECT code, description, category FROM codes ORDER BY code');
  const recent = query('SELECT date, description, code, amount, type, account FROM transactions ORDER BY date DESC, id DESC LIMIT 150');
  const monthly = query("SELECT strftime('%Y-%m', date) as mes, type, ROUND(COALESCE(SUM(amount),0),2) as total FROM transactions GROUP BY mes, type ORDER BY mes");

  const sys = `Eres el asistente contable de la congregación "${getConfigValue('congregacion') || ''}". Hoy es ${new Date().toISOString().slice(0, 10)}.
Respondes en español, de forma breve, amable y precisa, sobre la contabilidad de la congregación (formularios S-26 hoja de cuentas y S-30 informe mensual de los Testigos de Jehová).
Cuentas: "caja" = Recibido (Donaciones); "corriente" = Cuenta Principal (Caja de dinero); "sucursal" = Cuenta Secundaria.
Tipos: income = entrada, expense = salida, transfer/transfer_in = traspaso entre cuentas.
DATOS REALES (JSON):
SALDOS ACTUALES: ${JSON.stringify(accounts)}
CÓDIGOS CT: ${JSON.stringify(codes)}
TOTALES POR MES Y TIPO: ${JSON.stringify(monthly)}
ÚLTIMAS TRANSACCIONES: ${JSON.stringify(recent)}
Usa SOLO estos datos para dar cifras; si un dato no está, dilo claramente. Formatea montos como $1,234.56. Puedes usar **negritas** y listas con viñetas (líneas que empiezan con "- ").`;

  const contents = [];
  for (const m of (Array.isArray(req.body.history) ? req.body.history.slice(-10) : [])) {
    if (m && m.role && m.text) {
      contents.push({ role: m.role === 'ai' ? 'model' : 'user', parts: [{ text: String(m.text).slice(0, 2000) }] });
    }
  }
  contents.push({ role: 'user', parts: [{ text: question }] });

  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${AI_MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: sys }] },
        contents,
        generationConfig: { temperature: 0.3, maxOutputTokens: 1024 }
      })
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error(`API de IA ${r.status}: ${t.slice(0, 200)}`);
    }
    const out = await r.json();
    const answer = ((out.candidates || [])[0]?.content?.parts || []).map(p => p.text || '').join('').trim();
    if (!answer) throw new Error('La IA no devolvió respuesta');
    res.json({ answer });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// === S-26 LANDING DATA ===
app.get('/api/s26-data', (req, res) => {
  const { year, month } = req.query;
  if (!year || !month) return res.status(400).json({ error: 'Se requiere año y mes' });
  const ym = `${year}-${String(month).padStart(2, '0')}`;
  const accounts = query('SELECT id FROM accounts');
  let saldoInicial = 0;
  for (const a of accounts) {
    const inc = get("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE strftime('%Y-%m',date)<? AND account=? AND type IN ('income','transfer_in')", [ym, a.id]);
    const exp = get("SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE strftime('%Y-%m',date)<? AND account=? AND type IN ('expense','transfer')", [ym, a.id]);
    saldoInicial += (inc?.t || 0) - (exp?.t || 0);
  }
  const transactions = query(
    "SELECT * FROM transactions WHERE strftime('%Y-%m',date)=? AND type!='transfer_in' ORDER BY date ASC, id ASC",
    [ym]
  );
  res.json({ saldoInicial, transactions });
});

// === CODES ===
app.get('/api/codes', (req, res) => {
  res.json(query('SELECT * FROM codes ORDER BY code'));
});

function validateCodeInput(body) {
  const code = String(body.code || '').trim().toUpperCase();
  const description = String(body.description || '').trim();
  const category = body.category;
  if (!/^[A-ZÑ0-9]{1,6}$/.test(code)) return { error: 'El código debe tener de 1 a 6 letras o números' };
  if (!description) return { error: 'La descripción es obligatoria' };
  if (!['income', 'expense', 'transfer'].includes(category)) return { error: 'Categoría inválida' };
  return { code, description, category };
}

app.post('/api/codes', (req, res) => {
  const v = validateCodeInput(req.body);
  if (v.error) return res.status(400).json({ error: v.error });
  if (get('SELECT code FROM codes WHERE code=?', [v.code])) {
    return res.status(409).json({ error: `El código ${v.code} ya existe` });
  }
  run('INSERT INTO codes (code, description, category) VALUES (?, ?, ?)', [v.code, v.description, v.category]);
  saveDB();
  res.json({ success: true, code: v.code });
});

app.put('/api/codes/:code', (req, res) => {
  const orig = String(req.params.code || '').trim().toUpperCase();
  if (!get('SELECT code FROM codes WHERE code=?', [orig])) {
    return res.status(404).json({ error: `El código ${orig} no existe` });
  }
  const v = validateCodeInput({ ...req.body, code: req.body.code || orig });
  if (v.error) return res.status(400).json({ error: v.error });
  if (v.code !== orig && get('SELECT code FROM codes WHERE code=?', [v.code])) {
    return res.status(409).json({ error: `El código ${v.code} ya existe` });
  }
  // Si se renombra el código, las transacciones que lo usan se actualizan juntas
  transaction(() => {
    run('UPDATE codes SET code=?, description=?, category=? WHERE code=?', [v.code, v.description, v.category, orig]);
    if (v.code !== orig) run('UPDATE transactions SET code=? WHERE code=?', [v.code, orig]);
  });
  res.json({ success: true, code: v.code });
});

app.delete('/api/codes/:code', (req, res) => {
  const code = String(req.params.code || '').trim().toUpperCase();
  if (!get('SELECT code FROM codes WHERE code=?', [code])) {
    return res.status(404).json({ error: `El código ${code} no existe` });
  }
  const used = get('SELECT COUNT(*) as c FROM transactions WHERE code=?', [code]);
  if (used && used.c > 0) {
    return res.status(409).json({ error: `No se puede eliminar: ${used.c} transacción(es) usan el código ${code}` });
  }
  run('DELETE FROM codes WHERE code=?', [code]);
  saveDB();
  res.json({ success: true });
});

// === MONTHLY REPORT (S-27-S) ===
// === S-30-S MONTHLY REPORT ===
app.get('/api/monthly-report', (req, res) => {
  const { year, month } = req.query;
  if (!year || !month) return res.status(400).json({ error: 'Se requiere año y mes' });

  const ym = `${year}-${String(month).padStart(2, '0')}`;
  const p = [ym];

  // Get prior month for previous balance
  const [y, m] = [parseInt(year), parseInt(month)];
  const prevDate = m === 1 ? `${y-1}-12` : `${y}-${String(m-1).padStart(2,'0')}`;

  const accounts = query('SELECT * FROM accounts');
  const byCode = query(`SELECT code, type, COALESCE(SUM(amount),0) as total, COUNT(*) as count FROM transactions WHERE strftime('%Y-%m',date)=? GROUP BY code,type ORDER BY total DESC`, p);

  // === S-30-S PAGE 1: INFORME FINANCIERO ===
  // (a) Fondos a comienzo de mes
  let fundsStartMonth = 0;
  const prevBalances = {};
  for (const a of accounts) {
    const prev = get(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE strftime('%Y-%m',date)<? AND account=? AND type IN ('income','transfer_in')`, [ym, a.id]);
    const prevExp = get(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE strftime('%Y-%m',date)<? AND account=? AND type IN ('expense','transfer')`, [ym, a.id]);
    prevBalances[a.id] = (prev ? prev.t : 0) - (prevExp ? prevExp.t : 0);
    fundsStartMonth += prevBalances[a.id];
  }

  // (b) Recibido por la congregación — desglosado por código de ingreso
  const incomeByCode = query(`SELECT code, COALESCE(SUM(amount),0) as total FROM transactions WHERE strftime('%Y-%m',date)=? AND type='income' GROUP BY code ORDER BY total DESC`, p);
  const totalReceived = incomeByCode.reduce((s, r) => s + r.total, 0);

  // (c) Gastos de la congregación — desglosado por código de gasto
  const expenseByCode = query(`SELECT code, COALESCE(SUM(amount),0) as total FROM transactions WHERE strftime('%Y-%m',date)=? AND type='expense' GROUP BY code ORDER BY total DESC`, p);
  const totalExpenses = expenseByCode.reduce((s, r) => s + r.total, 0);

  // (d) Sobrante/Déficit
  const surplus = totalReceived - totalExpenses;

  // (e) Fondos a fin de mes
  const fundsEndMonth = fundsStartMonth + surplus;

  // (f) Fondos reservados para propósitos especiales
  const reservedFunds = query(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE strftime('%Y-%m',date)=? AND code IN ('DK','DA') AND type='income'`, p);
  const totalReserved = reservedFunds && reservedFunds[0] ? reservedFunds[0].t : 0;

  // (g) Fondos disponibles
  const availableFunds = fundsEndMonth - totalReserved;

  // === S-30-S PAGE 2: CONCILIACIÓN ===
  // (h) Total fondos a comienzo de mes = (a)
  // (i) Recibido = total del mes
  // (j) Desembolsos = total expenses
  // (k) Total fondos a fin de mes

  // Verificación de conciliación por cuenta
  const incomeMap = {}; for (const r of query(`SELECT account, COALESCE(SUM(amount),0) as t FROM transactions WHERE strftime('%Y-%m',date)=? AND type IN ('income','transfer_in') GROUP BY account`, p)) incomeMap[r.account] = r.t;
  const expenseMap = {}; for (const r of query(`SELECT account, COALESCE(SUM(amount),0) as t FROM transactions WHERE strftime('%Y-%m',date)=? AND type IN ('expense','transfer') GROUP BY account`, p)) expenseMap[r.account] = r.t;

  let allReconciled = true;
  const reconcileDetails = [];
  const accountData = accounts.map(a => {
    const inc = incomeMap[a.id] || 0;
    const exp = expenseMap[a.id] || 0;
    const expected = prevBalances[a.id] + inc - exp;
    const diff = Math.abs(expected - a.balance);
    if (diff > 0.01) {
      allReconciled = false;
      reconcileDetails.push({ account: a.id, prev: prevBalances[a.id], inc, exp, expected, actual: a.balance, diff });
    }
    return { id: a.id, name: a.name, income: inc, expense: exp, balance: a.balance };
  });

  res.json({
    year, month, ym, prevDate,
    s30: {
      a_funds_start: fundsStartMonth,
      b_received: totalReceived,
      b_detail: incomeByCode,
      c_expenses: totalExpenses,
      c_detail: expenseByCode,
      d_surplus: surplus,
      e_funds_end: fundsEndMonth,
      f_reserved: totalReserved,
      g_available: availableFunds,
      h_funds_start_conciliation: fundsStartMonth,
      i_received: totalReceived,
      j_disbursed: totalExpenses,
      k_funds_end: fundsEndMonth,
    },
    accounts: accountData,
    prevBalances,
    reconciled: allReconciled,
    reconciled_msg: allReconciled
      ? 'SALDOS CONCILIADOS / LA CONTABILIDAD CERRÓ EXCELENTE'
      : 'ERROR DE CONCILIACIÓN. Revise los asientos contables.',
    byCode, reconcileDetails
  });
});

// === SERVICE YEAR SUMMARY ===
app.get('/api/service-year-summary', (req, res) => {
  const { sy } = req.query;
  if (!sy) return res.status(400).json({ error: 'Se requiere año de servicio' });
  const months = ['09', '10', '11', '12', '01', '02', '03', '04', '05', '06', '07', '08'];
  const data = [];
  for (const m of months) {
    let y = sy.split('/')[0];
    if (['01','02','03','04','05','06','07','08'].includes(m)) y = sy.split('/')[1];
    const ym = `${y}-${m}`;
    const inc = get(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE strftime('%Y-%m',date)=? AND type='income'`, [ym]);
    const exp = get(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE strftime('%Y-%m',date)=? AND type='expense'`, [ym]);
    const monthNames = { '09':'Sep','10':'Oct','11':'Nov','12':'Dic','01':'Ene','02':'Feb','03':'Mar','04':'Abr','05':'May','06':'Jun','07':'Jul','08':'Ago' };
    data.push({ month: monthNames[m], ym, income: inc ? inc.t : 0, expense: exp ? exp.t : 0 });
  }
  res.json({ service_year: sy, months: data });
});

// === RECONCILIATION CHECK ===
app.get('/api/reconcile', (req, res) => {
  const { year, month } = req.query;
  if (!year || !month) return res.status(400).json({ error: 'Se requiere año y mes' });
  const ym = `${year}-${String(month).padStart(2,'0')}`;
  const p = [ym];
  const inc = get(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE strftime('%Y-%m',date)=? AND type='income'`, p);
  const exp = get(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE strftime('%Y-%m',date)=? AND type='expense'`, p);
  const totalInc = inc ? inc.t : 0;
  const totalExp = exp ? exp.t : 0;

  const accounts = query('SELECT * FROM accounts');
  let allOk = true;
  const details = [];
  for (const a of accounts) {
    const prev = get(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE strftime('%Y-%m',date)<? AND account=? AND type IN ('income','transfer_in')`, [ym, a.id]);
    const prevExp = get(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE strftime('%Y-%m',date)<? AND account=? AND type IN ('expense','transfer')`, [ym, a.id]);
    const prevBal = (prev ? prev.t : 0) - (prevExp ? prevExp.t : 0);
    const monthInc = get(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE strftime('%Y-%m',date)=? AND account=? AND type IN ('income','transfer_in')`, [ym, a.id]);
    const monthExp = get(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE strftime('%Y-%m',date)=? AND account=? AND type IN ('expense','transfer')`, [ym, a.id]);
    const expectedBal = prevBal + (monthInc ? monthInc.t : 0) - (monthExp ? monthExp.t : 0);
    const actualBal = a.balance;
    const balDiff = Math.abs(expectedBal - actualBal);
    if (balDiff > 0.01) {
      allOk = false;
      details.push({ account: a.id, prevBal, expected: expectedBal, actual: actualBal });
    }
  }

  res.json({
    year, month, ym,
    income: totalInc, expense: totalExp, difference: totalInc - totalExp,
    reconciled: allOk,
    details
  });
});

// === SUMMARY ===
app.get('/api/summary', (req, res) => {
  const { year, month } = req.query;
  let dateFilter = '', p = [];
  if (year) {
    if (month) { dateFilter = " AND strftime('%Y-%m',date)=?"; p.push(`${year}-${String(month).padStart(2,'0')}`); }
    else { dateFilter = " AND strftime('%Y',date)=?"; p.push(year); }
  }
  const accounts = query('SELECT * FROM accounts');
  const incomeByAccount = query(`SELECT account,COALESCE(SUM(amount),0) as total FROM transactions WHERE type='income' ${dateFilter} GROUP BY account`, p);
  const expenseByAccount = query(`SELECT account,COALESCE(SUM(amount),0) as total FROM transactions WHERE type='expense' ${dateFilter} GROUP BY account`, p);
  const byCode = query(`SELECT code,type,COALESCE(SUM(amount),0) as total,COUNT(*) as count FROM transactions WHERE 1=1 ${dateFilter} GROUP BY code,type ORDER BY total DESC`, p);
  const totalIncome = incomeByAccount.reduce((s, r) => s + r.total, 0);
  const totalExpense = expenseByAccount.reduce((s, r) => s + r.total, 0);
  res.json({ accounts, incomeByAccount, expenseByAccount, byCode, totalIncome, totalExpense });
});

// === FORM DATA: S-26 Hoja de cuentas ===
app.get('/api/forms/s26', (req, res) => {
  const { year, month } = req.query;
  if (!year || !month) return res.status(400).json({ error: 'Se requiere año y mes' });
  const ym = `${year}-${String(month).padStart(2,'0')}`;
  const transactions = query(`SELECT * FROM transactions WHERE strftime('%Y-%m',date)=? ORDER BY date ASC, id ASC`, [ym]);
  const configRows = query('SELECT * FROM config');
  const cfg = {}; for (const r of configRows) cfg[r.key] = r.value;
  const accounts = query('SELECT * FROM accounts');
  const prevBalances = {};
  for (const a of accounts) {
    const p = get(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE strftime('%Y-%m',date)<? AND account=? AND type IN ('income','transfer_in')`, [ym, a.id]);
    const pe = get(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE strftime('%Y-%m',date)<? AND account=? AND type IN ('expense','transfer')`, [ym, a.id]);
    prevBalances[a.id] = (p ? p.t : 0) - (pe ? pe.t : 0);
  }
  const incomeMap = {}; for (const r of query(`SELECT account, COALESCE(SUM(amount),0) as t FROM transactions WHERE strftime('%Y-%m',date)=? AND type IN ('income','transfer_in') GROUP BY account`, [ym])) incomeMap[r.account] = r.t;
  const expenseMap = {}; for (const r of query(`SELECT account, COALESCE(SUM(amount),0) as t FROM transactions WHERE strftime('%Y-%m',date)=? AND type IN ('expense','transfer') GROUP BY account`, [ym])) expenseMap[r.account] = r.t;
  const running = {};
  for (const a of accounts) running[a.id] = prevBalances[a.id] || 0;
  const txnWithBalance = transactions.map(t => {
    const amt = t.type === 'income' || t.type === 'transfer_in' ? t.amount : -t.amount;
    running[t.account] += amt;
    return { ...t, running_balance: running[t.account] };
  });
  res.json({ year, month, ym, config: cfg, accounts, prevBalances, incomeMap, expenseMap, transactions: txnWithBalance });
});

// === FORM DATA: S-30-S ===
app.get('/api/forms/s30', (req, res) => {
  const { year, month } = req.query;
  if (!year || !month) return res.status(400).json({ error: 'Se requiere año y mes' });
  const ym = `${year}-${String(month).padStart(2,'0')}`;
  const p = [ym];
  const configRows = query('SELECT * FROM config');
  const cfg = {}; for (const r of configRows) cfg[r.key] = r.value;
  const accounts = query('SELECT * FROM accounts');
  const byCode = query(`SELECT code, type, COALESCE(SUM(amount),0) as total, COUNT(*) as count FROM transactions WHERE strftime('%Y-%m',date)=? GROUP BY code,type ORDER BY code`, p);

  let fundsStartMonth = 0;
  const prevBalances = {};
  for (const a of accounts) {
    const pr = get(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE strftime('%Y-%m',date)<? AND account=? AND type IN ('income','transfer_in')`, [ym, a.id]);
    const pe = get(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE strftime('%Y-%m',date)<? AND account=? AND type IN ('expense','transfer')`, [ym, a.id]);
    prevBalances[a.id] = (pr ? pr.t : 0) - (pe ? pe.t : 0);
    fundsStartMonth += prevBalances[a.id];
  }

  const incomeByCode = query(`SELECT code, COALESCE(SUM(amount),0) as total FROM transactions WHERE strftime('%Y-%m',date)=? AND type='income' GROUP BY code ORDER BY total DESC`, p);
  const totalReceived = incomeByCode.reduce((s, r) => s + r.total, 0);
  const expenseByCode = query(`SELECT code, COALESCE(SUM(amount),0) as total FROM transactions WHERE strftime('%Y-%m',date)=? AND type='expense' GROUP BY code ORDER BY total DESC`, p);
  const totalExpenses = expenseByCode.reduce((s, r) => s + r.total, 0);
  const surplus = totalReceived - totalExpenses;
  const fundsEndMonth = fundsStartMonth + surplus;
  const reserved = get(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE strftime('%Y-%m',date)=? AND code IN ('DK','DA') AND type='income'`, p);
  const totalReserved = reserved ? reserved.t : 0;
  const availableFunds = fundsEndMonth - totalReserved;

  // Conciliación cajas de contribuciones
  const boxWorldwide = get(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE strftime('%Y-%m',date)=? AND code='DO' AND type='income'`, p);
  const boxKingdomHalls = get(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE strftime('%Y-%m',date)=? AND code='DK' AND type='income'`, p);

  const accountData = accounts.map(a => {
    const inc = get(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE strftime('%Y-%m',date)=? AND account=? AND type IN ('income','transfer_in')`, [ym, a.id]);
    const exp = get(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE strftime('%Y-%m',date)=? AND account=? AND type IN ('expense','transfer')`, [ym, a.id]);
    return { id: a.id, name: a.name, income: inc ? inc.t : 0, expense: exp ? exp.t : 0, balance: a.balance, prev: prevBalances[a.id] };
  });

  res.json({
    year, month, ym, config: cfg,
    a: fundsStartMonth, b: totalReceived, b_detail: incomeByCode,
    c: totalExpenses, c_detail: expenseByCode,
    d: surplus, e: fundsEndMonth,
    f: totalReserved, g: availableFunds,
    h: fundsStartMonth, i: totalReceived,
    j: totalExpenses, k: fundsEndMonth,
    box_worldwide: boxWorldwide ? boxWorldwide.t : 0,
    box_kingdom: boxKingdomHalls ? boxKingdomHalls.t : 0,
    accounts: accountData, byCode
  });
});

// === S-30-S EN PDF OFICIAL ===
// Llena el formulario oficial S-30_S.pdf (AcroForm) con los datos del mes.
// Los traspasos/depósitos (D) NO cuentan como ingreso ni gasto.
app.get('/api/forms/s30/pdf', async (req, res) => {
  let PDFDocument;
  try { ({ PDFDocument } = require('pdf-lib')); }
  catch (_) {
    return res.status(500).json({ error: "Falta el paquete pdf-lib: cierre el servidor, ejecute 'npm install' en la carpeta del programa y reinicie (start.command lo hace automáticamente)." });
  }
  try {
    const { year, month } = req.query;
    if (!year || !month) return res.status(400).json({ error: 'Se requiere año y mes' });
    const ym = `${year}-${String(month).padStart(2, '0')}`;
    const monthNames = ['', 'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
    const mName = monthNames[parseInt(month)] || month;
    const cfgRows = query('SELECT * FROM config');
    const cfg = {}; for (const r of cfgRows) cfg[r.key] = r.value;

    // (a) Fondos al comienzo del mes (saldo de todas las cuentas)
    let fundsStart = 0;
    for (const a of query('SELECT id FROM accounts')) {
      const pi = get(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE strftime('%Y-%m',date)<? AND account=? AND type IN ('income','transfer_in')`, [ym, a.id]);
      const pe = get(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE strftime('%Y-%m',date)<? AND account=? AND type IN ('expense','transfer')`, [ym, a.id]);
      fundsStart += (pi ? pi.t : 0) - (pe ? pe.t : 0);
    }

    const codeDesc = {}; for (const c of query('SELECT * FROM codes')) codeDesc[c.code] = c.description;
    const incRows = query(`SELECT code, COALESCE(SUM(amount),0) as total FROM transactions WHERE strftime('%Y-%m',date)=? AND type='income' GROUP BY code`, [ym]);
    const expRows = query(`SELECT code, COALESCE(SUM(amount),0) as total FROM transactions WHERE strftime('%Y-%m',date)=? AND type='expense' GROUP BY code`, [ym]);
    const inc = {}; for (const r of incRows) inc[r.code] = r.total;
    const exp = {}; for (const r of expRows) exp[r.code] = r.total;
    const take = (obj, codes) => codes.reduce((s, c) => { const v = obj[c] || 0; delete obj[c]; return s + v; }, 0);

    // INGRESOS
    const recCajas = take(inc, ['C', 'DC']);
    const recElectronicas = take(inc, ['DE', 'DB']);
    const omCajas = take(inc, ['OM', 'DO']);
    const dk = take(inc, ['DK']);
    const da = take(inc, ['DA']);
    const otherIncome = Object.entries(inc).filter(([, v]) => v > 0); // resto → líneas libres de "Recibido"
    const freeRec = otherIncome.slice(0, 2);
    const freeRecRest = otherIncome.slice(2).reduce((s, [, v]) => s + v, 0);
    const b = recCajas + recElectronicas + freeRec.reduce((s, [, v]) => s + v, 0) + freeRecRest;
    const otrosIngresosLineas = [];
    if (dk > 0) otrosIngresosLineas.push(['Donaciones para Salones del Reino (DK)', dk]);
    if (da > 0) otrosIngresosLineas.push(['Donaciones para Asambleas (DA)', da]);
    const c = omCajas + dk + da;
    const d = b + c;

    // DESEMBOLSOS
    const gastosSalon = take(exp, ['G', 'GL', 'GM']);
    const resolucionOM = take(exp, ['ROM']);
    const omDesembolso = take(exp, ['SOM', 'RE']);
    const otherExp = Object.entries(exp).filter(([, v]) => v > 0).sort((x, y) => y[1] - x[1]);
    const freeExp = otherExp.slice(0, 5);
    const freeExpRest = otherExp.slice(5).reduce((s, [, v]) => s + v, 0);
    const e = gastosSalon + resolucionOM + freeExp.reduce((s, [, v]) => s + v, 0) + freeExpRest;
    const f = omDesembolso;
    const g = e + f;
    const h = d - g;
    const i = fundsStart + h;

    // Fondos reservados (acumulado hasta el fin del mes)
    const resDK = get(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE strftime('%Y-%m',date)<=? AND code='DK' AND type='income'`, [ym]);
    const resDA = get(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE strftime('%Y-%m',date)<=? AND code='DA' AND type='income'`, [ym]);
    const jDK = resDK ? resDK.t : 0, jDA = resDA ? resDA.t : 0;
    const j = jDK + jDA;
    const k = i - j;

    const bytes = fs.readFileSync(path.join(__dirname, 'S-30_S.pdf'));
    const doc = await PDFDocument.load(bytes);
    const form = doc.getForm();
    const set = (name, val) => { try { form.getTextField(name).setText(val == null ? '' : String(val)); } catch (_) {} };
    const money = v => (v || v === 0) ? Number(v).toFixed(2) : '';
    const moneyNZ = v => v ? Number(v).toFixed(2) : '';
    const label = code => `${codeDesc[code] || code} (${code})`;

    // Página 1
    set('900_1_Text', cfg.congregacion || '');
    set('900_2_Text', `${mName} de ${year}`);
    set('901_1_S30_Value', money(fundsStart));
    set('901_2_S30_Value', moneyNZ(recCajas));
    set('901_3_S30_Value', moneyNZ(recElectronicas));
    if (freeRec[0]) { set('900_3_Text', label(freeRec[0][0])); set('901_4_S30_Value', moneyNZ(freeRec[0][1])); }
    if (freeRec[1] || freeRecRest) {
      set('900_4_Text', freeRec[1] ? label(freeRec[1][0]) : 'Otros ingresos');
      set('901_5_S30_Value', moneyNZ((freeRec[1] ? freeRec[1][1] : 0) + freeRecRest));
    }
    set('901_6_S30_Total', money(b));
    set('901_7_S30_Value', moneyNZ(omCajas));
    if (otrosIngresosLineas[0]) { set('900_5_Text', otrosIngresosLineas[0][0]); set('901_8_S30_Value', moneyNZ(otrosIngresosLineas[0][1])); }
    if (otrosIngresosLineas[1]) { set('900_6_Text', otrosIngresosLineas[1][0]); set('901_9_S30_Value', moneyNZ(otrosIngresosLineas[1][1])); }
    set('901_10_S30_Total', money(c));
    set('901_11_S30_Total', money(d));
    set('901_12_S30_Value', moneyNZ(gastosSalon));
    set('901_13_S30_Value', moneyNZ(resolucionOM));
    const expFields = [['900_7_Text', '901_14_S30_Value'], ['900_8_Text', '901_15_S30_Value'], ['900_9_Text', '901_16_S30_Value'], ['900_10_Text', '901_17_S30_Value'], ['900_11_Text', '901_18_S30_Value']];
    freeExp.forEach(([code, v], idx) => {
      if (expFields[idx]) { set(expFields[idx][0], label(code)); set(expFields[idx][1], moneyNZ(v)); }
    });
    if (freeExpRest && expFields[freeExp.length]) {
      set(expFields[freeExp.length][0], 'Otros gastos');
      set(expFields[freeExp.length][1], moneyNZ(freeExpRest));
    }
    set('901_19_S30_Total', money(e));
    set('901_20_S30_Value', moneyNZ(omDesembolso));
    set('901_23_S30_Total', money(f));
    set('901_24_S30_Total', money(g));
    set('901_25_S30_Total', money(h));
    set('901_26_S30_Total', money(i));
    if (jDK) { set('900_14_Text', 'Salones del Reino (DK)'); set('901_27_S30_Value', moneyNZ(jDK)); }
    if (jDA) { set('900_15_Text', 'Asambleas (DA)'); set('901_28_S30_Value', moneyNZ(jDA)); }
    set('901_29_S30_Total', money(j));
    set('901_30_S30_Total', money(k));

    // Página 2 — anuncio mensual
    set('900_17_Text_C', `${mName} de ${year}`);
    set('901_31_S30_Total', money(b));
    set('901_32_S30_Total', money(e));
    set('901_33_S30_Total', money(i));
    set('901_34_S30_Total', money(f));

    try { form.updateFieldAppearances(); } catch (_) {}
    const out = await doc.save();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="S-30-S ${ym}.pdf"`);
    res.send(Buffer.from(out));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === FORM DATA: S-25c Auditoría ===
app.get('/api/forms/s25c', (req, res) => {
  const { year, quarter } = req.query;
  if (!year || !quarter) return res.status(400).json({ error: 'Se requiere año y trimestre' });
  const qMonths = { 1: ['09','10','11'], 2: ['12','01','02'], 3: ['03','04','05'], 4: ['06','07','08'] };
  const months = qMonths[quarter];
  if (!months) return res.status(400).json({ error: 'Trimestre inválido (1-4)' });
  const ranges = months.map(m => {
    let y = parseInt(year);
    if (['01','02'].includes(m) && quarter === 2) y++;
    if (['06','07','08'].includes(m) && quarter === 4) y++;
    return `${y}-${m}`;
  });
  const configRows = query('SELECT * FROM config');
  const cfg = {}; for (const r of configRows) cfg[r.key] = r.value;
  const accounts = query('SELECT * FROM accounts');
  const monthData = ranges.map(ym => {
    const inc = get(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE strftime('%Y-%m',date)=? AND type='income'`, [ym]);
    const exp = get(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE strftime('%Y-%m',date)=? AND type='expense'`, [ym]);
    const byCode = query(`SELECT code, COALESCE(SUM(amount),0) as total FROM transactions WHERE strftime('%Y-%m',date)=? AND type='income' GROUP BY code ORDER BY total DESC`, [ym]);
    const byExpCode = query(`SELECT code, COALESCE(SUM(amount),0) as total FROM transactions WHERE strftime('%Y-%m',date)=? AND type='expense' GROUP BY code ORDER BY total DESC`, [ym]);
    return { ym, income: inc ? inc.t : 0, expense: exp ? exp.t : 0, incomeByCode: byCode, expenseByCode: byExpCode };
  });
  const totalIncome = monthData.reduce((s, m) => s + m.income, 0);
  const totalExpense = monthData.reduce((s, m) => s + m.expense, 0);

  // Check if a previous audit exists
  const prevEnd = get(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE date<? AND type IN ('income','transfer_in')`, [ranges[0]]);
  const prevEndExp = get(`SELECT COALESCE(SUM(amount),0) as t FROM transactions WHERE date<? AND type IN ('expense','transfer')`, [ranges[0]]);
  const fundsAtStart = (prevEnd ? prevEnd.t : 0) - (prevEndExp ? prevEndExp.t : 0);
  const fundsAtEnd = fundsAtStart + totalIncome - totalExpense;

  res.json({ year, quarter, months: ranges, config: cfg, accounts, monthData, totalIncome, totalExpense, fundsAtStart, fundsAtEnd });
});

app.get('/api/health', (req, res) => { res.json({ status: 'ok', dbReady: !!dbReady, runtime: IS_VERCEL ? 'vercel' : 'local' }); });

// Vercel (preset Express) usa este export como handler: debe ser una función/servidor.
// El middleware de boot al inicio del app hace que sea autónomo en serverless.
module.exports = app;
