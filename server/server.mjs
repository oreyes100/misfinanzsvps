// server.mjs — API local para Mis Finanzas (reemplaza las Vercel Functions).
// Implementa /api/users, /api/sync y /api/signup con la MISMA semántica que
// api/users.js, api/sync.js y api/signup.js, pero leyendo SQLite local (db.mjs).
// Uso: npm start   (o: node server/server.mjs)
// Env: PORT (3000), HOST (127.0.0.1), ALLOWED_ORIGINS, RESEND_API_KEY (opcional)
import http from "node:http";
import crypto from "node:crypto";
import { openDb, initSchema, getUsers, replaceUsers, getSyncDoc, putSyncDoc, getPendings, writePendings, DATA_DIR } from "./db.mjs";
import { mergeStates } from "../api/_merge.js";
import { handleGoogleImport, handleGoogleAuth, handleTelegramConfig, handleTelegram } from "./extra.js";
import { mkdirSync } from "node:fs";

mkdirSync(DATA_DIR, { recursive: true });
const db = openDb();
initSchema(db);

const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "127.0.0.1";
const PBKDF2_ITER = 100_000;
const MAX_BYTES = 1_000_000;
const ID_RE = /^[a-z0-9-]{16,64}$/i;
const CODE_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const DEMO_SECTIONS = ["inicio", "movimientos", "reportes"];
const DEMO_ACCOUNTS = ["acc-corriente", "acc-ahorro", "acc-deposito", "acc-usd"];

// ---------- crypto (idéntico a api/users.js) ----------
function pbkdf2(password, salt) {
  return crypto.pbkdf2Sync(String(password), String(salt), PBKDF2_ITER, 32, "sha256").toString("hex");
}
function sha256(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex");
}
function eq(a, b) {
  const ba = Buffer.from(String(a || "")), bb = Buffer.from(String(b || ""));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
function verifyCredential(user, password) {
  if (!user || !user.hash) return false;
  const candidate = user.salt ? pbkdf2(password, user.salt) : sha256(password);
  return eq(candidate, user.hash);
}
function sanitizeUsers(users) {
  return users.map(({ hash, salt, ...safe }) => safe);
}
function authorizeWrite(existing, actor) {
  if (!existing.length) return true;
  const admin = existing.find(
    (u) => u.username.toLowerCase() === String(actor?.username || "").toLowerCase().trim() && (u.role === "admin" || u.sections === "all")
  );
  return !!admin && eq(actor?.hash, admin.hash);
}

// ---------- Categorización semántica (Top of Mind A) ----------
// Reutiliza el motor de embeddings de Hermes (server/hermes/gemini.mjs) con el
// proveedor configurado (env EMBED_PROVIDER / GEMINI_API_KEY, o el geminiKey del
// config de Hermes). Fallback a reglas si no hay key o falla la red.
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HERMES_CONFIG = path.join(HERE, "hermes", "config.json");

function hermesGeminiKey() {
  try {
    if (existsSync(HERMES_CONFIG)) {
      const cfg = JSON.parse(readFileSync(HERMES_CONFIG, "utf8"));
      if (cfg.geminiKey) return cfg.geminiKey;
    }
  } catch { /* ignorar */ }
  return null;
}

function embedProviderFromEnv() {
  return process.env.EMBED_PROVIDER || "gemini";
}

function embedApiKey() {
  return process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY || hermesGeminiKey() || null;
}

/** k-NN coseno: devuelve la categoría más similar entre prototipos. */
function pickByCosine(descEmb, prototypes) {
  let best = null;
  let bestSim = 0;
  for (const p of prototypes) {
    if (p.embedding?.length !== descEmb.length) continue;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < descEmb.length; i++) {
      dot += descEmb[i] * p.embedding[i];
      na += descEmb[i] * descEmb[i];
      nb += p.embedding[i] * p.embedding[i];
    }
    const sim = dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
    if (sim > bestSim) { bestSim = sim; best = p; }
  }
  if (!best) return null;
  return { category: best.category, confidence: Math.min(0.95, 0.5 + bestSim) };
}

/** Categoriza por embeddings: prototipo = nombre + keywords + subcategorías de cada categoría. */
async function categorizeByEmbeddings(text, categories, provider, apiKey) {
  const { embedText } = await import("./hermes/gemini.mjs");
  const descEmb = await embedText(String(text || ""), provider, apiKey);
  if (!descEmb?.length) return null;

  const prototypes = [];
  for (const c of categories || []) {
    if (c.system) continue;
    const corpus = [c.name, ...(c.keywords || []), ...(c.subcategories || [])].filter(Boolean).join(" · ");
    const emb = await embedText(corpus, provider, apiKey);
    if (emb?.length) prototypes.push({ category: c.name, embedding: emb });
  }
  if (!prototypes.length) return null;
  return pickByCosine(descEmb, prototypes);
}

async function handleCategorize(req, res, rawBody) {
  const body = rawBody || {};
  const text = String(body.text || "").trim();
  const categories = Array.isArray(body.categories) ? body.categories : null;
  if (!text) return { status: 400, body: { error: "text requerido" } };
  const provider = embedProviderFromEnv();
  const apiKey = embedApiKey();

  // Sin key → fallback a reglas (misma semántica que categorize()).
  if (!apiKey) {
    return { status: 200, body: { category: "Otros", confidence: 0.3, provider, semantic: false } };
  }
  try {
    const r = await categorizeByEmbeddings(text, categories || [], provider, apiKey);
    if (r) return { status: 200, body: { ...r, provider, semantic: true } };
    return { status: 200, body: { category: "Otros", confidence: 0.3, provider, semantic: false } };
  } catch (e) {
    console.error("[server] categorize error:", e);
    return { status: 200, body: { category: "Otros", confidence: 0.3, provider, semantic: false } };
  }
}


// ---------- CORS (idéntico a api/users.js) ----------
function allowedOrigin(req) {
  let origin = req.headers.origin;
  const allowed = (process.env.ALLOWED_ORIGINS || "https://mis-finazas-gold.vercel.app").split(",").map((s) => s.trim());
  if (!origin) {
    const host = req.headers.host || req.headers["x-forwarded-host"];
    if (host) {
      const constructed = `https://${host}`;
      if (allowed.includes(constructed) || host.includes("vercel.app") || host.includes("localhost")) return constructed;
    }
    return "same-origin";
  }
  if (allowed.includes(origin)) return origin;
  if (origin.startsWith("http://localhost:") || origin.startsWith("capacitor://localhost")) return origin;
  return "";
}
function cors(res, origin, methods = "GET, POST, OPTIONS") {
  if (origin && origin !== "same-origin") {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", methods);
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Vary", "Origin");
  }
}

// ---------- helpers http ----------
function sendJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...extraHeaders });
  res.end(JSON.stringify(payload));
}
function readBody(req, limit = MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("too_large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("bad_json"));
      }
    });
    req.on("error", reject);
  });
}

// ---------- endpoints ----------
async function handleUsers(req, res, rawBody) {
  if (req.method === "GET") {
    try {
      return sendJson(res, 200, { users: sanitizeUsers(getUsers(db)) });
    } catch {
      return sendJson(res, 500, { error: "Error leyendo usuarios." });
    }
  }
  if (req.method === "POST") {
    const body = rawBody || {};
    // verify
    if (body.action === "verify") {
      try {
        const users = getUsers(db);
        const user = users.find((u) => u.username.toLowerCase() === String(body.username || "").toLowerCase().trim());
        if (verifyCredential(user, body.password)) {
           const { hash, ...safe } = user;
          return sendJson(res, 200, { ok: true, user: safe });
        }
        return sendJson(res, 200, { ok: false });
      } catch {
        return sendJson(res, 500, { error: "Error verificando." });
      }
    }
    // change_password
    if (body.action === "change_password") {
      try {
        const users = getUsers(db);
        const target = users.find((u) => u.username.toLowerCase() === String(body.username || "").toLowerCase().trim());
        if (!target) return sendJson(res, 404, { error: "Usuario no encontrado." });
        if (!body.newPassword || String(body.newPassword).length < 6) return sendJson(res, 400, { error: "Contraseña muy corta (mínimo 6 caracteres)." });
        let authorized = verifyCredential(target, body.currentPassword);
        if (!authorized && body.actorUsername) {
          const admin = users.find((u) => u.username.toLowerCase() === String(body.actorUsername).toLowerCase().trim() && (u.role === "admin" || u.sections === "all"));
          authorized = !!admin && verifyCredential(admin, body.actorPassword);
        }
        if (!authorized) return sendJson(res, 403, { error: "Credenciales incorrectas." });
        target.salt = crypto.randomBytes(16).toString("base64");
        target.hash = pbkdf2(body.newPassword, target.salt);
        replaceUsers(db, users);
        const { hash, ...safe } = target;
        return sendJson(res, 200, { ok: true, user: safe });
      } catch {
        return sendJson(res, 500, { error: "Error al cambiar la contraseña." });
      }
    }
    // setup
    if (body.action === "setup") {
      try {
        const existing = getUsers(db);
        if (existing.length > 0) return sendJson(res, 409, { error: "Ya existe configuración en la nube." });
        const u = body.user;
        if (!u || !u.username || !u.hash || !u.salt) return sendJson(res, 400, { error: "Usuario inválido." });
        replaceUsers(db, [u]);
        return sendJson(res, 200, { ok: true });
      } catch {
        return sendJson(res, 500, { error: "Error en setup." });
      }
    }
    // create_user
    if (body.action === "create_user") {
      try {
        const existing = getUsers(db);
        const adminEntry = existing.find(
          (u) => u.username.toLowerCase() === String(body.actorUsername || "").toLowerCase().trim() && (u.role === "admin" || u.sections === "all")
        );
        if (!adminEntry || !verifyCredential(adminEntry, body.actorPassword)) {
          return sendJson(res, 403, { error: "Credenciales de administrador incorrectas." });
        }
        const u = body.user || {};
        const uname = String(u.username || "").trim();
        if (!uname || !u.hash || !u.salt) return sendJson(res, 400, { error: "Usuario inválido." });
        if (existing.some((x) => x.username.toLowerCase().trim() === uname.toLowerCase())) {
          return sendJson(res, 409, { error: "Ese nombre de usuario ya existe." });
        }
        existing.push({ ...u, username: uname });
        replaceUsers(db, existing);
        return sendJson(res, 200, { ok: true });
      } catch {
        return sendJson(res, 500, { error: "Error creando usuario." });
      }
    }
    // lista de usuarios (write)
    if (Array.isArray(body.users)) {
      try {
        const existing = getUsers(db);
        if (!authorizeWrite(existing, body.actor)) {
          return sendJson(res, 403, { error: "No autorizado para modificar usuarios." });
        }
        const byName = new Map(existing.map((u) => [u.username.toLowerCase().trim(), u]));
        const healed = body.users.map((u) => {
          if (u && u.hash && u.salt) return u;
          const prev = byName.get(String((u && u.username) || "").toLowerCase().trim());
          return prev && prev.hash && prev.salt ? { ...u, hash: prev.hash, salt: prev.salt } : u;
        });
        const payload = JSON.stringify({ users: healed, updatedAt: Date.now() });
        if (Buffer.byteLength(payload) > MAX_BYTES) return sendJson(res, 413, { error: "Lista demasiado grande." });
        replaceUsers(db, healed);
        return sendJson(res, 200, { ok: true });
      } catch {
        return sendJson(res, 500, { error: "Error guardando usuarios." });
      }
    }
    return sendJson(res, 400, { error: "Petición inválida." });
  }
  res.setHeader("Allow", "GET, POST");
  return sendJson(res, 405, { error: "Método no permitido." });
}

async function handleSync(req, res, rawBody) {
  const id = String(req.url.split("?")[0].split("/").pop() || "");
  const query = new URLSearchParams(req.url.split("?")[1] || "");
  // el código viene como ?id=... (la ruta es /api/sync)
  const code = String(query.get("id") || id || "").toLowerCase();
  if (!ID_RE.test(code)) return sendJson(res, 400, { error: "Código de sincronización inválido." });

  if (req.method === "GET") {
    try {
      const doc = getSyncDoc(db, code);
      if (!doc) return sendJson(res, 200, { found: false });
      return sendJson(res, 200, { found: true, state: doc.state, updatedAt: doc.updatedAt });
    } catch {
      return sendJson(res, 500, { error: "Error leyendo el almacenamiento." });
    }
  }

  if (req.method === "POST") {
    const body = rawBody || {};
    if (!body || typeof body.state !== "object" || Array.isArray(body.state)) {
      return sendJson(res, 400, { error: "Estado inválido." });
    }
    let finalState = body.state;
    let mergedFlag = false;
    try {
      const existing = getSyncDoc(db, code);
      if (existing && existing.state) {
        finalState = mergeStates(existing.state, body.state);
        mergedFlag = true;
      }
    } catch { /* write incoming tal cual */ }
    const payload = JSON.stringify({ state: finalState, updatedAt: Date.now() });
    if (Buffer.byteLength(payload) > MAX_BYTES) return sendJson(res, 413, { error: "Estado demasiado grande." });
    try {
      putSyncDoc(db, code, finalState, Date.now());
      return sendJson(res, 200, { ok: true, merged: mergedFlag });
    } catch {
      return sendJson(res, 500, { error: "Error guardando en el almacenamiento." });
    }
  }

  res.setHeader("Allow", "GET, POST");
  return sendJson(res, 405, { error: "Método no permitido." });
}

async function handleSignup(req, res, rawBody) {
  const body = rawBody || {};
  // Step 1: request
  if (body.action === "request") {
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJson(res, 400, { error: "Correo inválido." });
    if (password.length < 6) return sendJson(res, 400, { error: "Contraseña muy corta (mínimo 6 caracteres)." });
    try {
      const users = getUsers(db);
      if (users.some((u) => String(u.email || "").toLowerCase() === email)) {
        return sendJson(res, 409, { error: "Ese correo ya tiene una cuenta." });
      }
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const salt = crypto.randomBytes(16).toString("base64");
      const hash = pbkdf2(password, salt);
      let pendings = getPendings(db).filter((p) => p.email !== email && Date.now() < p.expiresAt);
      pendings.push({ email, hash, salt, code, expiresAt: Date.now() + CODE_TTL_MS, attempts: 0 });
      writePendings(db, pendings);
      const apiKey = process.env.RESEND_API_KEY;
      if (!apiKey) return sendJson(res, 503, { error: "Registro por correo no disponible en este momento." });
      const from = process.env.RESEND_FROM || "Mis Finanzas <noreply@mis-finazas-gold.vercel.app>";
      const rr = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ from, to: email, subject: "Código de verificación — Mis Finanzas", html: `<p style="font-family:sans-serif">Tu código de verificación es:</p><p style="font-size:32px;font-weight:bold;letter-spacing:6px">${code}</p><p style="font-family:sans-serif;color:#888">Válido por 15 minutos.</p>` }),
      });
      if (!rr.ok) throw new Error(`Resend error ${rr.status}`);
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 500, { error: "Error al procesar la solicitud." });
    }
  }
  // Step 2: verify
  if (body.action === "verify") {
    const email = String(body.email || "").trim().toLowerCase();
    const code = String(body.code || "").trim();
    try {
      let pendings = getPendings(db);
      const idx = pendings.findIndex((p) => p.email === email);
      if (idx < 0) return sendJson(res, 400, { error: "No hay verificación pendiente para ese correo." });
      const pending = pendings[idx];
      if (Date.now() > pending.expiresAt) {
        pendings.splice(idx, 1); writePendings(db, pendings);
        return sendJson(res, 400, { error: "El código expiró. Solicita uno nuevo." });
      }
      pending.attempts = (pending.attempts || 0) + 1;
      if (pending.attempts > MAX_ATTEMPTS) {
        pendings.splice(idx, 1); writePendings(db, pendings);
        return sendJson(res, 429, { error: "Demasiados intentos. Solicita un nuevo código." });
      }
      if (pending.code !== code) {
        writePendings(db, pendings);
        const left = MAX_ATTEMPTS - pending.attempts;
        return sendJson(res, 400, { error: `Código incorrecto. ${left} intento${left !== 1 ? "s" : ""} restante${left !== 1 ? "s" : ""}.` });
      }
      const users = getUsers(db);
      if (users.some((u) => String(u.email || "").toLowerCase() === email)) {
        pendings.splice(idx, 1); writePendings(db, pendings);
        return sendJson(res, 409, { error: "Ese correo ya tiene una cuenta." });
      }
      const base = email.split("@")[0].replace(/[^a-z0-9_]/gi, "").toLowerCase().slice(0, 20) || "guest";
      let username = base;
      let n = 1;
      while (users.some((u) => u.username.toLowerCase() === username.toLowerCase())) username = `${base}${n++}`;
      users.push({ username, hash: pending.hash, salt: pending.salt, email, role: "guest", sections: DEMO_SECTIONS, accounts: DEMO_ACCOUNTS, created: new Date().toISOString() });
      replaceUsers(db, users);
      pendings.splice(idx, 1); writePendings(db, pendings);
      return sendJson(res, 200, { ok: true, username });
    } catch {
      return sendJson(res, 500, { error: "Error al verificar el código." });
    }
  }
  return sendJson(res, 400, { error: "Acción no reconocida." });
}

// ---------- router ----------
function safeBody(raw) {
  if (!raw || typeof raw !== "object") return {};
  if (Array.isArray(raw)) return raw;
  return raw;
}
async function readBodyAllowEmpty(req) {
  const len = parseInt(req.headers["content-length"] || "0", 10);
  if (!len) return null;
  return readBody(req);
}
async function routeExtra(handler, req, res, db) {
  const isJson = (req.headers["content-type"] || "").includes("application/json");
  let rawBody = null;
  if (req.method === "POST") {
    rawBody = isJson ? await readBody(req) : await readRaw(req);
  }
  let r;
  try { r = await handler(req, res, rawBody, db); }
  catch (e) {
    if (e.message === "bad_json") return sendJson(res, 400, { error: "JSON inválido." });
    if (e.message === "too_large") return sendJson(res, 413, { error: "Cuerpo demasiado grande." });
    console.error("[server] extra error:", e);
    return sendJson(res, 500, { error: "Error interno." });
  }
  const status = r.status || 200;
  const headers = r.headers || {};
  if (typeof r.body === "string") {
    res.writeHead(status, { "Content-Type": headers["Content-Type"] || "text/plain; charset=utf-8" });
    res.end(r.body);
  } else if (r.body === "" || r.body === null || r.body === undefined) {
    res.writeHead(status);
    res.end();
  } else {
    for (const k of Object.keys(headers)) res.setHeader(k, headers[k]);
    sendJson(res, status, r.body);
  }
}
async function readRaw(req, limit = MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on("data", (c) => { size += c.length; if (size > limit) { reject(new Error("too_large")); req.destroy(); return; } chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const urlPath = req.url.split("?")[0];
  const origin = allowedOrigin(req);
  let methods = "GET, POST, OPTIONS";
  if (urlPath.startsWith("/api/signup")) methods = "POST, OPTIONS";
  cors(res, origin, methods);

  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  if (!origin || origin === "") return sendJson(res, 403, { error: "Origen no autorizado." });

  if (req.method === "GET" && urlPath === "/api/health") {
    return sendJson(res, 200, { ok: true, engine: "sqlite", docs: db.prepare("SELECT COUNT(*) c FROM sync_docs").get().c });
  }

  try {
    if (urlPath === "/api/users") return await handleUsers(req, res, req.method === "POST" ? await readBody(req) : null);
    if (urlPath === "/api/sync") return await handleSync(req, res, req.method === "POST" ? await readBody(req) : null);
    if (urlPath === "/api/signup") return await handleSignup(req, res, await readBody(req));
    if (urlPath === "/api/google-import") return await routeExtra(handleGoogleImport, req, res, db);
    if (urlPath === "/api/google-auth") return await routeExtra(handleGoogleAuth, req, res, db);
    if (urlPath === "/api/telegram") return await routeExtra(handleTelegram, req, res, db);
    if (urlPath === "/api/telegram-config") return await routeExtra(handleTelegramConfig, req, res, db);
    if (urlPath === "/api/categorize") return await routeExtra(handleCategorize, req, res, db);
    return sendJson(res, 404, { error: "No encontrado." });
  } catch (e) {
    if (e.message === "bad_json") return sendJson(res, 400, { error: "JSON inválido." });
    if (e.message === "too_large") return sendJson(res, 413, { error: "Cuerpo demasiado grande." });
    console.error("[server] error:", e);
    return sendJson(res, 500, { error: "Error interno." });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[misfinanzas-server] SQLite local escuchando en http://${HOST}:${PORT}`);
  console.log(`  BD: ${DATA_DIR}/misfinanzas.db  |  docs: ${db.prepare("SELECT COUNT(*) c FROM sync_docs").get().c}`);
});