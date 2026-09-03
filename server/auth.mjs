// auth.mjs — Auth/RBAC por endpoint (W1 Fortress Fase 1) + sesiones por
// cookie para el registro (w32-i3).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HERMES_CONFIG = process.env.HERMES_CONFIG || path.join(HERE, "hermes", "config.json");

function loadHermesConfig() {
  try {
    const raw = fs.readFileSync(HERMES_CONFIG, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function bearerToken(req) {
  const h = req.headers["authorization"] || req.headers["Authorization"] || "";
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/**
 * Verifica auth para /api/learn.
 * Acepta: Authorization: Bearer <token> donde token es:
 *  - process.env.LEARN_TOKEN  o
 *  - hermes config `learnToken` o
 *  - hermes config `syncCode` (fallback: possession del syncCode)
 * Bypass para localhost (llamadas internas del server).
 */
export function checkLearnAuth(req) {
  const token = bearerToken(req);
  if (!token) return { ok: false, status: 401, error: "Falta Authorization: Bearer <token>." };
  const cfg = loadHermesConfig();
  const expected = process.env.LEARN_TOKEN || cfg.learnToken || cfg.syncCode || null;
  if (!expected) return { ok: true, via: "no-config" }; // sin config, permitir (no romper)
  if (token === expected) return { ok: true, via: "bearer" };
  // también aceptar syncCode enviado como Bearer aunque LEARN_TOKEN exista
  if (cfg.syncCode && token === cfg.syncCode) return { ok: true, via: "syncCode" };
  return { ok: false, status: 401, error: "Token inválido." };
}

/**
 * Verifica secret de Telegram webhook.
 * Usa ya la lógica de extra.js: binding.webhookSecret or env.
 * Exportado aquí para testing.
 */
export function checkTelegramSecret(req, bindingSecret) {
  const secret = bindingSecret || process.env.TELEGRAM_WEBHOOK_SECRET || null;
  if (!secret) return { ok: true, via: "no-secret" };
  const header = req.headers["x-telegram-bot-api-secret-token"] || req.headers["X-Telegram-Bot-Api-Secret-Token"] || "";
  if (header === secret) return { ok: true };
  return { ok: false, status: 401, error: "Unauthorized" };
}

export function getLearnToken() {
  const cfg = loadHermesConfig();
  return process.env.LEARN_TOKEN || cfg.learnToken || cfg.syncCode || null;
}

// ---------- Sesiones por cookie (w32-i3) ----------
// Token opaco de 32 bytes en cookie HttpOnly; el mapeo token→username vive en
// memoria del proceso (el server local de SQLite es de un solo proceso). Con
// tope para que un registro masivo no crezca el Map sin límite.
export const SESSION_COOKIE = "mf_session";
const MAX_SESSIONS = 1000;
/** @type {Map<string, { username: string, createdAt: number }>} */
const sessions = new Map();

/**
 * Crea una sesión para `username` y devuelve el token opaco.
 * @param {string} username
 * @returns {string} token
 */
export function createSession(username) {
  const name = String(username || "");
  while (sessions.size >= MAX_SESSIONS) {
    sessions.delete(sessions.keys().next().value); // evict FIFO
  }
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { username: name, createdAt: Date.now() });
  return token;
}

/** Parsea un header Cookie en objetos { nombre: valor }. */
export function parseCookieHeader(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}

/** Cookie de sesión: HttpOnly (no accesible a JS), SameSite=Lax, de sesión. */
export function sessionCookie(token) {
  return `${SESSION_COOKIE}=${encodeURIComponent(String(token))}; Path=/; HttpOnly; SameSite=Lax`;
}

/**
 * Resuelve el username dueño de la sesión de la petición (o null).
 * @param {import("node:http").IncomingMessage} req
 * @returns {string | null}
 */
export function sessionUsername(req) {
  const token = parseCookieHeader(req?.headers?.cookie)[SESSION_COOKIE] || "";
  if (!token) return null;
  return sessions.get(token)?.username ?? null;
}
