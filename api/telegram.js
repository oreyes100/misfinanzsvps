// telegram.js — Webhook del bot de recibos.
//
//   POST /api/telegram   (firmado con X-Telegram-Bot-Api-Secret-Token)
//     - message con foto/PDF  → clasifica con IA y responde con propuesta +
//                               botones ✅ Registrar / ❌ Descartar.
//     - callback_query        → aprueba/descarta y asienta (o no) la propuesta
//                               contra el estado sync del chat vinculado.
//   GET  /api/telegram?chatId=...&syncCode=...  → diagnóstico + getWebhookInfo.
//
// Principio (heredado de Cuentas): la aprobación humana es obligatoria. El bot
// nunca asienta sin el botón ✅.
import { readJSON, writeJSON } from "../lib/blob-json.js";
import { classifyImage } from "../lib/ai.js";
import { loadSyncState, updateSyncState, addProposedTransactions, learnAccountAliases, validSyncCode } from "../lib/state-store.js";
import { sendMessage, answerCallbackQuery, editMessageReplyMarkup, getFile, downloadFile, inlineKeyboard, webhookInfo } from "../lib/telegram.js";

const bindingKey = (chatId) => `telegram/bindings/${String(chatId).replace(/[^0-9-]/g, "")}.json`;
const proposalKey = (chatId, msgId) => `telegram/proposals/${String(chatId).replace(/[^0-9-]/g, "")}/${msgId}.json`;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

export const config = { maxDuration: 60 };

const TYPE_LABEL = { receipt: "Recibo", statement: "Estado de cuenta", transfer: "Transferencia" };

function appOrigin(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers.host || req.headers["x-forwarded-host"];
  return `${proto}://${host}`;
}

function isImageMime(mime, name) {
  if (/^image\/(jpe?g|png|webp|gif|heic|heif)$/.test(mime || "")) return true;
  if (mime === "application/pdf") return true;
  return /\.(jpe?g|png|webp|gif|heic|heif|pdf)$/i.test(name || "");
}

function buildReplyText(result, defaultAccountName) {
  const lines = [];
  const label = TYPE_LABEL[result.type] || "Documento";
  const txs = result.transactions || [];
  const currency = result.currency || "";
  if (txs.length > 1) {
    lines.push(`🧾 ${label}${result.merchant ? " · " + result.merchant : ""} (${txs.length} movimientos)`);
    for (const t of txs) {
      const acc = result.accountName || defaultAccountName || "— elegir";
      lines.push(`• ${t.direction === "in" ? "⬆" : "⬇"} ${t.amount.toFixed(2)} ${currency} · ${t.date || "?"} · ${t.description || ""} · ${t.category || "sin categoría"}`);
      lines.push(`  🏦 ${acc}`);
    }
  } else {
    const t = txs[0] || {};
    lines.push(`🧾 ${label}${result.merchant ? " · " + result.merchant : ""}`);
    lines.push(`💵 ${t.amount != null ? t.amount.toFixed(2) + " " + currency : "monto no claro"} · ${t.direction === "in" ? "entrada" : "salida"}`);
    if (t.date) lines.push(`📅 ${t.date}`);
    if (t.description) lines.push(`🏷 ${t.description}`);
    lines.push(`📂 ${t.category || "sin categoría"}`);
    lines.push(`🏦 Cuenta: ${result.accountName || defaultAccountName || "— seleccionar en la app"}`);
  }
  lines.push(`🤖 Confianza: ${Math.round((result.confidence || 0) * 100)}%${(result.confidence || 0) < 0.6 ? " ⚠️ revisa importes" : ""}`);
  lines.push("");
  lines.push("¿Registro esta(s) transacción(es)?");
  return lines.join("\n");
}

// ---- Manejador de la aprobación/descartes (callback_query) ----
async function handleCallback(update, binding, chatId) {
  const cb = update.callback_query;
  const [verb, msgId] = String(cb.data || "").split(":");
  if (!["ap", "rj"].includes(verb) || !msgId) {
    await answerCallbackQuery(binding.botToken, cb.id, "Acción desconocida");
    return;
  }
  const proposal = await readJSON(proposalKey(chatId, msgId));
  if (!proposal) {
    await answerCallbackQuery(binding.botToken, cb.id, "Propuesta no encontrada");
    return;
  }
  if (proposal.status !== "pending") {
    await answerCallbackQuery(binding.botToken, cb.id, `Ya fue ${proposal.status === "approved" ? "aprobada" : "descartada"}`);
    return;
  }

  const from = cb.from?.username || cb.from?.first_name || "Telegram";
  if (verb === "rj") {
    proposal.status = "rejected";
    proposal.resolvedBy = from;
    proposal.resolvedAt = new Date().toISOString();
    await writeJSON(proposalKey(chatId, msgId), proposal);
    await editMessageReplyMarkup(binding.botToken, chatId, msgId, inlineKeyboard([[{ text: "❌ Descartado", data: "noop" }]]));
    await answerCallbackQuery(binding.botToken, cb.id, "Descartado", false);
    return;
  }

  // ---- Aprobar: asentar contra el estado sync ----
  const rows = Array.isArray(proposal.rows) ? proposal.rows : [];
  const toAdd = rows.map((r) => ({ ...r, accountId: r.accountId || binding.defaultAccountId || null }))
    .filter((r) => r.accountId && r.amount != null);
  if (toAdd.length === 0) {
    proposal.status = "error";
    proposal.error = "Sin cuenta asignada";
    proposal.resolvedBy = from;
    proposal.resolvedAt = new Date().toISOString();
    await writeJSON(proposalKey(chatId, msgId), proposal);
    await editMessageReplyMarkup(binding.botToken, chatId, msgId, inlineKeyboard([[{ text: "⚠️ Sin cuenta", data: "noop" }]]));
    await answerCallbackQuery(binding.botToken, cb.id, "No registrado: sin cuenta asignada", true);
    return;
  }

  const hints = proposal.hints || [];
  const accountId = toAdd[0].accountId;
  try {
    await updateSyncState(binding.syncCode, (s) => {
      s = addProposedTransactions(s, toAdd);
      if (hints.length) s = learnAccountAliases(s, hints, accountId);
      return s;
    });
    proposal.status = "approved";
    proposal.resolvedBy = from;
    proposal.resolvedAt = new Date().toISOString();
    const total = toAdd.reduce((a, r) => a + Math.abs(+r.amount || 0), 0);
    proposal.appliedTotal = Math.round(total * 100) / 100;
    await writeJSON(proposalKey(chatId, msgId), proposal);
    const done = `✅ Registradas ${toAdd.length} transacción(es) · total ${proposal.appliedTotal.toFixed(2)}`;
    await editMessageReplyMarkup(binding.botToken, chatId, msgId, inlineKeyboard([[{ text: "✅ Registrado", data: "noop" }]]));
    await sendMessage(binding.botToken, chatId, done);
    await answerCallbackQuery(binding.botToken, cb.id, "Registrado ✓");
  } catch (e) {
    proposal.status = "error";
    proposal.error = e.message;
    await writeJSON(proposalKey(chatId, msgId), proposal);
    await answerCallbackQuery(binding.botToken, cb.id, `Error al registrar: ${e.message.slice(0, 60)}`, true);
  }
}

// ---- Manejador de un mensaje con foto/documento ----
async function handleMessage(update, binding, chatId) {
  const msg = update.message;
  const msgId = msg.message_id;

  let fileId = null;
  let fileName = null;
  let mime = null;
  if (Array.isArray(msg.photo) && msg.photo.length) {
    const largest = msg.photo[msg.photo.length - 1];
    fileId = largest.file_id;
    mime = "image/jpeg";
  } else if (msg.document) {
    if (!isImageMime(msg.document.mime_type, msg.document.file_name)) {
      await sendMessage(binding.botToken, chatId, "Solo acepto imágenes o PDF (recibos).");
      return;
    }
    fileId = msg.document.file_id;
    fileName = msg.document.file_name;
    mime = msg.document.mime_type || "image/jpeg";
  }
  if (!fileId) return;

  const finfo = await getFile(binding.botToken, fileId);
  if (!finfo?.file_path) {
    await sendMessage(binding.botToken, chatId, "No pude acceder al archivo. Intenta de nuevo.");
    return;
  }
  const buf = await downloadFile(binding.botToken, finfo.file_path);
  if (buf.length > MAX_FILE_BYTES) {
    await sendMessage(binding.botToken, chatId, "El archivo supera los 8 MB.");
    return;
  }
  if (!isImageMime(mime, fileName) && !/^image\//.test(mime || "")) {
    await sendMessage(binding.botToken, chatId, "Solo acepto imágenes o PDF.");
    return;
  }

  const state = await loadSyncState(binding.syncCode);
  const accounts = state?.accounts || [];
  const categories = state?.categories || [];
  const aliases = state?.transferAliases || {};

  const provider = binding.aiProvider || "gemini";
  const apiKey = binding.aiApiKey || process.env["GEMINI_API_KEY"] || process.env["OPENAI_API_KEY"] || process.env["ANTHROPIC_API_KEY"];
  if (!apiKey) {
    await sendMessage(binding.botToken, chatId, "El bot no tiene clave de IA configurada (vincúlalo desde la app).");
    return;
  }

  let result;
  try {
    result = await classifyImage({ mime: isImageMime(mime, fileName) && mime !== "application/pdf" ? mime : (mime || "image/jpeg"), base64: buf.toString("base64") }, {
      provider, apiKey, categories, accounts, aliases,
    });
  } catch (e) {
    await sendMessage(binding.botToken, chatId, `No pude leer la imagen con la IA: ${e.message}`);
    return;
  }

  const rows = (result.transactions || []).map((t) => ({
    description: t.description,
    amount: t.amount,
    direction: t.direction,
    currency: result.currency || accounts[0]?.currency || "EUR",
    category: t.category || null,
    date: t.date || result.date || null,
    accountId: result.accountId || null,
  }));

  const defaultAccountName = binding.defaultAccountId
    ? (accounts.find((a) => a.id === binding.defaultAccountId)?.name || null)
    : null;

  const sent = await sendMessage(binding.botToken, chatId, buildReplyText(result, defaultAccountName), {
    reply_markup: inlineKeyboard([
      [{ text: "✅ Registrar", data: `ap:${msgId}` }, { text: "❌ Descartar", data: `rj:${msgId}` }],
    ]),
  });

  await writeJSON(proposalKey(chatId, msgId), {
    id: msgId,
    chatId,
    status: "pending",
    createdAt: new Date().toISOString(),
    syncCode: binding.syncCode,
    result,
    rows,
    hints: result.accountHints || [],
    messageId: sent?.message_id || msgId,
    fileName,
  });
}

export default async function handler(req, res) {
  // ---- GET: diagnóstico ----
  if (req.method === "GET") {
    const { chatId, syncCode } = req.query;
    if (chatId && syncCode && validSyncCode(syncCode)) {
      const binding = await readJSON(bindingKey(chatId));
      if (binding && binding.syncCode === syncCode) {
        let info = null;
        try { info = await webhookInfo(binding.botToken); } catch { /* sin token */ }
        return res.status(200).json({
          ok: true,
          chatId, bound: true, enabled: !!binding.enabled, registered: !!binding.registered,
          webhookUrl: binding.webhookUrl || null,
          webhookInfo: info,
        });
      }
      return res.status(200).json({ ok: true, chatId, bound: false });
    }
    return res.status(200).json({
      ok: true,
      note: "Webhook del bot de Mis Finanzas. Envía una foto de recibo.",
      secretConfigured: !!process.env.TELEGRAM_WEBHOOK_SECRET,
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Método no permitido." });
  }

  const update = req.body;
  if (!update) return res.status(400).json({ error: "update inválido" });

  const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id;
  if (!chatId) return res.status(200).end();

  const binding = await readJSON(bindingKey(chatId));
  if (!binding || !binding.enabled) return res.status(200).end(); // chat no vinculado

  // Firma del webhook: secreto por chat (o env como fallback).
  const secret = binding.webhookSecret || process.env.TELEGRAM_WEBHOOK_SECRET;
  const header = req.headers["x-telegram-bot-api-secret-token"];
  if (secret && header !== secret) return res.status(401).json({ error: "Unauthorized" });

  try {
    if (update.callback_query) await handleCallback(update, binding, chatId);
    else if (update.message) await handleMessage(update, binding, chatId);
  } catch (e) {
    // No queremos que Telegram reintente: respondemos 200 igualmente.
    console.error("telegram webhook error:", e.message);
  }
  return res.status(200).end();
}