// notifications.mjs — W30 Fase 6: avisos proactivos del loop por Telegram.
// Usa el bot vinculado (binding) — el mismo canal donde el usuario reacciona 🚀.
import fs from "node:fs";
import path from "node:path";
import { sendMessage } from "../../lib/telegram.js";
import { DATA_DIR } from "../db.mjs";

const BINDINGS_DIR = path.join(DATA_DIR, "blobs", "telegram", "bindings");

/** Envía a todos los bindings habilitados (normalmente 1 chat). Devuelve resultados. */
export async function notify(text) {
  const out = [];
  try {
    if (!fs.existsSync(BINDINGS_DIR)) return out;
    for (const f of fs.readdirSync(BINDINGS_DIR)) {
      try {
        const b = JSON.parse(fs.readFileSync(path.join(BINDINGS_DIR, f), "utf8"));
        if (!b.enabled || !b.botToken) continue;
        const res = await sendMessage(b.botToken, b.chatId, text);
        out.push({ chatId: b.chatId, ok: !!res });
      } catch (e) {
        out.push({ chatId: f, ok: false, error: String(e?.message || e).slice(0, 100) });
      }
    }
  } catch (e) {
    console.error("[notify] error:", e?.message || e);
  }
  return out;
}
