// telegram.js — Helpers de la Bot API de Telegram (webhook agent).
const API = "https://api.telegram.org";

async function call(token, method, body) {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : "{}",
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || out.ok === false) {
    const err = new Error(out.description || `Telegram ${res.status}`);
    err.telegram = out;
    throw err;
  }
  return out.result;
}

export async function sendMessage(token, chatId, text, opts = {}) {
  return call(token, "sendMessage", { chat_id: chatId, text, ...(opts.parse_mode ? { parse_mode: opts.parse_mode } : {}), ...(opts.reply_markup ? { reply_markup: opts.reply_markup } : {}) });
}

export async function editMessageReplyMarkup(token, chatId, messageId, replyMarkup) {
  return call(token, "editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: replyMarkup });
}

export async function answerCallbackQuery(token, callbackQueryId, text, showAlert = false) {
  return call(token, "answerCallbackQuery", { callback_query_id: callbackQueryId, text, show_alert: showAlert });
}

export async function getFile(token, fileId) {
  return call(token, "getFile", { file_id: fileId });
}

export async function downloadFile(token, filePath) {
  const res = await fetch(`${API}/file/bot${token}/${filePath}`);
  if (!res.ok) throw new Error(`Descarga del archivo falló (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

export async function registerWebhook(token, url, secret) {
  return call(token, "setWebhook", { url, secret_token: secret, allowed_updates: ["message", "callback_query"] });
}

export async function webhookInfo(token) {
  return call(token, "getWebhookInfo", {});
}

export function inlineKeyboard(rows) {
  return { inline_keyboard: rows.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) };
}