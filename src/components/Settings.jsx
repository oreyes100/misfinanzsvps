import { useEffect, useRef, useState } from "react";
import { useStore } from "../store.jsx";
import { hasBiometricCredential, isBiometricAvailable, registerBiometric, removeBiometric } from "../auth.js";
import { CURRENCIES, DASHBOARD_CARDS, cardOn, downloadBackup, downloadCSV, fmtMoney, parseBackup, findPotentialDuplicateGroups, findInterestAnomalyGroups, analyzeDuplicateValidity, DEMO_ACCOUNT_IDS } from "../utils.js";
import { AI_PROVIDERS, aiProviderById } from "../ai.js";
import { Btn, Field, Glass, inputCls } from "./UI.jsx";
import TelegramAgent from "./TelegramAgent.jsx";
import Users from "./Users.jsx";
import GooglePhotosSettings from "./GooglePhotosSettings.jsx";

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
  const [changingCode, setChangingCode] = useState(false);
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
          <p className="text-xs text-ink-dim">
            Copia este código en tus otros dispositivos para ver los mismos datos. El botón ☁️ en la barra sincroniza al instante.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded-xl border border-white/12 bg-white/6 px-3 py-2 text-xs">{sync.id}</code>
            <Btn variant="ghost" onClick={copy} className="shrink-0 !py-2 text-xs">{copied ? "✓ Copiado" : "Copiar"}</Btn>
          </div>

          {changingCode ? (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (!sync.link(code)) { alert("Código inválido. Revisa que esté completo."); return; }
                setCode(""); setChangingCode(false);
              }}
            >
              <input
                className={`${inputCls} flex-1`}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="Pega el código del otro dispositivo…"
                autoFocus
              />
              <Btn type="submit" className="shrink-0 !py-2 text-xs">Conectar</Btn>
              <Btn variant="ghost" type="button" className="shrink-0 !py-2 text-xs" onClick={() => { setCode(""); setChangingCode(false); }}>Cancelar</Btn>
            </form>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Btn onClick={() => sync.forcePush && sync.forcePush()} className="text-xs">
                ↕ Sincronizar ahora
              </Btn>
              <Btn variant="ghost" onClick={() => {
                if (confirm("¿Reemplazar datos locales con la nube? Úsalo si otro dispositivo tiene datos más recientes.")) {
                  sync.forcePull && sync.forcePull();
                }
              }} className="text-xs">
                ⬇ Forzar bajada
              </Btn>
              <Btn variant="ghost" onClick={() => {
                if (confirm("¿Re-sincronizar desde el servidor? El server es la fuente de verdad: se reemplazará el estado local divergente (W18).")) {
                  sync.resync && sync.resync();
                }
              }} className="text-xs">
                🔁 Re-sincronizar server
              </Btn>
              <Btn variant="ghost" onClick={() => setChangingCode(true)} className="text-xs">
                🔗 Cambiar código
              </Btn>
              <Btn variant="danger" onClick={() => { if (confirm("¿Desactivar la sincronización en este dispositivo? Los datos en la nube no se borran.")) sync.disable(); }} className="text-xs">
                Desactivar
              </Btn>
            </div>
          )}

          {sync.status === 'error' && (
            <Btn onClick={() => sync.retry && sync.retry()} className="text-xs w-full">
              ⚠ Error de conexión — Reintentar
            </Btn>
          )}
          <p className="text-[10px] text-ink-dim/50 tabular-nums">
            Bundle: {typeof __BUILD_TIME__ !== "undefined" ? new Date(__BUILD_TIME__).toLocaleString("es-MX") : "desconocido"}
          </p>
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

      <GooglePhotosSettings />

      <TelegramAgent />

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
  const sel = state.settings.aiProvider || "gemini";
  const prov = aiProviderById(sel);
  const storedKey = state.settings[prov.keyField] || "";
  const [key, setKey] = useState(storedKey);
  const [saved, setSaved] = useState(false);
  const configured = !!storedKey;

  useEffect(() => setKey(state.settings[aiProviderById(state.settings.aiProvider || "gemini").keyField] || ""), [sel]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = (e) => {
    e.preventDefault();
    dispatch({ type: "update_settings", patch: { aiProvider: sel, [prov.keyField]: key.trim() || null } });
    setSaved(true);
    setTimeout(() => setSaved(false), 2500);
  };

  return (
    <Glass aria-label="Motor de IA">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-base font-semibold">Motor de IA para escaneo</h2>
        <span className={`text-xs ${configured ? "text-gain" : "text-ink-dim"}`} role="status">
          {configured ? "● Activo" : "○ Sin configurar"}
        </span>
      </div>
      <p className="mb-3 text-xs text-ink-dim">
        Con una API key de IA, el escaneo de recibos, capturas bancarias y transferencias usa visión por IA
        (mucho más preciso que el OCR local). Se guarda en tu configuración y las imágenes se envían al proveedor elegido:{" "}
        {prov.blurb}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Proveedor">
          <select className={inputCls} value={sel} onChange={(e) => dispatch({ type: "update_settings", patch: { aiProvider: e.target.value } })}>
            {AI_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        <div className="text-sm">
          <span className="mb-1 block text-ink-dim">API key de {prov.name}</span>
          <form className="flex gap-2" onSubmit={save}>
            <input
              className={`${inputCls} flex-1`}
              type="password"
              autoComplete="off"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={prov.keyHint}
              aria-label={`API key de ${prov.name}`}
            />
            <Btn type="submit" className="shrink-0">{configured ? "Actualizar" : "Guardar"}</Btn>
          </form>
          <span className="mt-1 block text-xs text-ink-dim/80">
            {configured ? `Configurada${key && key !== storedKey ? " (sin guardar)" : ""}.` : "Déjala vacía para usar la clave del servidor, si la hay."}
          </span>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
        <a href={prov.keyUrl} target="_blank" rel="noreferrer" className="text-xs text-accent-soft underline">
          Conseguir API key de {prov.name} ↗
        </a>
        <div className="flex gap-2">
          {configured && (
            <Btn variant="danger" className="text-xs" onClick={() => { setKey(""); dispatch({ type: "update_settings", patch: { [prov.keyField]: null } }); }}>
              Quitar
            </Btn>
          )}
        </div>
      </div>
      {saved && <p role="status" className="mt-2 text-sm text-gain">✓ Guardado. El escaneo ya usa IA ({prov.name}).</p>}
    </Glass>
  );
}

function DataTools() {
  const { state, dispatch, sync } = useStore();
  const [msg, setMsg] = useState(null); // { tone, text }
  const fileRef = useRef(null);
  const [dupGroups, setDupGroups] = useState([]);
  const [interestAnomalyGroups, setInterestAnomalyGroups] = useState([]);
  const [dupAnalysisDone, setDupAnalysisDone] = useState(false);
  const [analyzingDups, setAnalyzingDups] = useState(false);
  const [orphanTxs, setOrphanTxs] = useState([]);

  const flash = (tone, text) => { setMsg({ tone, text }); setTimeout(() => setMsg(null), 4000); };

  const analyzeDuplicates = async () => {
    setAnalyzingDups(true);
    setDupAnalysisDone(false);
    try {
      const txs = Array.isArray(state.transactions) ? state.transactions : [];
      if (txs.length === 0) {
        flash('loss', 'No hay transacciones');
        setAnalyzingDups(false);
        return;
      }
      // Duplicados exactos (misma desc+fecha+monto+cuenta)
      const groups = findPotentialDuplicateGroups(txs);
      const analyzed = [];
      for (const g of groups) {
        const analysis = await analyzeDuplicateValidity(g, state.settings?.geminiKey);
        analyzed.push({ txs: g, ...analysis });
      }
      // Anomalías de interés (múltiples depósitos el mismo día en la misma cuenta)
      const anomalies = findInterestAnomalyGroups(txs, state.accounts || []);
      setDupGroups(analyzed);
      setInterestAnomalyGroups(anomalies);
      setDupAnalysisDone(true);
    } catch (err) {
      console.error('Error analizando duplicados:', err);
      flash('loss', 'Error analizando duplicados: ' + (err?.message || 'desconocido'));
    }
    setAnalyzingDups(false);
  };

  const removeDuplicateGroup = (group) => {
    if (!confirm(`¿Eliminar los duplicados de este grupo (mantener 1 transacción)?`)) return;
    const sorted = [...group.txs].sort((a, b) => a.id.localeCompare(b.id));
    const toDelete = sorted.slice(1).map((t) => t.id);
    toDelete.forEach((id) => dispatch({ type: 'delete_transaction', id }));
    flash('gain', `Eliminados ${toDelete.length} duplicados.`);
    setDupGroups(prev => prev.filter((g) => g !== group));
    if (sync?.forcePush) setTimeout(() => { try { sync.forcePush(); } catch {} }, 80);
  };

  const removeInterestAnomaly = (group) => {
    if (!confirm(`¿Eliminar ${group.txs.length - 1} transacciones de interés sobrantes del ${group.date} en ${group.accName}? Se conservará 1.`)) return;
    // Conservar la de monto mayor (catch-up legítimo) si hay solo 1 positivo > dailyCap/txCount
    // Eliminar todas excepto la primera por fecha y luego monto
    const positives = group.txs.filter((t) => t.amount > 0).sort((a, b) => b.amount - a.amount);
    const negatives = group.txs.filter((t) => t.amount <= 0);
    // Mantener 1 positivo (el de mayor monto, que suele ser el catch-up principal)
    const keepPos = positives[0];
    const toDelete = [...positives.slice(1), ...negatives].map((t) => t.id);
    toDelete.forEach((id) => dispatch({ type: 'delete_transaction', id }));
    flash('gain', `Eliminadas ${toDelete.length} txs de interés sobrantes del ${group.date}.`);
    setInterestAnomalyGroups(prev => prev.filter((g) => g !== group));
    if (sync?.forcePush) setTimeout(() => { try { sync.forcePush(); } catch {} }, 80);
  };

  const findOrphans = () => {
    const txs = Array.isArray(state.transactions) ? state.transactions : [];
    const accIds = new Set((state.accounts || []).map((a) => a.id));
    const orphans = txs.filter((t) => t && t.accountId && !accIds.has(t.accountId));
    setOrphanTxs(orphans);
    flash(orphans.length ? 'gain' : 'loss', orphans.length ? `${orphans.length} transacciones huérfanas detectadas (de cuentas eliminadas).` : 'Sin transacciones huérfanas.');
  };

  const removeOrphans = () => {
    if (!orphanTxs.length) return;
    if (!confirm(`¿Eliminar las ${orphanTxs.length} transacciones huérfanas? Esta acción no se puede deshacer.`)) return;
    orphanTxs.forEach((t) => dispatch({ type: 'delete_transaction', id: t.id }));
    flash('gain', `Eliminadas ${orphanTxs.length} transacciones huérfanas.`);
    setOrphanTxs([]);
    // Force sync push so cloud is updated and future pulls don't restore orphans
    if (sync && typeof sync.forcePush === "function") {
      setTimeout(() => { try { sync.forcePush(); } catch {} }, 80);
    }
  };

  const purgeDemoAccounts = () => {
    const demos = (state.accounts || []).filter((a) => DEMO_ACCOUNT_IDS.includes(a.id));
    if (!demos.length) {
      flash('loss', 'No hay cuentas de demostración presentes.');
      return;
    }
    if (!confirm(`¿Eliminar permanentemente las ${demos.length} cuentas base (Ahorro, Corriente, Depósito, USD)? No se regenerarán.`)) return;
    demos.forEach((a) => dispatch({ type: 'delete_account', accountId: a.id }));
    flash('gain', `Cuentas demo eliminadas (${demos.length}).`);
    if (sync && typeof sync.forcePush === "function" && sync.id) {
      setTimeout(() => { try { sync.forcePush(); } catch {} }, 80);
    }
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
      <p className="mb-2 text-xs text-ink-dim">Detecta (1) transacciones idénticas (misma descripción+fecha+monto+cuenta) y (2) días con demasiados depósitos de interés en la misma cuenta.</p>
      <Btn onClick={analyzeDuplicates} disabled={analyzingDups}>
        {analyzingDups ? 'Analizando...' : 'Analizar duplicados potenciales'}
      </Btn>

      {dupAnalysisDone && (
        <div className="mt-3 space-y-3 text-xs">
          {dupGroups.length === 0 && interestAnomalyGroups.length === 0 && (
            <p className="text-gain">✓ Sin duplicados detectados ({(state.transactions||[]).length} transacciones analizadas).</p>
          )}
          {dupGroups.length > 0 && (
            <div className="space-y-2">
              <p className="font-medium text-loss">Duplicados exactos ({dupGroups.length} grupos):</p>
              {dupGroups.map((g, i) => (
                <div key={i} className="rounded border border-white/10 p-2 bg-white/5">
                  <div className="font-medium">Grupo {i+1}: {g.txs.length} transacciones idénticas</div>
                  <ul className="ml-2 list-disc">
                    {g.txs.slice(0,3).map((t) => <li key={t.id}>{t.date} — {t.description.slice(0,30)} — {fmtMoney(t.amount, t.currency)}</li>)}
                    {g.txs.length > 3 && <li>... y {g.txs.length-3} más</li>}
                  </ul>
                  <div className={`mt-1 ${g.isValid ? 'text-gain' : 'text-loss'}`}>
                    {g.isValid ? '✅ Repetición legítima' : '❌ Duplicado erróneo'} — {g.reason}
                  </div>
                  <Btn variant="danger" className="mt-1 text-xs" onClick={() => removeDuplicateGroup(g)}>
                    Eliminar duplicados (mantener 1)
                  </Btn>
                </div>
              ))}
            </div>
          )}
          {interestAnomalyGroups.length > 0 && (
            <div className="space-y-2">
              <p className="font-medium text-loss">Intereses anómalos ({interestAnomalyGroups.length} días con exceso):</p>
              {interestAnomalyGroups.map((g, i) => (
                <div key={i} className="rounded border border-white/10 p-2 bg-white/5">
                  <div className="font-medium">{g.accName} — {g.date}: {g.txs.length} txs (suma +{fmtMoney(g.sum, 'MXN')}, cap ~{fmtMoney(g.cap, 'MXN')})</div>
                  <ul className="ml-2 list-disc">
                    {g.txs.slice(0,5).map((t) => <li key={t.id}>{fmtMoney(t.amount, t.currency)} — {t.description.slice(0,35)}</li>)}
                    {g.txs.length > 5 && <li>... y {g.txs.length-5} más</li>}
                  </ul>
                  <Btn variant="danger" className="mt-1 text-xs" onClick={() => removeInterestAnomaly(g)}>
                    Limpiar (mantener depósito mayor)
                  </Btn>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <hr className="my-4 border-white/8" />
      <h3 className="mb-1 text-sm font-semibold">Limpiar transacciones huérfanas</h3>
      <p className="mb-2 text-xs text-ink-dim">Transacciones que quedaron después de borrar cuentas. Se pueden eliminar sin afectar saldos (cuentas ya no existen).</p>
      <div className="flex flex-wrap gap-2">
        <Btn onClick={findOrphans}>Detectar huérfanas</Btn>
        {orphanTxs.length > 0 && (
          <Btn variant="danger" onClick={removeOrphans}>Eliminar {orphanTxs.length} huérfanas</Btn>
        )}
      </div>
      {orphanTxs.length > 0 && (
        <div className="mt-2 text-xs text-ink-dim">
          {orphanTxs.slice(0, 3).map((t, i) => <div key={i}>{t.date} · {t.description} · {fmtMoney(Math.abs(t.amount), t.currency)}</div>)}
          {orphanTxs.length > 3 && <div>... +{orphanTxs.length-3} más</div>}
        </div>
      )}

      <hr className="my-4 border-white/8" />
      <h3 className="mb-1 text-sm font-semibold">Limpiar intereses duplicados</h3>
      <p className="mb-2 text-xs text-ink-dim">
        Elimina transacciones de interés duplicadas generadas por sincronización con IDs no deterministas (bug corregido).
        Preview muestra cuántos duplicados hay antes de borrar.
      </p>
      <InterestDedupPanel />

      <hr className="my-4 border-white/8" />
      <h3 className="mb-1 text-sm font-semibold">Eliminar cuentas de demostración base</h3>
      <p className="mb-2 text-xs text-ink-dim">Quita las cuentas semilla (Corriente, Ahorro, Depósito 12m, Cuenta USD) que se regeneraban por el modelo inicial. Una vez eliminadas no volverán gracias a la limpieza en carga y sincronización.</p>
      <Btn variant="danger" onClick={purgeDemoAccounts}>🗑 Eliminar cuentas demo base</Btn>

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

function InterestDedupPanel() {
  const { state, dispatch } = useStore();
  const [preview, setPreview] = useState(null);

  const calcDuplicates = () => {
    const autoInterestCats = new Set(["Intereses", "Impuestos"]);
    const seen = new Map();
    let count = 0;
    for (const tx of (state.transactions || [])) {
      if (!tx.auto || !autoInterestCats.has(tx.category)) continue;
      const key = `${tx.accountId}|${tx.date}|${tx.description}|${tx.amount}`;
      if (seen.has(key)) count++;
      else seen.set(key, tx.id);
    }
    setPreview(count);
  };

  const clean = () => {
    const count = preview ?? 0;
    if (!confirm(`¿Eliminar ${count} transacciones de interés duplicadas? Los saldos se corregirán. Esta acción sincronizará los deletes a la nube.`)) return;
    dispatch({ type: "clean_interest_duplicates" });
    setPreview(null);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Btn onClick={calcDuplicates}>Vista previa</Btn>
      {preview !== null && (
        <>
          <span className="text-xs text-ink-dim">{preview === 0 ? "Sin duplicados detectados." : `${preview} duplicados encontrados.`}</span>
          {preview > 0 && <Btn variant="danger" onClick={clean}>🧹 Eliminar {preview} duplicados</Btn>}
        </>
      )}
    </div>
  );
}
