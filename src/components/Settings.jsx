import { useRef, useState } from "react";
import { useStore } from "../store.jsx";
import { hasBiometricCredential, isBiometricAvailable, registerBiometric, removeBiometric } from "../auth.js";
import { CURRENCIES, DASHBOARD_CARDS, cardOn, downloadBackup, downloadCSV, fmtMoney, parseBackup, findPotentialDuplicateGroups, analyzeDuplicateValidity } from "../utils.js";
import { Btn, Field, Glass, inputCls } from "./UI.jsx";
import Users from "./Users.jsx";

const SYNC_LABEL = {
  off: ["Desactivada", "text-ink-dim"],
  pulling: ["Descargando…", "text-gold"],
  pushing: ["Guardando…", "text-gold"],
  synced: ["Sincronizado", "text-gain"],
  error: ["Error de conexión", "text-loss"],
};

function CloudSync() {
  const { sync } = useStore();
  const [code, setCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [label, tone] = SYNC_LABEL[sync.status] || SYNC_LABEL.off;

  const copy = async () => {
    await navigator.clipboard.writeText(sync.id);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Glass aria-label="Sincronización en la nube">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-base font-semibold">Sincronización en la nube</h2>
        <span className={`flex items-center gap-1.5 text-xs ${tone}`} role="status">
          <span className={`size-1.5 rounded-full ${sync.status === "synced" ? "bg-gain" : sync.status === "error" ? "bg-loss" : "bg-current"}`} aria-hidden="true" />
          {label}
        </span>
      </div>

      {!sync.id ? (
        <div className="space-y-3">
          <p className="text-sm text-ink-dim">
            Guarda tus datos en la nube y accede desde cualquier dispositivo. Se genera un código
            único que funciona como llave: guárdalo en un lugar seguro.
          </p>
          <Btn onClick={sync.enable}>☁️ Activar sincronización</Btn>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!sync.link(code)) alert("Código inválido. Revisa que esté completo.");
            }}
          >
            <input
              className={inputCls}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="O pega un código existente…"
              aria-label="Código de sincronización existente"
            />
            <Btn variant="ghost" type="submit" className="shrink-0">Conectar</Btn>
          </form>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-ink-dim">
            Tu código de sincronización (introdúcelo en otro dispositivo para ver los mismos datos):
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded-xl border border-white/12 bg-white/6 px-3 py-2 text-xs">{sync.id}</code>
            <Btn variant="ghost" onClick={copy} className="shrink-0 !py-2 text-xs">{copied ? "✓ Copiado" : "Copiar"}</Btn>
          </div>
          <div className="flex gap-2">
            <Btn variant="danger" onClick={() => { if (confirm("¿Desactivar la sincronización en este dispositivo? Los datos en la nube no se borran.")) sync.disable(); }} className="text-xs">
              Desactivar
            </Btn>
            <Btn onClick={() => sync.forcePush && sync.forcePush()} className="text-xs">
              Subir ahora
            </Btn>
            {sync.status === 'error' && (
              <Btn onClick={() => sync.retry && sync.retry()} className="text-xs">
                Reintentar
              </Btn>
            )}
          </div>
        </div>
      )}
    </Glass>
  );
}

export default function Settings({ session }) {
  const { state, dispatch } = useStore();
  const fiat = CURRENCIES.filter((c) => !["BTC", "ETH"].includes(c));

  return (
    <div className="space-y-3">
      {session?.role === "admin" && <Users session={session} />}
      <Glass aria-label="Preferencias generales">
        <h2 className="mb-3 text-base font-semibold">Preferencias</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Divisa base" hint="Todo el patrimonio se convierte en tiempo real.">
            <select
              className={inputCls}
              value={state.settings.baseCurrency}
              onChange={(e) => dispatch({ type: "set_base_currency", currency: e.target.value })}
            >
              {fiat.map((c) => <option key={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Límite de gasto mensual (EUR)">
            <input
              className={inputCls}
              type="number"
              min="0"
              step="50"
              value={state.settings.spendLimit}
              onChange={(e) => dispatch({ type: "set_limit", amount: parseFloat(e.target.value) || 0 })}
            />
          </Field>
        </div>
      </Glass>

      <DashboardCards />

      <Glass aria-label="Intereses automáticos">
        <h2 className="mb-1 text-base font-semibold">Intereses automáticos</h2>
        <p className="text-sm text-ink-dim">
          La tasa TAE y la frecuencia de abono se configuran por cuenta en <strong className="text-ink">Gestión → Cuentas</strong>.
          Las ganancias se registran solas en Movimientos.
        </p>
      </Glass>

      <Glass aria-label="Transferencias programadas">
        <h2 className="mb-2 text-base font-semibold">Transferencias programadas</h2>
        {state.scheduled.length === 0 ? (
          <p className="text-sm text-ink-dim">Ninguna. Pídeselo al asistente: «programa una transferencia de 100 el viernes».</p>
        ) : (
          <ul className="space-y-1.5 text-sm">
            {state.scheduled.map((s) => {
              const from = state.accounts.find((a) => a.id === s.fromId)?.name;
              const to = state.accounts.find((a) => a.id === s.toId)?.name;
              return (
                <li key={s.id} className="rounded-xl bg-white/5 px-3 py-2">
                  <div className="flex justify-between">
                    <span>{from} → {to} · {s.when}</span>
                    <span className="font-semibold tabular-nums">{fmtMoney(s.amount)}</span>
                  </div>
                  {s.notes && <div className="mt-0.5 text-[11px] text-ink-dim/75">📝 {s.notes}</div>}
                </li>
              );
            })}
          </ul>
        )}
      </Glass>

      <BiometricSettings session={session} />

      <AIEngine />

      <CloudSync />

      <DataTools />
    </div>
  );
}

function DashboardCards() {
  const { state, dispatch } = useStore();
  const toggle = (id) => {
    const current = state.settings.dashboardCards || {};
    dispatch({ type: "update_settings", patch: { dashboardCards: { ...current, [id]: !cardOn(state.settings, id) } } });
  };

  return (
    <Glass aria-label="Tarjetas del dashboard">
      <h2 className="mb-1 text-base font-semibold">Tarjetas del dashboard</h2>
      <p className="mb-3 text-xs text-ink-dim">
        Elige qué recuadros aparecen en Inicio. El patrimonio neto y los avisos de pago siempre se muestran.
      </p>
      <ul className="space-y-1.5">
        {DASHBOARD_CARDS.map((c) => {
          const on = cardOn(state.settings, c.id);
          return (
            <li key={c.id}>
              <label className="flex cursor-pointer items-center gap-3 rounded-xl bg-white/5 px-3 py-2.5 text-sm">
                <input
                  type="checkbox"
                  className="size-4 accent-gain"
                  checked={on}
                  onChange={() => toggle(c.id)}
                />
                <span className={on ? "text-ink" : "text-ink-dim line-through"}>{c.label}</span>
              </label>
            </li>
          );
        })}
      </ul>
    </Glass>
  );
}

function BiometricSettings({ session }) {
  const available = isBiometricAvailable();
  const [enrolled, setEnrolled] = useState(hasBiometricCredential());
  const [msg, setMsg] = useState(null);

  const enroll = async () => {
    try {
      await registerBiometric(session.username);
      setEnrolled(true);
      setMsg({ tone: "gain", text: "Face ID / huella registrado. En el próximo login podrás entrar con biometría." });
    } catch (e) {
      setMsg({ tone: "loss", text: e.message || "No se pudo registrar." });
    }
  };

  const remove = () => {
    removeBiometric();
    setEnrolled(false);
    setMsg({ tone: "gain", text: "Biometría desactivada." });
  };

  return (
    <Glass aria-label="Seguridad biométrica">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-base font-semibold">Face ID / Huella digital</h2>
        <span className={`text-xs ${enrolled ? "text-gain" : "text-ink-dim"}`} role="status">
          {enrolled ? "● Activo" : "○ Inactivo"}
        </span>
      </div>
      {!available ? (
        <p className="text-sm text-ink-dim">Tu navegador no soporta autenticación biométrica (WebAuthn).</p>
      ) : enrolled ? (
        <div className="space-y-2">
          <p className="text-sm text-ink-dim">
            Biometría activada para <strong className="text-ink">{session.username}</strong>. Al iniciar sesión se pedirá
            Face ID o huella antes de pedir contraseña.
          </p>
          <Btn variant="danger" className="text-xs" onClick={remove}>Desactivar biometría</Btn>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-sm text-ink-dim">
            Activa Face ID o huella digital para entrar sin contraseña. Se registra en este dispositivo.
          </p>
          <Btn onClick={enroll}>🔓 Activar Face ID / Huella</Btn>
        </div>
      )}
      {msg && <p role="status" className={`mt-2 text-sm ${msg.tone === "gain" ? "text-gain" : "text-loss"}`}>{msg.text}</p>}
    </Glass>
  );
}

function AIEngine() {
  const { state, dispatch } = useStore();
  const [key, setKey] = useState(state.settings.geminiKey || "");
  const [saved, setSaved] = useState(false);
  const configured = !!state.settings.geminiKey;

  const save = (e) => {
    e.preventDefault();
    dispatch({ type: "update_settings", patch: { geminiKey: key.trim() || null } });
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  return (
    <Glass aria-label="Motor de IA para escaneo">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-base font-semibold">Motor de IA para escaneo (Gemini)</h2>
        <span className={`text-xs ${configured ? "text-gain" : "text-ink-dim"}`} role="status">
          {configured ? "● Activo" : "○ Sin configurar"}
        </span>
      </div>
      <p className="mb-3 text-xs text-ink-dim">
        Con una API key gratuita de Google Gemini, el escaneo de recibos, capturas bancarias y
        transferencias usa visión por IA (mucho más preciso que el OCR local). Consigue la tuya en{" "}
        <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer" className="text-accent-soft underline">aistudio.google.com/apikey</a>.
        Se guarda en tu configuración y las imágenes se envían directamente a Google.
      </p>
      <form className="flex flex-wrap gap-2" onSubmit={save}>
        <input
          className={`${inputCls} min-w-52 flex-1`}
          type="password"
          autoComplete="off"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder="AIza…"
          aria-label="API key de Gemini"
        />
        <Btn type="submit" onClick={save} className="shrink-0">{configured ? "Actualizar" : "Guardar"}</Btn>
        {configured && (
          <Btn variant="danger" className="shrink-0 text-xs" onClick={() => { setKey(""); dispatch({ type: "update_settings", patch: { geminiKey: null } }); }}>
            Quitar
          </Btn>
        )}
      </form>
      {saved && <p role="status" className="mt-2 text-sm text-gain">✓ Guardado. El escaneo ya usa IA.</p>}
    </Glass>
  );
}

function DataTools() {
  const { state, dispatch, sync } = useStore();
  const [msg, setMsg] = useState(null); // { tone, text }
  const fileRef = useRef(null);
  const [dupGroups, setDupGroups] = useState([]);
  const [analyzingDups, setAnalyzingDups] = useState(false);

  const flash = (tone, text) => { setMsg({ tone, text }); setTimeout(() => setMsg(null), 4000); };

  const analyzeDuplicates = async () => {
    setAnalyzingDups(true);
    try {
      const txs = Array.isArray(state.transactions) ? state.transactions : [];
      if (txs.length === 0) {
        flash('loss', 'No hay transacciones');
        setAnalyzingDups(false);
        return;
      }
      const groups = findPotentialDuplicateGroups(txs);
      const analyzed = [];
      for (const g of groups) {
        const analysis = await analyzeDuplicateValidity(g, state.settings?.geminiKey);
        analyzed.push({ txs: g, ...analysis });
      }
      setDupGroups(analyzed);
      flash('gain', `Análisis completado: ${analyzed.length} grupos de duplicados potenciales.`);
    } catch (err) {
      console.error('Error analizando duplicados:', err);
      flash('loss', 'Error analizando duplicados: ' + (err?.message || 'desconocido'));
    }
    setAnalyzingDups(false);
  };

  const removeDuplicateGroup = (group) => {
    if (!confirm(`¿Eliminar los duplicados de este grupo (mantener 1 transacción)?`)) return;
    // keep the first (by id)
    const sorted = [...group.txs].sort((a, b) => a.id.localeCompare(b.id));
    const keepId = sorted[0].id;
    const toDelete = sorted.slice(1).map((t) => t.id);
    toDelete.forEach((id) => dispatch({ type: 'delete_transaction', id }));
    flash('gain', `Eliminados ${toDelete.length} duplicados.`);
    // refresh groups
    setDupGroups(prev => prev.filter((g) => g !== group));
  };

  const onFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // permitir re-subir el mismo archivo
    if (!file) return;
    try {
      const restored = parseBackup(await file.text());
      const n = restored.transactions?.length ?? 0;
      if (!confirm(`Restaurar respaldo con ${restored.accounts.length} cuentas y ${n} movimientos? Se reemplazarán los datos actuales de este dispositivo.`)) return;
      // FULL REPLACE (not merge) for backup restore: override persistent lists from backup,
      // keep volatile runtime fields (fx, priceHistory, etc.) from current state.
      // This prevents duplicating transactions from old local + backup (which caused inflated totals and erroneous txs).
      const replaced = {
        ...state,
        settings: restored.settings || state.settings,
        accounts: restored.accounts || state.accounts,
        assets: restored.assets || state.assets,
        transactions: restored.transactions || state.transactions,
        scheduled: restored.scheduled || state.scheduled,
        categories: restored.categories || state.categories,
        transferAliases: restored.transferAliases || state.transferAliases,
        categoryAliases: restored.categoryAliases || state.categoryAliases,
        statementPatterns: restored.statementPatterns || state.statementPatterns,
        _syncVersion: (restored._syncVersion || state._syncVersion || 0),
      };
      dispatch({ type: "hydrate", state: replaced });
      flash("gain", "✓ Respaldo restaurado correctamente (reemplazo completo).");
      // Auto-subir a la nube si sync está activo
      if (sync && sync.forcePush) {
        setTimeout(() => {
          sync.forcePush();
          flash("gain", "✓ Respaldo restaurado y subido a la nube.");
        }, 150);
      }
    } catch (err) {
      flash("loss", `No se pudo restaurar: ${err.message}`);
    }
  };

  return (
    <Glass aria-label="Respaldo y exportación de datos">
      <h2 className="mb-1 text-base font-semibold">Respaldo y exportación</h2>
      <p className="mb-3 text-xs text-ink-dim">
        Descarga una copia completa (JSON) para guardarla, restáurala si tienes problemas, o exporta todo a CSV para abrirlo en Excel/Sheets.
      </p>

      <div className="flex flex-wrap gap-2">
        <Btn onClick={() => downloadBackup(state)}>⬇️ Descargar respaldo (JSON)</Btn>
        <Btn variant="ghost" onClick={() => fileRef.current?.click()}>⬆️ Restaurar respaldo</Btn>
        <Btn variant="ghost" onClick={() => downloadCSV(state)}>📊 Exportar CSV</Btn>
        <input ref={fileRef} type="file" accept="application/json,.json" className="sr-only" aria-hidden="true" tabIndex={-1} onChange={onFile} />
      </div>

      <hr className="my-4 border-white/8" />
      <h3 className="mb-1 text-sm font-semibold">Limpiador inteligente de duplicados</h3>
      <p className="mb-2 text-xs text-ink-dim">Detecta transacciones con misma descripción + fecha + monto + cuenta. Usa IA (si configuras Gemini) para decidir si es válida (ej. intereses de fin de semana registrados el lunes) o error. Elimina solo los duplicados erróneos.</p>
      <Btn onClick={analyzeDuplicates} disabled={analyzingDups}>
        {analyzingDups ? 'Analizando con IA...' : 'Analizar duplicados potenciales'}
      </Btn>

      {dupGroups.length > 0 && (
        <div className="mt-3 space-y-2 text-xs">
          {dupGroups.map((g, i) => (
            <div key={i} className="rounded border border-white/10 p-2 bg-white/5">
              <div className="font-medium">Grupo {i+1}: {g.txs.length} transacciones idénticas</div>
              <ul className="ml-2 list-disc">
                {g.txs.slice(0,3).map((t) => <li key={t.id}>{t.date} — {t.description.slice(0,30)} — {fmtMoney(t.amount, t.currency)}</li>)}
                {g.txs.length > 3 && <li>... y {g.txs.length-3} más</li>}
              </ul>
              <div className={`mt-1 ${g.isValid ? 'text-gain' : 'text-loss'}`}>
                IA: {g.isValid ? '✅ Válida (repetida legítima)' : '❌ Duplicado erróneo'} — {g.reason} (confianza {Math.round((g.confidence||0)*100)}%)
              </div>
              {!g.isValid && (
                <Btn variant="danger" className="mt-1 text-xs" onClick={() => removeDuplicateGroup(g)}>
                  Eliminar duplicados (mantener 1)
                </Btn>
              )}
            </div>
          ))}
        </div>
      )}

      {msg && (
        <p role="status" className={`mt-3 text-sm ${msg.tone === "gain" ? "text-gain" : "text-loss"}`}>{msg.text}</p>
      )}

      <hr className="my-4 border-white/8" />
      <p className="mb-2 text-xs text-ink-dim">
        Tus datos viven en este dispositivo (localStorage) y, si activas la sincronización, también en la nube bajo tu código único.
      </p>
      <Btn variant="danger" onClick={() => { if (confirm("¿Restablecer todos los datos de demostración? Perderás los cambios locales no respaldados.")) dispatch({ type: "reset" }); }}>
        Restablecer datos demo
      </Btn>
    </Glass>
  );
}
