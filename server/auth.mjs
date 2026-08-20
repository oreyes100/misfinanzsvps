// auth.mjs — Auth/RBAC por endpoint (W1 Fortress Fase 1).
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
