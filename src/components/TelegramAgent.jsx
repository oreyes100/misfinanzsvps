import { useEffect, useState } from "react";
import { useStore } from "../store.jsx";
import { API_BASE } from "../utils.js";
import { AI_PROVIDERS } from "../ai.js";
import { Btn, Field, Glass, inputCls } from "./UI.jsx";

const api = async (url, body) => {
  const r = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
};

export default function TelegramAgent() {
  const { state, sync } = useStore();
  const syncCode = sync?.id || "";

  const [chatId, setChatId] = useState("");
  const [botToken, setBotToken] = useState("");
  const [provider, setProvider] = useState(state.settings.aiProvider || "gemini");
  const [aiApiKey, setAiApiKey] = useState("");
  const [defaultAccountId, setDefaultAccountId] = useState("");
  const [enabled, setEnabled] = useState(true);

  const [binding, setBinding] = useState(null); // { enabled, registered, webhookUrl, hasToken, ... }
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);

  const flash = (tone, text) => { setMsg({ tone, text }); setTimeout(() => setMsg(null), 5000); };

  const check = async () => {
    if (!syncCode || !chatId.trim()) return;
    const r = await api(`${API_BASE}/api/telegram-config?syncCode=${encodeURIComponent(syncCode)}&chatId=${encodeURIComponent(chatId.trim())}`);
    if (r.status === 200 && r.data?.binding) {
      setBinding(r.data.binding);
      setEnabled(!!r.data.binding.enabled);
      setProvider(r.data.binding.aiProvider || "gemini");
      if (r.data.binding.defaultAccountId) setDefaultAccountId(r.data.binding.defaultAccountId);
    } else {
      setBinding(null);
    }
  };
  useEffect(() => { check(); }, [chatId, syncCode]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!syncCode) { flash("loss", "Activa la sincronización en la nube primero."); return; }
    if (!chatId.trim()) { flash("loss", "Escribe el chat_id."); return; }
    if (!botToken.trim()) { flash("loss", "Escribe el token del bot (de @BotFather)."); return; }
    setBusy(true);
    const r = await api(`${API_BASE}/api/telegram-config`, {
      action: "save", syncCode, chatId: chatId.trim(), botToken: botToken.trim(),
      provider, aiApiKey: aiApiKey.trim() || undefined,
      defaultAccountId: defaultAccountId || undefined, enabled,
    });
    setBusy(false);
    if (r.status === 200) { flash("gain", "✓ Vínculo guardado."); check(); setBotToken(""); }
    else flash("loss", r.data?.error || "No se pudo guardar.");
  };

  const test = async () => {
    if (!syncCode || !chatId.trim()) { flash("loss", "Guarda el vínculo primero."); return; }
    setBusy(true);
    const r = await api(`${API_BASE}/api/telegram-config`, { action: "test", syncCode, chatId: chatId.trim(), botToken: botToken.trim() || undefined });
    setBusy(false);
    if (r.status === 200 && r.data?.ok) flash("gain", "📨 Mensaje de prueba enviado a tu chat.");
    else flash("loss", r.data?.error || "No se pudo enviar (revisa token y que hayas hablado con el bot).");
  };

  const register = async () => {
    if (!syncCode || !chatId.trim()) { flash("loss", "Guarda el vínculo primero."); return; }
    setBusy(true);
    const r = await api(`${API_BASE}/api/telegram-config`, { action: "register", syncCode, chatId: chatId.trim(), botToken: botToken.trim() || undefined });
    setBusy(false);
    if (r.status === 200 && r.data?.ok) { flash("gain", "🔗 Webhook registrado. El bot ya recibe imágenes."); check(); }
    else flash("loss", (r.data?.error || "No se pudo registrar") + (r.data?.webhookUrl ? ` (${r.data.webhookUrl})` : ""));
  };

  if (!syncCode) {
    return (
      <Glass aria-label="Bot de Telegram">
        <h2 className="mb-2 text-base font-semibold">Agente por Telegram</h2>
        <p className="text-sm text-ink-dim">Activa la <strong className="text-ink">sincronización en la nube</strong> primero: el bot registra movimientos en tu código de sync.</p>
      </Glass>
    );
  }

  return (
    <Glass aria-label="Agente de Telegram">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-base font-semibold">Agente por Telegram (recibos)</h2>
        <label className="flex cursor-pointer items-center gap-1.5 text-xs">
          <span className={enabled ? "text-gain" : "text-ink-dim"}>{enabled ? "● Activo" : "○ Apagado"}</span>
          <input type="checkbox" className="size-4 accent-gain" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        </label>
      </div>
      <p className="mb-3 text-xs text-ink-dim">
        Envía la foto de un recibo a tu bot y recibe la propuesta con botones <strong className="text-ink">✅ Registrar / ❌ Descartar</strong>.
        Nada entra sin tu aprobación.
      </p>

      <div className="mb-3 rounded-xl border border-accent/20 bg-accent/8 p-3 text-xs text-ink-dim">
        <strong className="text-ink">Pasos:</strong> ① crea el bot con <strong className="text-ink">@BotFather</strong> y copia su token ·
        ② consigue tu chat_id (mensajea a <strong className="text-ink">@userinfobot</strong> o míralo en getUpdates del bot) ·
        ③ pega ambos aquí y guarda · ④ envía un mensaje de prueba · ⑤ registra el webhook.
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Token del bot (@BotFather)" hint="Solo se guarda en el servidor, nunca se muestra de vuelta.">
          <input className={inputCls} type="password" autoComplete="off" value={botToken} onChange={(e) => setBotToken(e.target.value)} placeholder="123456:ABC-DEF…" />
        </Field>
        <Field label="chat_id" hint="Número del chat (grupo negativo o privado).">
          <input className={inputCls} value={chatId} onChange={(e) => setChatId(e.target.value)} placeholder="-1001234567890" />
        </Field>

        <Field label="Motor de IA del bot">
          <select className={inputCls} value={provider} onChange={(e) => setProvider(e.target.value)}>
            {AI_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>

        <Field label="API key para el bot (opcional)" hint="Vacía → usa la clave del servidor.">
          <input className={inputCls} type="password" autoComplete="off" value={aiApiKey} onChange={(e) => setAiApiKey(e.target.value)} placeholder="AIza… / sk-…" />
        </Field>

        <Field label="Cuenta por defecto" hint="Se usa cuando la IA no identifica el banco en la imagen.">
          <select className={inputCls} value={defaultAccountId} onChange={(e) => setDefaultAccountId(e.target.value)}>
            <option value="">— ninguna —</option>
            {state.accounts.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>)}
          </select>
        </Field>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        <Btn onClick={save} disabled={busy}>💾 Vincular y guardar</Btn>
        <Btn variant="ghost" onClick={test} disabled={busy}>📨 Mensaje de prueba</Btn>
        <Btn variant="ghost" onClick={register} disabled={busy}>🔗 Registrar webhook</Btn>
      </div>

      {msg && <p role="status" className={`mt-2 text-sm ${msg.tone === "gain" ? "text-gain" : "text-loss"}`}>{msg.text}</p>}

      {binding && (
        <div className="mt-3 rounded-xl bg-white/5 px-3 py-2 text-xs text-ink-dim">
          <div><span className={binding.enabled ? "text-gain" : "text-loss"}>{binding.enabled ? "● Activo" : "○ Apagado"}</span> · token {binding.hasToken ? "guardado" : "sin token"} · webhook {binding.registered ? "✅ registrado" : "— sin registrar"}</div>
          {binding.webhookUrl && <div className="mt-1 font-mono truncate">{binding.webhookUrl}</div>}
          {binding.registered && (
            <p className="mt-1 text-[10px]">
              Abre Telegram y envía una foto de recibo al bot. Responde con ✅ en el chat para registrarlo.
            </p>
          )}
        </div>
      )}
    </Glass>
  );
}