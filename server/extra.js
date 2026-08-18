// extra.js — Port local de los endpoints "extra" que vivían en Vercel Functions,
// usando el motor SQLite local en vez de Vercel Blob.
//
//   /api/google-import   — importa imágenes de Drive (pública) / Drive (OAuth) / Photos,
//                              clasifica con IA y guarda batches.
//   /api/google-auth     — OAuth2 de Google (Drive/Photos).
//   /api/telegram        — webhook del bot de recibos (foto → IA → propuesta con botones).
//   /api/telegram-config — vincula chat_id + token del bot, test, registro de webhook.
//
// Dependencias externas (se configuran en el entorno o desde la UI, igual que en Vercel):
//   GEMINI_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY  (clasificación IA)
//   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET            (OAuth Drive/Photos)
//   TELEGRAM_WEBHOOK_SECRET                            (firma del webhook; opcional por chat)
//
// Artefactos "no finanzas" (batches, tokens de Google, bindings/proposals de Telegram)
// se guardan en FS local bajo server/data/blobs/, espejo de las claves de Vercel Blob.
// El estado sincronizado sigue viviendo en SQLite (sync_docs).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getSyncDoc, putSyncDoc, DATA_DIR } from "./db.mjs";
import { mergeStates } from "../api/_merge.js";
import { classifyImage } from "../lib/ai.js";
import { ocrImage } from "./hermes/ocr.mjs";
import { parseOcrText } from "./hermes/local.mjs";
import { sendMessage, answerCallbackQuery, editMessageReplyMarkup, getFile, downloadFile, inlineKeyboard, registerWebhook, webhookInfo } from "../lib/telegram.js";

const BLOB_DIR = path.join(DATA_DIR, "blobs");
const SYNC_CODE_RE = /^[a-z0-9-]{16,64}$/i;
const MAX_BYTES = 1_000_000;
const IMG_MIME = /^(image\/(jpe?g|png|webp|gif|heic|heif)|application\/pdf)$/i;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const SCOPES = { drive: "https://www.googleapis.com/auth/drive.readonly", photos: "https://www.googleapis.com/auth/photoslibrary.readonly" };
const TYPE_LABEL = { receipt: "Recibo", statement: "Estado de cuenta", transfer: "Transferencia" };

function uid() { return Math.random().toString(36).slice(2, 12); }
function b64(b) { return Buffer.from(b).toString("base64"); }
function validSyncCode(code) { return SYNC_CODE_RE.test(String(code || "")); }
function appOrigin(req) { return `${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host || req.headers["x-forwarded-host"]}`; }
function inferMime(name) {
  const ext = String(name || "").split(".").pop().toLowerCase();
  const map = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", heic: "image/heic", heif: "image/heif", pdf: "application/pdf" };
  return map[ext] || null;
}
function isImageMime(mime, name) {
  if (/^image\/(jpe?g|png|webp|gif|heic|heif)$/.test(mime || "")) return true;
  if (mime === "application/pdf") return true;
  return /\.(jpe?g|png|webp|gif|heic|heif|pdf)$/i.test(name || "");
}

// ---------- KV local (espejo de Vercel Blob) ----------
function keyPath(key) { return path.join(BLOB_DIR, key); }
async function kvReadJSON(key) {
  const p = keyPath(key);
  try { return JSON.parse(await readFile(p, "utf8")); } catch { return null; }
}
async function kvWriteJSON(key, data) {
  const p = keyPath(key);
  const payload = JSON.stringify(data);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, payload, "utf8");
  return true;
}
const batchKey = (code, id) => `ai-batches/${code}/${id}.json`;
const tokensKey = (code) => `google-tokens/${String(code).toLowerCase()}.json`;
const bindingKey = (chatId) => `telegram/bindings/${String(chatId).replace(/[^0-9-]/g, "")}.json`;
const proposalKey = (chatId, msgId) => `telegram/proposals/${String(chatId).replace(/[^0-9-]/g, "")}/${msgId}.json`;

// ---------- Sync state local (SQLite) ----------
function loadSyncState(db, code) { const doc = getSyncDoc(db, code); return doc && doc.state ? doc.state : null; }
async function updateSyncState(db, code, mutate) {
  const doc = getSyncDoc(db, code);
  const prevState = doc && doc.state ? doc.state : null;
  const base = prevState || { settings: {}, accounts: [], assets: {}, transactions: [], scheduled: [], categories: [], transferAliases: {}, categoryAliases: {}, statementPatterns: {} };
  const next = mutate(structuredClone(base));
  if (!next || typeof next !== "object") throw new Error("Mutación inválida");
  const merged = prevState ? mergeStates(prevState, next) : next;
  const payload = JSON.stringify({ state: merged, updatedAt: Date.now() });
  if (Buffer.byteLength(payload) > MAX_BYTES) throw new Error("Estado demasiado grande");
  putSyncDoc(db, code, merged, Date.now());
  return merged;
}

// ---------- Primitivas contables (copiadas de lib/state-store.js, puras) ----------
function classifyCategory(description, list) {
  const d = String(description || "").toLowerCase(); let best = { cat: "Otros", score: 0 };
  for (const c of (Array.isArray(list) ? list : [])) {
    const score = (c.keywords || []).reduce((s, w) => (w && d.includes(w) ? s + w.length : s), 0);
    if (score > best.score) best = { cat: c.name, score };
  }
  return best.cat;
}
function normalizeCategory(category, description, list) {
  const L = Array.isArray(list) ? list : [];
  if (category && L.some((c) => c.name === category)) return category;
  return classifyCategory(description, L);
}
function addProposedTransactions(state, rows) {
  if (!Array.isArray(rows) || !rows.length) return state;
  const categories = state.categories || [];
  let accounts = Array.isArray(state.accounts) ? state.accounts : [];
  const added = [];
  for (const r of rows) {
    const acc = accounts.find((a) => a.id === r.accountId);
    if (!acc || r.transfer) continue;
    const signed = r.direction === "in" ? Math.abs(+r.amount || 0) : -Math.abs(+r.amount || 0);
    if (signed === 0) continue;
    const tx = { id: uid(), date: r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : new Date().toISOString().slice(0, 10), description: String(r.description || "Movimiento").slice(0, 80), amount: Math.round(signed * 100) / 100, currency: ["EUR", "USD", "MXN", "GBP", "BTC", "ETH"].includes(r.currency) ? r.currency : (acc.currency || "EUR"), category: normalizeCategory(r.category, r.description, categories), accountId: acc.id, _updatedAt: Date.now() };
    if (r.notes) tx.notes = String(r.notes).slice(0, 200);
    if (r.auto) tx.auto = true;
    added.push(tx);
    accounts = accounts.map((a) => (a.id === acc.id ? { ...a, balance: Math.round((a.balance + tx.amount) * 100) / 100, _updatedAt: Date.now() } : a));
  }
  if (!added.length) return state;
  return { ...state, accounts, transactions: [...(state.transactions || []), ...added] };
}
function learnAccountAliases(state, hints, accountId) {
  if (!hints || !accountId) return state;
  const transferAliases = { ...(state.transferAliases || {}) };
  let changed = false;
  for (const hint of (Array.isArray(hints) ? hints : [hints])) {
    const key = String(hint || "").toLowerCase().trim();
    if (key && transferAliases[key] !== accountId) { transferAliases[key] = accountId; changed = true; }
  }
  if (!changed) return state;
  return { ...state, transferAliases };
}
function sanitizeBinding(b) {
  if (!b) return null;
  return { chatId: b.chatId, syncCode: b.syncCode, enabled: !!b.enabled, hasToken: !!b.botToken, aiProvider: b.aiProvider || "gemini", useAiServerKey: !!b.aiServerKey, defaultAccountId: b.defaultAccountId || null, registered: !!b.registered, webhookUrl: b.webhookUrl || null };
}
function buildSummary(result) {
  return { key: result.key, name: result.name, error: result.error, aiCode: result.aiCode, engine: result.engine, type: result.engine === "skipped" ? undefined : result.result?.type, date: result.result?.date || null, merchant: result.result?.merchant || null, total: result.result?.total || null, currency: result.result?.currency || null, description: result.result?.transactions?.[0]?.description || null, accountName: result.result?.accountName || null, accountId: result.result?.accountId || null, accountConfident: result.result?.accountConfident ?? false, confidence: result.result?.confidence ?? null, txCount: result.result?.transactions?.length || 0, accountHints: result.result?.accountHints || [], transactions: (result.result?.transactions || []).map((t) => ({ description: t.description, amount: t.amount, direction: t.direction, category: t.category, date: t.date })) };
}

// ---------- Google Drive / Photos listing ----------
function driveFolderId(urlOrId) { const s = String(urlOrId || ""); const m = s.match(/drive\.google\.com\/(?:drive\/)?folders\/([A-Za-z0-9_-]{6,})/); return m ? m[1] : (s.indexOf("/") === -1 ? s : null); }
async function listDrivePublic(folderUrlOrId) {
  const id = driveFolderId(folderUrlOrId);
  if (!id) throw new Error("No pude leer el ID de la carpeta de Drive (revisa el enlace)");
  const html = await fetch(`https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(id)}#list`, { headers: { "User-Agent": "Mozilla/5.0" } }).then((r) => r.text());
  const ids = [...html.matchAll(/data-id="([A-Za-z0-9_-]{20,})"/g)].map((m) => m[1]);
  const names = [...html.matchAll(/flip-entry-title[^>]*>([^<]+)</g)].map((m) => m[1].trim());
  return ids.map((fid, i) => ({ id: fid, name: names[i] || fid, source: "drive-public" }));
}
async function listDriveApi(syncCode, folderUrlOrId) {
  const id = driveFolderId(folderUrlOrId);
  if (!id) throw new Error("No pude leer el ID de la carpeta de Drive");
  const tokens = await ensureGoogleTokens(syncCode);
  if (!tokens?.access_token) throw new Error("Google no está vinculado (haz la conexión OAuth primero)");
  const q = `'${id}' in parents and (mimeType contains 'image/' or mimeType='application/pdf') and trashed=false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,size)&pageSize=50`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
  if (!res.ok) throw new Error("Error listando Drive (revisa el permiso del folder)");
  const data = await res.json();
  return (data.files || []).map((f) => ({ id: f.id, name: f.name, mime: f.mimeType, source: "drive-api", size: f.size, tokens }));
}
async function listPhotos(syncCode, albumId) {
  const tokens = await ensureGoogleTokens(syncCode);
  if (!tokens?.access_token) throw new Error("Google no está vinculado (haz la conexión OAuth primero)");
  const items = []; let page;
  do {
    const res = await fetch("https://photoslibrary.googleapis.com/v1/mediaItems:search", { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokens.access_token}` }, body: JSON.stringify({ pageSize: 50, albumId: albumId || undefined, pageToken: page?.nextPageToken }) });
    if (!res.ok) throw new Error("Error leyendo el álbum de Google Photos");
    page = await res.json();
    for (const it of page.mediaItems || []) if (/^image\//.test(it.mimeType || "")) items.push({ id: it.id, name: it.filename || it.id, mime: it.mimeType, source: "photos", baseUrl: it.baseUrl });
  } while (page?.nextPageToken && items.length < 200);
  return items;
}
async function downloadImage(file) {
  let url;
  if (file.source === "photos") url = `${file.baseUrl}=d`;
  else if (file.source === "drive-api") url = `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`;
  else url = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(file.id)}&export=download`;
  const headers = file.source === "drive-api" ? { Authorization: `Bearer ${file.tokens?.access_token || ""}` } : {};
  const res = await fetch(url, { headers, redirect: "follow" });
  if (!res.ok) throw new Error(`Descarga falló (${res.status})`);
  const ctype = res.headers.get("content-type") || file.mime || "application/octet-stream";
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) throw new Error("Archivo mayor de 8 MB");
  const mime = IMG_MIME.test(ctype) ? ctype : inferMime(file.name);
  if (!mime) throw new Error("No es una imagen o PDF");
  return { mime, base64: b64(buf), size: buf.length };
}

// ---------- Google tokens (local) ----------
async function getGoogleTokens(code) { const d = await kvReadJSON(tokensKey(code)); return d?.tokens || null; }
async function saveGoogleTokens(code, tokens) { await kvWriteJSON(tokensKey(code), { syncCode: code, tokens, updatedAt: Date.now() }); }
async function exchangeRefresh(refreshToken) {
  const clientId = process.env.GOOGLE_CLIENT_ID, clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret || !refreshToken) return null;
  const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }) });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.access_token) return null;
  return { access_token: data.access_token, expires_in: data.expires_in || 3600, fetched_at: Date.now() };
}
async function ensureGoogleTokens(code) {
  const tokens = await getGoogleTokens(code);
  if (!tokens) return null;
  const expiresAt = (tokens.fetched_at || Date.now()) + ((tokens.expires_in || 3600) - 300) * 1000;
  if (Date.now() < expiresAt) return tokens;
  const fresh = await exchangeRefresh(tokens.refresh_token);
  if (!fresh) return tokens;
  const next = { ...tokens, ...fresh };
  await saveGoogleTokens(code, next);
  return next;
}
async function exchangeAuthCode(code, redirectUri) {
  const params = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, code, redirect_uri: redirectUri, grant_type: "authorization_code" });
  const res = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params.toString() });
  if (!res.ok) throw new Error(`Intercambio de token falló (${res.status})`);
  const data = await res.json();
  return { access_token: data.access_token, refresh_token: data.refresh_token, expires_in: data.expires_in, fetched_at: Date.now(), scope: data.scope };
}
function buildAuthUrl(syncCode, scope, origin) {
  const params = new URLSearchParams({ client_id: process.env.GOOGLE_CLIENT_ID, redirect_uri: `${origin}/api/google-auth`, response_type: "code", scope: `${SCOPES.drive} ${SCOPES.photos}`, state: `${syncCode}:${scope}`, access_type: "offline", prompt: "consent", include_granted_scopes: "true" });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}
function hasCreds() { return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET); }
function tokenPage(title, msg) { return `<!doctype html><html lang="es"><body style="font-family:system-ui;background:#0b1426;color:#e2e8f0;display:grid;place-items:center;height:100vh"><div style="text-align:center"><h1>${title}</h1><p>${msg}</p></div></body></html>`; }

export async function handleGoogleAuth(req, res, _rawBody, _db) {
  const query = new URLSearchParams(req.url.split("?")[1] || "");
  const syncCode = String((query.get("syncCode") || query.get("state") || "").split(":")[0]).toLowerCase();
  if (!validSyncCode(syncCode)) return { status: 200, body: { ok: false, oauthAvailable: hasCreds(), error: "no_sync" } };
  const origin = appOrigin(req);
  const redirectUri = `${origin}/api/google-auth`;
  const code = query.get("code");
  if (code) {
    try {
      const tokens = await exchangeAuthCode(code, redirectUri);
      await saveGoogleTokens(syncCode, tokens);
      return { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" }, body: tokenPage(tokens.access_token ? "✓ Google conectado" : "Error en la conexión", tokens.access_token ? "Cierra esta pestaña y vuelve a la app." : "No se guardaron los permisos. Reintenta.") };
    } catch (e) {
      return { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" }, body: `<!doctype html><html lang="es"><body style="font-family:system-ui">Conexión con Google falló: ${e.message}</body></html>` };
    }
  }
  const connected = !!(await getGoogleTokens(syncCode));
  if (connected) return { status: 200, body: { ok: true, connected: true } };
  if (!hasCreds()) return { status: 200, body: { ok: false, connected: false, oauthAvailable: false, error: "no_creds" } };
  return { status: 200, body: { ok: true, connected: false, oauthAvailable: true, authUrl: buildAuthUrl(syncCode, query.get("scope") === "photos" ? "photos" : "drive", origin) } };
}

export async function handleGoogleImport(req, res, rawBody, _db) {
  const query = new URLSearchParams(req.url.split("?")[1] || "");
  const syncCode = String(query.get("syncCode") || "").toLowerCase();
  const batchId = query.get("batchId");
  const check = query.get("check");

  if (req.method === "GET") {
    if (!validSyncCode(syncCode)) return { status: 400, body: { error: "syncCode inválido" } };
    if (check) {
      const tokens = await getGoogleTokens(syncCode);
      return { status: 200, body: { ok: true, google: !!tokens?.access_token, scopes: (tokens?.scope || "").split(" ").filter(Boolean), envKeys: { GEMINI_API_KEY: !!process.env.GEMINI_API_KEY, OPENAI_API_KEY: !!process.env.OPENAI_API_KEY, ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY, AI_PROVIDER: process.env.AI_PROVIDER || null } } };
    }
    if (!batchId) return { status: 400, body: { error: "Faltan syncCode/batchId" } };
    const batch = await kvReadJSON(batchKey(syncCode, batchId));
    if (!batch) return { status: 404, body: { error: "Batch no encontrado" } };
    return { status: 200, body: { batch } };
  }

  if (req.method === "POST") {
    const body = rawBody || {};
    if (!validSyncCode(syncCode)) return { status: 400, body: { error: "Código de sincronización inválido" } };
    const source = ["drive-public", "drive-api", "photos"].includes(body.source) ? body.source : "drive-public";
    const provider = body.provider || process.env.AI_PROVIDER || "gemini";
    const apiKey = body.apiKey || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { status: 400, body: { error: "no_key", message: "Falta la clave de IA (Ajustes → IA o env)." } };
    const start = Math.max(0, parseInt(body.start) || 0);
    const limit = Math.min(8, Math.max(1, parseInt(body.limit) || 6));
    const maxTotal = Math.min(200, Math.max(1, parseInt(body.max) || 40));

    let batch = body.batchId ? await kvReadJSON(batchKey(syncCode, body.batchId)) : null;
    if (!batch) batch = { id: uid(), createdAt: Date.now(), updatedAt: Date.now(), syncCode, source, folderUrl: body.folderUrl || null, provider, items: [], status: "running" };

    if (batch.items.length === 0) {
      let files = [];
      try {
        if (source === "drive-public") files = await listDrivePublic(body.folderUrl || body.folderId || body.folder || "");
        else if (source === "drive-api") { const tokens = await ensureGoogleTokens(syncCode); files = (await listDriveApi(syncCode, body.folderUrl || body.folderId || body.folder || "", apiKey)).map((f) => ({ ...f, tokens })); }
        else files = await listPhotos(syncCode, body.photoAlbumId || body.albumId || null);
      } catch (e) { return { status: 200, body: { ok: false, error: e.message || "Error listando archivos" } }; }
      files = files.filter((f) => IMG_MIME.test(f.mime || "") || inferMime(f.name));
      batch.items = files.slice(0, maxTotal).map((f, i) => ({ key: `img-${i}`, name: f.name || f.id, file: f, status: "pending", result: null, error: null }));
      batch.total = files.length;
    }

    const slice = batch.items.slice(start, start + limit);
    for (const it of slice) {
      if (it.status === "done" || it.status === "error") continue;
      it.status = "processing";
      try {
        const img = await downloadImage(it.file);
        const result = await classifyImage({ mime: it.file.mime || (it.file.source === "drive-api" ? "image/jpeg" : "image/jpeg"), base64: img.base64 }, { provider, apiKey, model: body.model, categories: body.categories, accounts: body.accounts });
        it.result = result; it.status = "done"; it.engine = provider;
      } catch (e) { it.status = "error"; it.error = e.message || "Error de IA"; it.aiCode = e.aiCode || null; }
    }
    const processed = batch.items.filter((i) => i.status === "done" || i.status === "error").length;
    batch.updatedAt = Date.now();
    if (processed >= batch.items.length) batch.status = "done";
    await kvWriteJSON(batchKey(syncCode, batch.id), batch);
    return { status: 200, body: { ok: true, batchId: batch.id, done: batch.status === "done", nextStart: start + slice.length, total: batch.items.length, processed, items: slice.map(buildSummary) } };
  }
  return { status: 405, headers: { Allow: "GET, POST" }, body: { error: "Método no permitido." } };
}

export async function handleTelegramConfig(req, res, rawBody, _db) {
  const q = new URLSearchParams(req.url.split("?")[1] || "");
  if (req.method === "GET") {
    const syncCode = String(q.get("syncCode") || "").toLowerCase();
    const chatId = String(q.get("chatId") || "").trim();
    if (!validSyncCode(syncCode) || !chatId) return { status: 400, body: { error: "Faltan syncCode/chatId" } };
    const binding = await kvReadJSON(bindingKey(chatId));
    if (!binding || binding.syncCode !== syncCode) return { status: 404, body: { error: "No existe vínculo para este chat." } };
    return { status: 200, body: { ok: true, binding: sanitizeBinding(binding) } };
  }
  if (req.method === "POST") {
    const body = rawBody || {};
    const action = ["save", "test", "register"].includes(body.action) ? body.action : "save";
    const chatId = String(body.chatId || "").trim();
    const syncCode = String(body.syncCode || "").toLowerCase();
    if (!validSyncCode(syncCode) || !chatId) return { status: 400, body: { error: "Faltan syncCode/chatId válidos." } };
    const key = bindingKey(chatId);
    if (action === "save") {
      let binding = (await kvReadJSON(key)) || {};
      binding = { ...binding, chatId, syncCode, enabled: body.enabled !== false };
      if (body.botToken && String(body.botToken).trim().length > 12) binding.botToken = String(body.botToken).trim();
      if (body.aiProvider) binding.aiProvider = body.aiProvider;
      if (typeof body.aiApiKey === "string" && body.aiApiKey.trim()) binding.aiApiKey = body.aiApiKey.trim();
      if (body.defaultAccountId) binding.defaultAccountId = body.defaultAccountId;
      if (!binding.botToken) return { status: 400, body: { error: "Se necesita el token del bot." } };
      await kvWriteJSON(key, binding);
      return { status: 200, body: { ok: true, binding: sanitizeBinding(binding) } };
    }
    const binding = await kvReadJSON(key);
    if (!binding) return { status: 404, body: { error: "Vínculo inexistente. Guárdalo primero." } };
    const token = body.botToken && String(body.botToken).trim().length > 12 ? String(body.botToken).trim() : binding.botToken;
    if (action === "test") {
      try { await sendMessage(token, chatId, "✅ Conexión con tu bot de recibo (Mis Finanzas) establecida."); return { status: 200, body: { ok: true } }; }
      catch (e) { return { status: 502, body: { ok: false, error: e.message } }; }
    }
    if (action === "register") {
      if (!token) return { status: 400, body: { error: "Falta el token del bot." } };
      const secret = binding.webhookSecret || `tg-${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 8)}`;
      const url = body.webhookUrl || `${appOrigin(req)}/api/telegram`;
      try {
        const result = await registerWebhook(token, url, secret);
        binding.webhookSecret = secret; binding.registered = true; binding.webhookUrl = url;
        await kvWriteJSON(key, binding);
        return { status: 200, body: { ok: true, result, webhookUrl: url } };
      } catch (e) { return { status: 502, body: { ok: false, error: e.message, webhookUrl: url } }; }
    }
  }
  return { status: 405, headers: { Allow: "GET, POST" }, body: { error: "Método no permitido." } };
}

function buildReplyText(result, defaultAccountName) {
  const lines = []; const label = TYPE_LABEL[result.type] || "Documento"; const txs = result.transactions || []; const currency = result.currency || "";
  if (txs.length > 1) {
    lines.push(`🧾 ${label}${result.merchant ? " · " + result.merchant : ""} (${txs.length} movimientos)`);
    for (const t of txs) { const acc = result.accountName || defaultAccountName || "— elegir"; lines.push(`• ${t.direction === "in" ? "⬆" : "⬇"} ${t.amount.toFixed(2)} ${currency} · ${t.date || "?"} · ${t.description || ""} · ${t.category || "sin categoría"}`); lines.push(`  🏦 ${acc}`); }
  } else {
    const t = txs[0] || {};
    lines.push(`🧾 ${label}${result.merchant ? " · " + result.merchant : ""}`);
    lines.push(`💵 ${t.amount != null ? t.amount.toFixed(2) + " " + currency : "monto no claro"} · ${t.direction === "in" ? "entrada" : "salida"}`);
    if (t.date) lines.push(`📅 ${t.date}`); if (t.description) lines.push(`🏷 ${t.description}`);
    lines.push(`📂 ${t.category || "sin categoría"}`);
    lines.push(`🏦 Cuenta: ${result.accountName || defaultAccountName || "— seleccionar en la app"}`);
  }
  lines.push(`🤖 Confianza: ${Math.round((result.confidence || 0) * 100)}%${(result.confidence || 0) < 0.6 ? " ⚠️ revisa importes" : ""}`);
  lines.push(""); lines.push("¿Registro esta(s) transacción(es)?");
  return lines.join("\n");
}

export async function handleTelegram(req, res, rawBody, db) {
  const q = new URLSearchParams(req.url.split("?")[1] || "");
  const chatId = q.get("chatId"); const syncCode = String(q.get("syncCode") || "").toLowerCase();

  if (req.method === "GET") {
    if (chatId && syncCode && validSyncCode(syncCode)) {
      const binding = await kvReadJSON(bindingKey(String(chatId)));
      if (binding && binding.syncCode === syncCode) { let info = null; try { info = await webhookInfo(binding.botToken); } catch {} return { status: 200, body: { ok: true, chatId, bound: true, enabled: !!binding.enabled, registered: !!binding.registered, webhookUrl: binding.webhookUrl || null, webhookInfo: info } }; }
      return { status: 200, body: { ok: true, chatId, bound: false } };
    }
    return { status: 200, body: { ok: true, note: "Webhook del bot de Mis Finanzas. Envía una foto de recibo.", secretConfigured: !!process.env.TELEGRAM_WEBHOOK_SECRET } };
  }
  if (req.method !== "POST") return { status: 405, headers: { Allow: "GET, POST" }, body: { error: "Método no permitido." } };
  const update = rawBody;
  if (!update) return { status: 400, body: { error: "update inválido" } };
  const cid = String(update.message?.chat?.id || update.callback_query?.message?.chat?.id || "");
  if (!cid) return { status: 200, body: "" };
  const binding = await kvReadJSON(bindingKey(cid));
  if (!binding || !binding.enabled) return { status: 200, body: "" };
  const secret = binding.webhookSecret || process.env.TELEGRAM_WEBHOOK_SECRET;
  const header = req.headers["x-telegram-bot-api-secret-token"];
  if (secret && header !== secret) return { status: 401, body: { error: "Unauthorized" } };

  // WG11-FIX: responder 200 AL INSTANTE y procesar en background. El OCR Paddle
  // (CPU, puede tardar minutos) + Gemini exceden el timeout del webhook de
  // Telegram: si esperamos, Telegram reintenta el MISMO update y encola todos
  // los siguientes (el bot "se queda atascado en el primer recibo").
  setImmediate(async () => {
    try {
      if (update.callback_query) await handleCallback(db, update, binding, cid);
      else if (update.message) await handleMessage(db, update, binding, cid);
    } catch (e) { console.error("[telegram] webhook error:", e.message); }
  });
  return { status: 200, body: "" };
}

async function handleMessage(db, update, binding, chatId) {
  const msg = update.message; let msgId = msg.message_id;

  // WG11 (F4): aprendizaje por lenguaje natural. Si el texto es una enseñanza
  // (sin imagen), se persiste en config.json vía /api/learn y se confirma.
  if (typeof msg.text === "string" && msg.text.trim()) {
    const learned = await learnFromText(db, binding, msg.text.trim());
    if (learned) { await sendMessage(binding.botToken, chatId, learned); return; }
  }

  let fileId = null, fileName = null, mime = null;
  if (Array.isArray(msg.photo) && msg.photo.length) { fileId = msg.photo[msg.photo.length - 1].file_id; mime = "image/jpeg"; }
  else if (msg.document) {
    if (!isImageMime(msg.document.mime_type, msg.document.file_name)) { await sendMessage(binding.botToken, chatId, "Solo acepto imágenes o PDF (recibos)."); return; }
    fileId = msg.document.file_id; fileName = msg.document.file_name; mime = msg.document.mime_type || "image/jpeg";
  }
  if (!fileId) return;
  const finfo = await getFile(binding.botToken, fileId);
  if (!finfo?.file_path) { await sendMessage(binding.botToken, chatId, "No pude acceder al archivo. Intenta de nuevo."); return; }
  const buf = await downloadFile(binding.botToken, finfo.file_path);
  if (buf.length > MAX_IMAGE_BYTES) { await sendMessage(binding.botToken, chatId, "El archivo supera los 8 MB."); return; }
  if (!isImageMime(mime, fileName) && !/^image\//.test(mime || "")) { await sendMessage(binding.botToken, chatId, "Solo acepto imágenes o PDF."); return; }

  const state = loadSyncState(db, binding.syncCode);
  if (!state) { await sendMessage(binding.botToken, chatId, "No se encontró el estado de sincronización vinculado."); return; }
  const accounts = state.accounts || []; const categories = state.categories || []; const aliases = state.transferAliases || {};
  const provider = binding.aiProvider || "gemini";
  const apiKey = binding.aiApiKey || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY;

  // WG11 (F1): Paddle local primero — sin costo, sin límite de IA.
  let result = await paddleFirst(buf, { mime });

  if (!result) {
    // Fallback: IA de pago (Gemini por defecto).
    if (!apiKey) { await sendMessage(binding.botToken, chatId, "El bot no tiene clave de IA configurada (vincúlala desde la app)."); return; }
    try { result = await classifyImage({ mime: isImageMime(mime, fileName) && mime !== "application/pdf" ? mime : (mime || "image/jpeg"), base64: buf.toString("base64") }, { provider, apiKey, categories, accounts, aliases }); }
    catch (e) { await sendMessage(binding.botToken, chatId, `No pude leer la imagen con la IA: ${e.message}`); return; }
  }

  const rows = (result.transactions || []).map((t) => ({ description: t.description, amount: t.amount, direction: t.direction, currency: result.currency || accounts[0]?.currency || "EUR", category: t.category || null, date: t.date || result.date || null, accountId: result.accountId || null }));
  const defaultAccountName = binding.defaultAccountId ? (accounts.find((a) => a.id === binding.defaultAccountId)?.name || null) : null;
  const sent = await sendMessage(binding.botToken, chatId, buildReplyText(result, defaultAccountName), { reply_markup: inlineKeyboard([[{ text: "✅ Registrar", data: `ap:${msgId}` }, { text: "❌ Descartar", data: `rj:${msgId}` }]]) });
  await kvWriteJSON(proposalKey(chatId, msgId), { id: msgId, chatId, status: "pending", createdAt: new Date().toISOString(), syncCode: binding.syncCode, result, rows, hints: result.accountHints || [], messageId: sent?.message_id || msgId, fileName });
}

// WG11 (F1): OCR local (Paddle) ANTES de la IA de pago. Devuelve un result en el
// MISMO formato de classifyImage si el parseo local reconoce el comprobante;
// null si no hay OCR local o el texto no se interpreta (entonces → Gemini).
async function paddleFirst(buf, { mime }) {
  if (!/^image\//.test(mime || "")) return null; // PDF → directo a IA
  let filePath = null;
  try {
    const ext = /png$/i.test(mime) ? ".png" : /webp$/i.test(mime) ? ".webp" : ".jpg";
    filePath = path.join(BLOB_DIR, `ocr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    await writeFile(filePath, buf);
    const raw = await ocrImage(filePath, { url: process.env.OCR_URL || "http://127.0.0.1:8765", timeoutMs: 90000 });
    const parsed = parseOcrText(raw);
    if (!parsed?.ok || !parsed.result) return null;
    const r = parsed.result;

    const transactions = [];
    if (r.type === "receipt") {
      if (r.total > 0) transactions.push({ description: r.merchant || "Compra", amount: r.total, direction: "out", category: null, date: null });
    } else if (r.type === "transfer" && r.transfer) {
      transactions.push({ description: `Transferencia ${r.transfer.from ? `de ${r.transfer.from}` : ""}${r.transfer.to ? ` a ${r.transfer.to}` : ""}`.trim() || "Transferencia", amount: r.transfer.amount, direction: "out", category: null, date: null });
    } else if (r.type === "statement") {
      for (const m of r.movements || []) transactions.push({ description: m.description, amount: m.amount, direction: m.direction, category: m.category || null, date: m.date || null });
    }
    if (!transactions.length) return null;

    return {
      type: r.type,
      merchant: r.merchant || null,
      date: null,
      currency: null,
      total: r.total || null,
      accountHints: [],
      confidence: 0.5,
      transactions,
      accountHint: null,
      accountId: null,
      accountName: null,
      accountConfident: false,
      source: "paddle",
    };
  } catch {
    return null;
  } finally {
    if (filePath) { try { await import("node:fs/promises").then((f) => f.unlink(filePath)); } catch {} }
  }
}

// WG11 (F4): aprende de un mensaje de texto del usuario en lenguaje natural.
// Patrones soportados:
//   "<alias> es la cuenta de <nombre>"   → bankAccountMap[alias] = cuenta
//   "<merchant> es <categoría>"          → merchantCategoryMap[merchant] = categoría
// Devuelve el texto de confirmación, o null si no era una enseñanza.
async function learnFromText(db, binding, text) {
  const state = loadSyncState(db, binding.syncCode);
  if (!state) return null;
  const accounts = state.accounts || [];
  const accountsByName = new Map(accounts.map((a) => [a.name.toLowerCase(), a.id]));

  // 1) "<alias> es la cuenta de <cuenta>"
  const m1 = text.match(/^(.+?)\s+es\s+la\s+cuenta\s+(?:de|del|de la)\s+(.+)$/i);
  if (m1) {
    const alias = m1[1].trim(); const target = m1[2].trim().toLowerCase();
    const accountId = accountsByName.get(target);
    if (!accountId) return `No conozco ninguna cuenta llamada "${m1[2].trim()}".`;
    await fetch("http://127.0.0.1:" + (process.env.PORT || 3000) + "/api/learn", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "account", merchant: alias, accountId }),
    });
    return `✅ Aprendido: "${alias}" → cuenta ${m1[2].trim()}.`;
  }

  // 2) "<merchant> es <categoría>"
  const m2 = text.match(/^(.+?)\s+es\s+(.+)$/i);
  if (m2) {
    const merchant = m2[1].trim(); const category = m2[2].trim();
    const known = (state.categories || []).some((c) => (c.name || "").toLowerCase() === category.toLowerCase());
    if (!known) return `No conozco la categoría "${category}". Mírala en la app.`;
    await fetch("http://127.0.0.1:" + (process.env.PORT || 3000) + "/api/learn", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "category", merchant, category }),
    });
    return `✅ Aprendido: "${merchant}" → categoría ${category}.`;
  }

  return null;
}

async function handleCallback(db, update, binding, chatId) {
  const cb = update.callback_query;
  const [verb, msgId] = String(cb.data || "").split(":");
  if (!["ap", "rj"].includes(verb) || !msgId) { await answerCallbackQuery(binding.botToken, cb.id, "Acción desconocida"); return; }
  const proposal = await kvReadJSON(proposalKey(chatId, msgId));
  if (!proposal) { await answerCallbackQuery(binding.botToken, cb.id, "Propuesta no encontrada"); return; }
  if (proposal.status !== "pending") { await answerCallbackQuery(binding.botToken, cb.id, `Ya fue ${proposal.status === "approved" ? "aprobada" : "descartada"}`); return; }
  const from = cb.from?.username || cb.from?.first_name || "Telegram";
  if (verb === "rj") {
    proposal.status = "rejected"; proposal.resolvedBy = from; proposal.resolvedAt = new Date().toISOString();
    await kvWriteJSON(proposalKey(chatId, msgId), proposal);
    await editMessageReplyMarkup(binding.botToken, chatId, msgId, inlineKeyboard([[{ text: "❌ Descartado", data: "noop" }]]));
    await answerCallbackQuery(binding.botToken, cb.id, "Descartado", false);
    return;
  }
  const rows = Array.isArray(proposal.rows) ? proposal.rows : [];
  const toAdd = rows.map((r) => ({ ...r, accountId: r.accountId || binding.defaultAccountId || null })).filter((r) => r.accountId && r.amount != null);
  if (toAdd.length === 0) {
    proposal.status = "error"; proposal.error = "Sin cuenta asignada"; proposal.resolvedBy = from; proposal.resolvedAt = new Date().toISOString();
    await kvWriteJSON(proposalKey(chatId, msgId), proposal);
    await editMessageReplyMarkup(binding.botToken, chatId, msgId, inlineKeyboard([[{ text: "⚠️ Sin cuenta", data: "noop" }]]));
    await answerCallbackQuery(binding.botToken, cb.id, "No registrado: sin cuenta asignada", true);
    return;
  }
  const hints = proposal.hints || []; const accountId = toAdd[0].accountId;
  try {
    await updateSyncState(db, binding.syncCode, (s) => { s = addProposedTransactions(s, toAdd); if (hints.length) s = learnAccountAliases(s, hints, accountId); return s; });
    proposal.status = "approved"; proposal.resolvedBy = from; proposal.resolvedAt = new Date().toISOString();
    const total = toAdd.reduce((a, r) => a + Math.abs(+r.amount || 0), 0);
    proposal.appliedTotal = Math.round(total * 100) / 100;
    await kvWriteJSON(proposalKey(chatId, msgId), proposal);
    await editMessageReplyMarkup(binding.botToken, chatId, msgId, inlineKeyboard([[{ text: "✅ Registrado", data: "noop" }]]));
    await sendMessage(binding.botToken, chatId, `✅ Registradas ${toAdd.length} transacción(es) · total ${proposal.appliedTotal.toFixed(2)}`);
    await answerCallbackQuery(binding.botToken, cb.id, "Registrado ✓");
  } catch (e) {
    proposal.status = "error"; proposal.error = e.message;
    await kvWriteJSON(proposalKey(chatId, msgId), proposal);
    await answerCallbackQuery(binding.botToken, cb.id, `Error al registrar: ${e.message.slice(0, 60)}`, true);
  }
}
