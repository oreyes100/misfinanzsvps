import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useStore } from "../store.jsx";
import { monthSpend } from "../selectors.js";
import { fmtMoney, parseIntent, todayISO } from "../utils.js";
import { Btn, Glass, inputCls } from "./UI.jsx";

const SUGGESTIONS = [
  "Gasté 20 euros en cena",
  "Ingreso de 150 por venta",
  "Transfiere 200 de Corriente a Ahorro",
  "Ajusta mi límite de gasto a 900",
];

function resolveAccount(state, name, fallbackIdx) {
  if (name) {
    const n = name.toLowerCase().trim();
    const exact = state.accounts.find((a) => a.name.toLowerCase() === n);
    if (exact) return exact;
    const partial = state.accounts.find((a) => a.name.toLowerCase().includes(n));
    if (partial) return partial;
    const reverse = state.accounts.find((a) => n.includes(a.name.toLowerCase()));
    if (reverse) return reverse;
    const words = n.split(/\s+/);
    const wordMatch = state.accounts.find((a) =>
      words.some((w) => w.length > 2 && a.name.toLowerCase().includes(w))
    );
    if (wordMatch) return wordMatch;
  }
  return state.accounts[fallbackIdx];
}

const isCapacitor = typeof window !== "undefined" && !!window.Capacitor?.isNativePlatform?.();

/** Asistente agéntico: analiza, previsualiza la acción y la ejecuta solo tras aprobación humana. */
export default function Assistant() {
  const { state, dispatch } = useStore();
  const [messages, setMessages] = useState([
    { role: "ai", text: "Hola 👋 Soy tu asistente financiero. Puedo registrar gastos, programar transferencias o ajustar límites. Toda acción te la muestro antes de ejecutarla." },
  ]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(null);
  const [listening, setListening] = useState(false);
  const recRef = useRef(null);
  const logRef = useRef(null);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, pending]);

  const push = (m) => setMessages((prev) => [...prev, m]);

  const analyze = (text) => {
    if (!text.trim()) return;
    push({ role: "user", text });
    setInput("");
    const intent = parseIntent(text, state.categories);

    if (intent.type === "unknown") {
      const spend = monthSpend(state);
      const limit = state.settings.spendLimit;
      push({
        role: "ai",
        text: `No he identificado una acción concreta. Mientras tanto, un dato: llevas ${fmtMoney(spend)} gastados este mes (${Math.round((spend / limit) * 100)} % de tu límite de ${fmtMoney(limit)}). Prueba con «gasté 20 euros en cena».`,
      });
      return;
    }

    if (intent.type === "expense" || intent.type === "income") {
      if (intent.accountName) {
        const acc = resolveAccount(state, intent.accountName, 0);
        if (acc) intent._resolvedAccount = acc;
      }
    }

    push({ role: "ai", text: `Entendido. Esta es la acción que voy a realizar — revísala y aprueba:` });
    setPending(intent);
  };

  const logAction = (intent, result, detail = "") => {
    try {
      const prev = JSON.parse(localStorage.getItem("mis-finazas-assistant-log") ?? "[]");
      prev.push({ ts: new Date().toISOString(), type: intent.type, amount: intent.amount, result, detail });
      localStorage.setItem("mis-finazas-assistant-log", JSON.stringify(prev));
    } catch {}
  };

  const approve = () => {
    const intent = pending;
    setPending(null);
    switch (intent.type) {
      case "expense":
      case "income": {
        if (!state.accounts.length) {
          push({ role: "ai", text: `⚠ No hay cuentas configuradas. Crea una cuenta antes de registrar movimientos.` });
          logAction(intent, "preflight_fail", "no accounts");
          return;
        }
        const acc = intent._resolvedAccount || state.accounts[0];
        if (intent.type === "expense" && acc.balance < intent.amount) {
          push({ role: "ai", text: `⚠ Saldo insuficiente en ${acc.name} (${fmtMoney(acc.balance)}). ¿Confirmar de todas formas?` });
          logAction(intent, "preflight_warn", `balance ${acc.balance} < ${intent.amount}`);
        }
        dispatch({
          type: "add_transaction",
          tx: {
            description: intent.description,
            amount: intent.type === "expense" ? -intent.amount : intent.amount,
            currency: acc.currency,
            accountId: acc.id,
            category: intent.category,
            subcategory: intent.subcategory || null,
          },
        });
        push({ role: "ai", text: `✓ Registrado: ${intent.summary} en ${acc.name}. Categoría asignada automáticamente con ${Math.round((intent.confidence ?? 0.9) * 100)} % de confianza.`, ok: true });
        logAction(intent, "ok", `account:${acc.id}`);
        break;
      }
      case "transfer": {
        const from = resolveAccount(state, intent.fromName, 0);
        const to = resolveAccount(state, intent.toName, 1);
        if (from.id === to.id) {
          push({ role: "ai", text: `⚠ No puedo ejecutarla: origen y destino coinciden.` });
          logAction(intent, "preflight_fail", "same account");
          return;
        }
        dispatch({ type: "transfer", fromId: from.id, toId: to.id, amount: intent.amount });
        push({ role: "ai", text: `✓ Transferencia ejecutada: ${fmtMoney(intent.amount, from.currency)} de ${from.name} a ${to.name}.`, ok: true });
        logAction(intent, "ok", `${from.id}->${to.id}`);
        break;
      }
      case "schedule_transfer": {
        const from = resolveAccount(state, intent.fromName, 0);
        const to = resolveAccount(state, intent.toName, 1);
        if (from.id === to.id) {
          push({ role: "ai", text: `⚠ Origen y destino coinciden. No se puede programar.` });
          logAction(intent, "preflight_fail", "same account");
          return;
        }
        dispatch({ type: "schedule_transfer", item: { fromId: from.id, toId: to.id, amount: intent.amount, when: "próximo día hábil", created: todayISO() } });
        push({ role: "ai", text: `✓ Transferencia programada: ${fmtMoney(intent.amount)} de ${from.name} a ${to.name}. La verás en Ajustes → Programadas.`, ok: true });
        logAction(intent, "ok", `scheduled:${from.id}->${to.id}`);
        break;
      }
      case "set_limit": {
        if (intent.amount <= 0) {
          push({ role: "ai", text: `⚠ El límite debe ser mayor que 0.` });
          logAction(intent, "preflight_fail", `amount=${intent.amount}`);
          return;
        }
        dispatch({ type: "set_limit", amount: intent.amount });
        push({ role: "ai", text: `✓ Límite de gasto mensual actualizado a ${fmtMoney(intent.amount)}.`, ok: true });
        logAction(intent, "ok");
        break;
      }
    }
  };

  const reject = () => {
    setPending(null);
    push({ role: "ai", text: "Acción descartada. Nada se ha modificado." });
  };

  // ---- Voice: Capacitor native (Android/iOS) ----
  const toggleVoiceNative = async () => {
    if (listening) {
      try {
        const { SpeechRecognition } = await import("@capacitor-community/speech-recognition");
        await SpeechRecognition.stop();
      } catch {}
      setListening(false);
      return;
    }
    try {
      const { SpeechRecognition } = await import("@capacitor-community/speech-recognition");
      const { available } = await SpeechRecognition.available();
      if (!available) {
        push({ role: "ai", text: "Reconocimiento de voz no disponible en este dispositivo." });
        return;
      }
      try {
        await SpeechRecognition.requestPermissions();
      } catch {
        push({ role: "ai", text: "Permiso de micrófono denegado. Habilítalo en Ajustes del sistema." });
        return;
      }
      setListening(true);
      const result = await SpeechRecognition.start({
        language: "es-MX",
        prompt: "Dime tu operación financiera",
        partialResults: false,
        popup: true,
      });
      setListening(false);
      if (result.matches?.length && result.matches[0].trim()) {
        analyze(result.matches[0].trim());
      } else {
        push({ role: "ai", text: "No pude entender lo que dijiste. Habla más claro y cerca del micrófono." });
      }
    } catch (err) {
      setListening(false);
      push({ role: "ai", text: `Error de voz: ${err.message || "desconocido"}. Intenta de nuevo.` });
    }
  };

  // ---- Voice: Web Speech API (browsers) ----
  const toggleVoiceWeb = () => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      push({ role: "ai", text: "Tu navegador no soporta reconocimiento de voz. Prueba en Chrome o Safari." });
      return;
    }
    if (listening) {
      recRef.current?.stop();
      setListening(false);
      return;
    }
    const rec = new SR();
    rec.lang = "es-MX";
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 3;

    let finalTranscript = "";

    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          finalTranscript += e.results[i][0].transcript;
        }
      }
    };

    rec.onend = () => {
      setListening(false);
      if (finalTranscript.trim()) {
        analyze(finalTranscript.trim());
      } else {
        push({ role: "ai", text: "No pude entender lo que dijiste. Habla más claro y cerca del micrófono." });
      }
    };

    rec.onerror = (e) => {
      setListening(false);
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        push({ role: "ai", text: "Permiso de micrófono denegado. Habilítalo en la configuración de tu navegador." });
      } else if (e.error === "no-speech") {
        push({ role: "ai", text: "No detecté voz. Habla más fuerte o acércate al micrófono." });
      } else if (e.error === "network") {
        push({ role: "ai", text: "Error de red en reconocimiento de voz. Verifica tu conexión." });
      } else if (e.error === "aborted") {
        // user aborted, no message
      } else {
        push({ role: "ai", text: `Error de reconocimiento (${e.error}). Intenta de nuevo.` });
      }
    };

    recRef.current = rec;
    setListening(true);
    rec.start();
  };

  const toggleVoice = () => {
    if (isCapacitor) return toggleVoiceNative();
    return toggleVoiceWeb();
  };

  return (
    <Glass className="flex h-[calc(100dvh-11rem)] flex-col" aria-label="Asistente de IA">
      <header className="mb-3 flex items-center gap-2">
        <span className="flex size-8 items-center justify-center rounded-full bg-accent/20 text-accent-soft" aria-hidden="true">✦</span>
        <div>
          <h2 className="text-base font-semibold leading-tight">Asistente IA</h2>
          <p className="text-xs text-ink-dim">Agéntico · supervisión humana en cada acción</p>
        </div>
      </header>

      <div ref={logRef} className="flex-1 space-y-2 overflow-y-auto pr-1" role="log" aria-live="polite" aria-label="Conversación con el asistente">
        {messages.map((m, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.2 }}
            className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${
              m.role === "user"
                ? "ml-auto bg-accent/25 text-ink"
                : m.ok ? "bg-gain/12 text-ink ring-1 ring-gain/30" : "bg-white/8 text-ink"
            }`}
          >
            {m.text}
          </motion.div>
        ))}

        <AnimatePresence>
          {pending && (
            <motion.div
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96 }}
              className="rounded-2xl border border-accent/40 bg-accent/10 p-3.5"
              role="region"
              aria-label="Acción pendiente de aprobación"
            >
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-accent-soft">Previsualización de acción</p>
              <p className="mb-3 text-sm">{pending.summary}</p>
              <div className="flex gap-2">
                <Btn variant="gain" onClick={approve} className="!py-1.5 text-xs">Aprobar y ejecutar</Btn>
                <Btn variant="ghost" onClick={reject} className="!py-1.5 text-xs">Descartar</Btn>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5" aria-label="Sugerencias">
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => analyze(s)}
            className="pressable rounded-full border border-white/12 bg-white/6 px-3 py-1 text-xs text-ink-dim hover:text-ink"
          >
            {s}
          </button>
        ))}
      </div>

      <form
        className="mt-2 flex gap-2"
        onSubmit={(e) => { e.preventDefault(); analyze(input); }}
      >
        <input
          className={inputCls}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder='Escribe o dicta: "gasté 20 euros en cena"'
          aria-label="Mensaje para el asistente"
        />
        <Btn
          variant={listening ? "danger" : "ghost"}
          onClick={toggleVoice}
          aria-pressed={listening}
          aria-label={listening ? "Detener dictado por voz" : "Activar dictado por voz"}
          className="shrink-0 !px-3"
        >
          {listening ? (
            <motion.span animate={{ scale: [1, 1.25, 1] }} transition={{ repeat: Infinity, duration: 0.9 }} aria-hidden="true">●</motion.span>
          ) : (
            "🎙"
          )}
        </Btn>
        <Btn type="submit" className="shrink-0">Enviar</Btn>
      </form>
    </Glass>
  );
}
