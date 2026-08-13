// telegram-config.js — Vincula un chat de Telegram con un syncCode de la app y
// gestiona el token del bot, la prueba de envío y el registro del webhook.
//
//   GET  /api/telegram-config?syncCode=...&chatId=...  → estado (datos saneados)
//   POST /api/telegram-config { action }               → save / test / register
//
// El "secreto" del chat es su syncCode: solo quien lo posee puede leer/escribir
// el vínculo (mismo modelo de propiedad que el estado de la nube).
import { readJSON, writeJSON } from "../lib/blob-json.js";
import { allowedOrigin, cors } from "../lib/cors.js";
import { validSyncCode } from "../lib/state-store.js";
import { sendMessage, registerWebhook } from "../lib/telegram.js";

const bindingKey = (chatId) => `telegram/bindings/${String(chatId).replace(/[^0-9-]/g, "")}.json`;

export const config = { maxDuration: 30 };

function appOrigin(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers.host || req.headers["x-forwarded-host"];
  return `${proto}://${host}`;
}

function sanitize(binding) {
  if (!binding) return null;
  return {
    chatId: binding.chatId,
    syncCode: binding.syncCode,
    enabled: !!binding.enabled,
    hasToken: !!binding.botToken,
    aiProvider: binding.aiProvider || "gemini",
    useAiServerKey: !!binding.aiServerKey,
    defaultAccountId: binding.defaultAccountId || null,
    registered: !!binding.registered,
    webhookUrl: binding.webhookUrl || null,
  };
}

export default async function handler(req, res) {
  const origin = allowedOrigin(req);
  cors(res, origin);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!origin || origin === "") return res.status(403).json({ error: "Origen no autorizado." });

  // ---- GET (estado del vínculo, exige syncCode) ----
  if (req.method === "GET") {
    const { syncCode, chatId } = req.query;
    if (!validSyncCode(syncCode) || !chatId) return res.status(400).json({ error: "Faltan syncCode/chatId" });
    const binding = await readJSON(bindingKey(chatId));
    if (!binding || binding.syncCode !== syncCode) return res.status(404).json({ error: "No existe vínculo para este chat." });
    return res.status(200).json({ ok: true, binding: sanitize(binding) });
  }

  if (req.method === "POST") {
    const body = req.body || {};
    const action = ["save", "test", "register"].includes(body.action) ? body.action : "save";
    const chatId = String(body.chatId || "").trim();
    const syncCode = String(body.syncCode || "").toLowerCase();
    if (!validSyncCode(syncCode) || !chatId) return res.status(400).json({ error: "Faltan syncCode/chatId válidos." });

    const key = bindingKey(chatId);

    if (action === "save") {
      const binding = { ...(await readJSON(key)), chatId, syncCode, enabled: body.enabled !== false };
      if (body.botToken && String(body.botToken).trim().length > 12) binding.botToken = String(body.botToken).trim();
      if (body.aiProvider) binding.aiProvider = body.aiProvider;
      if (typeof body.aiApiKey === "string" && body.aiApiKey.trim()) binding.aiApiKey = body.aiApiKey.trim();
      if (body.defaultAccountId) binding.defaultAccountId = body.defaultAccountId;
      if (!binding.botToken) return res.status(400).json({ error: "Se necesita el token del bot." });
      await writeJSON(key, binding);
      return res.status(200).json({ ok: true, binding: sanitize(binding) });
    }

    const binding = await readJSON(key);
    if (!binding) return res.status(404).json({ error: "Vínculo inexistente. Guárdalo primero." });
    const token = body.botToken && String(body.botToken).trim().length > 12 ? String(body.botToken).trim() : binding.botToken;

    if (action === "test") {
      try {
        await sendMessage(token, chatId, "✅ Conexión con tu bot de recibo (Mis Finanzas) establecida.");
        return res.status(200).json({ ok: true });
      } catch (e) {
        return res.status(502).json({ ok: false, error: e.message });
      }
    }

    if (action === "register") {
      if (!token) return res.status(400).json({ error: "Falta el token del bot." });
      const secret = binding.webhookSecret || `tg-${Math.random().toString(36).slice(2, 12)}${Math.random().toString(36).slice(2, 8)}`;
      const url = body.webhookUrl || `${appOrigin(req)}/api/telegram`;
      try {
        const result = await registerWebhook(token, url, secret);
        binding.webhookSecret = secret;
        binding.registered = true;
        binding.webhookUrl = url;
        await writeJSON(key, binding);
        return res.status(200).json({ ok: true, result, webhookUrl: url });
      } catch (e) {
        return res.status(502).json({ ok: false, error: e.message, webhookUrl: url });
      }
    }
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Método no permitido." });
}