import { useEffect, useState } from "react";
import { useStore } from "../store.jsx";
import { API_BASE } from "../utils.js";
import { AI_PROVIDERS, aiProviderById, aiErrorLabel } from "../ai.js";
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

const TYPE_LABEL = { receipt: "Recibo", statement: "Estado de cuenta", transfer: "Transferencia" };

function pct(c) {
  return Math.round((c || 0) * 100) + "%";
}

export default function IaImport() {
  const { state, dispatch, sync } = useStore();
  const syncCode = sync?.id || "";

  const [source, setSource] = useState("drive-public");
  const [folderUrl, setFolderUrl] = useState("");
  const [albumId, setAlbumId] = useState("");
  const [provider, setProvider] = useState(state.settings.aiProvider || "gemini");
  const [apiKey, setApiKey] = useState(state.settings[aiProviderById(state.settings.aiProvider || "gemini").keyField] || "");

  const [diag, setDiag] = useState(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState("");
  const [batch, setBatch] = useState(null); // { id, items, done }
  const [error, setError] = useState(null);
  const [msg, setMsg] = useState(null);

  // Revisión: filas planas (una por transacción propuesta) editables.
  const [rows, setRows] = useState([]);
  const [registered, setRegistered] = useState(0);

  const flash = (tone, text) => { setMsg({ tone, text }); setTimeout(() => setMsg(null), 4000); };

  const refreshDiag = async () => {
    if (!syncCode) return;
    const r = await api(`${API_BASE}/api/google-import?syncCode=${encodeURIComponent(syncCode)}&check=1`);
    if (r.status === 200) setDiag(r.data);
  };
  useEffect(() => { refreshDiag(); }, [syncCode]); // eslint-disable-line react-hooks/exhaustive-deps

  const keyFor = (p) => state.settings[aiProviderById(p).keyField] || "";

  const connectGoogle = async () => {
    if (!syncCode) return;
    const r = await api(`${API_BASE}/api/google-auth?syncCode=${encodeURIComponent(syncCode)}&scope=${source === "photos" ? "photos" : "drive"}`);
    const d = r.data;
    if (!d?.ok) { flash("loss", d?.error === "no_sync" ? "Activa primero la sincronización en la nube." : (d?.error || "No se pudo iniciar OAuth")); return; }
    if (d.connected) { flash("gain", "✓ Google ya está vinculado a este código."); refreshDiag(); return; }
    if (!d.oauthAvailable || !d.authUrl) { flash("loss", d?.error === "no_creds" ? "El servidor aún no tiene GOOGLE_CLIENT_ID/SECRET configurados." : "OAuth no disponible en el servidor."); return; }
    const w = window.open(d.authUrl, "google-oauth", "width=520,height=640");
    const timer = setInterval(() => {
      if (w && w.closed) { clearInterval(timer); refreshDiag(); flash("gain", "✓ Google vinculado a este código."); }
    }, 800);
    setTimeout(() => clearInterval(timer), 120000);
  };

  const start = async () => {
    if (!syncCode) { flash("loss", "Activa primero la sincronización en la nube (Ajustes)."); return; }
    if (source === "photos" && !albumId) { flash("loss", "Pega el ID del álbum de Google Photos."); return; }
    if ((source === "drive-public" || source === "drive-api") && !folderUrl) { flash("loss", "Pega el enlace de la carpeta de Drive."); return; }
    setError(null); setBatch(null); setRows([]); setRegistered(0); setRunning(true);
    setProgress("Listando archivos y clasificando con IA…");

    const sleep = (ms) => new Promise((r2) => setTimeout(r2, ms));
    const acc = [];
    let batchId = null;
    let done = false;
    let nextStart = 0;
    let processed = 0;
    let total = 0;
    try {
      do {
        const body = {
          syncCode, source,
          folderUrl: (source === "drive-public" || source === "drive-api") ? folderUrl : undefined,
          albumId: source === "photos" ? albumId : undefined,
          provider, apiKey: apiKey || undefined,
          limit,
          ...(batchId ? { batchId, start: nextStart } : {}),
        };
        const r = await api(`${API_BASE}/api/google-import`, body);
        if (r.status !== 200 || r.data?.ok === false) {
          setError((r.data && (r.data.error || r.data.message)) || "Error del servidor de importación");
          break;
        }
        const d = r.data;
        batchId = d.batchId;
        done = !!d.done;
        processed = d.processed;
        total = d.total;
        nextStart = d.nextStart;
        for (const it of d.items) if (!acc.some((x) => x.key === it.key)) acc.push(it);
        setBatch({ id: batchId, items: [...acc], done });
        setProgress(`Clasificadas ${processed} de ${total}…`);
        if (!done) await sleep(700);
      } while (!done);
      if (done) setProgress("");
    } catch (e) {
      setError(e.message || "Error de red");
    }
    setRunning(false);
  };

  // Cuando el batch termina, construir las filas de revisión.
  useEffect(() => {
    if (!batch || !batch.done || rows.length > 0 || registered > 0) return;
    const accById = new Map(state.accounts.map((a) => [a.id, a]));
    const catNames = state.categories.map((c) => c.name);
    const flat = [];
    for (const it of batch.items) {
      if (it.status !== "done" || it.error) continue;
      const accId = it.accountId && accById.has(it.accountId) ? it.accountId : "";
      const txs = it.transactions || [];
      for (const tx of txs) {
        flat.push({
          key: it.key,
          name: it.name,
          txCount: txs.length,
          include: true,
          accountId: accId,
          accountName: it.accountName || null,
          accountConfident: !!it.accountConfident,
          category: tx.category && catNames.includes(tx.category) ? tx.category : (catNames[0] || ""),
          date: tx.date || it.date || new Date().toISOString().slice(0, 10),
          amount: tx.amount,
          direction: tx.direction === "in" ? "in" : "out",
          description: tx.description || it.merchant || "Movimiento",
          currency: it.currency || accById.get(accId)?.currency || state.settings.baseCurrency || "EUR",
          confidence: it.confidence,
          type: it.type,
          hints: it.accountHints || [],
        });
      }
    }
    setRows(flat);
  }, [batch]); // eslint-disable-line react-hooks/exhaustive-deps

  const patchRow = (i, patch) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const registerSelected = () => {
    const toAdd = rows.filter((r) => r.include && r.accountId && r.amount > 0);
    if (toAdd.length === 0) { flash("loss", "Selecciona al menos una propuesta con cuenta asignada."); return; }
    if (!confirm(`Registrar ${toAdd.length} transacción(es) en tus cuentas? Puedes revisar cada fila antes.`)) return;
    const aliases = {};
    let n = 0;
    for (const r of toAdd) {
      const signed = r.direction === "in" ? r.amount : -r.amount;
      dispatch({
        type: "add_transaction",
        tx: {
          description: r.description,
          amount: Math.round(signed * 100) / 100,
          currency: r.currency,
          accountId: r.accountId,
          category: r.category || undefined,
          date: r.date,
          auto: true,
        },
      });
      if (r.accountConfident && r.hints.length) {
        for (const h of r.hints) aliases[h] = r.accountId;
      }
      n++;
    }
    if (Object.keys(aliases).length) dispatch({ type: "learn_transfer_aliases", aliases });
    setRegistered(n);
    setRows([]);
    flash("gain", `✓ Registradas ${n} transacciones. Sincronizando…`);
    if (sync?.forcePush) setTimeout(() => { try { sync.forcePush(); } catch {} }, 120);
  };

  const accOptions = state.accounts.map((a) => (
    <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>
  ));
  const catOptions = state.categories.map((c) => <option key={c.name} value={c.name}>{c.name}</option>);
  const envNote = diag?.envKeys?.GEMINI_API_KEY || diag?.envKeys?.OPENAI_API_KEY || diag?.envKeys?.ANTHROPIC_API_KEY;

  if (!syncCode) {
    return (
      <Glass aria-label="Importación con IA">
        <h2 className="mb-2 text-base font-semibold">Importación inteligente</h2>
        <p className="text-sm text-ink-dim">Activa la <strong className="text-ink">sincronización en la nube</strong> en Ajustes para usar la importación de Drive/Photos (tu código identifica tus datos).</p>
      </Glass>
    );
  }

  return (
    <div className="space-y-3">
      <Glass aria-label="Importación con IA">
        <h2 className="mb-1 text-base font-semibold">Importar imágenes con IA</h2>
        <p className="mb-3 text-xs text-ink-dim">
          Pasa una carpeta de <strong className="text-ink">Google Drive</strong> o un álbum de <strong className="text-ink">Google Photos</strong> con recibos o capturas
          de banco. La IA los lee, sugiere cuenta/categoría y te deja revisar antes de registrar.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Fuente">
            <select className={inputCls} value={source} onChange={(e) => setSource(e.target.value)}>
              <option value="drive-public">Drive (carpeta pública, sin login)</option>
              <option value="drive-api">Drive (con tu cuenta Google)</option>
              <option value="photos">Google Photos (álbum)</option>
            </select>
          </Field>

          {(source === "drive-public" || source === "drive-api") && (
            <Field label="Enlace de la carpeta de Drive" hint="Compártela como «Cualquiera con el enlace» si eliges la opción sin login.">
              <input className={inputCls} value={folderUrl} onChange={(e) => setFolderUrl(e.target.value)} placeholder="https://drive.google.com/drive/folders/…" />
            </Field>
          )}
          {source === "photos" && (
            <Field label="ID del álbum de Photos" hint="En la web de Photos, el ID aparece en la URL tras /share/ o en la librería.">
              <input className={inputCls} value={albumId} onChange={(e) => setAlbumId(e.target.value)} placeholder="Álbum compartido o ID de librería" />
            </Field>
          )}

          <Field label="Motor de IA">
            <select className={inputCls} value={provider} onChange={(e) => { setProvider(e.target.value); setApiKey(keyFor(e.target.value)); }}>
              {AI_PROVIDERS.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>

          <Field label="API key de IA (opcional)" hint="Si la dejas vacía se usa la del servidor, si está configurada.">
            <input className={inputCls} type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder={aiProviderById(provider).keyHint} />
          </Field>
        </div>

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Btn onClick={start} disabled={running}>{running ? "⏳ Clasificando…" : "🚀 Importar y clasificar"}</Btn>
          {(source === "drive-api" || source === "photos") && (
            <Btn variant="ghost" onClick={connectGoogle}>
              🔗 {diag?.google ? "Google vinculado (reconectar)" : "Conectar Google (OAuth)"}
            </Btn>
          )}
        </div>

        {diag && (
          <p className="mt-2 text-[11px] text-ink-dim/80">
            {diag.google ? `Google vinculado (${(diag.scopes || []).join(", ") || "scope OK"}) · ` : "Google sin vincular · "}
            Clave de IA en servidor: {envNote ? "sí" : "no"}.
          </p>
        )}

        {progress && <p className="mt-2 text-sm text-ink-dim" role="status">{progress}</p>}
        {error && <p className="mt-2 text-sm text-loss" role="alert">⚠ {error}</p>}
        {msg && <p role="status" className={`mt-2 text-sm ${msg.tone === "gain" ? "text-gain" : "text-loss"}`}>{msg.text}</p>}
      </Glass>

      {rows.length > 0 && (
        <Glass aria-label="Revisión de propuestas">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-base font-semibold">Revisar y registrar ({rows.length})</h2>
            <span className="text-xs text-ink-dim">{rows.filter((r) => r.include).length} seleccionadas</span>
          </div>
          <p className="mb-3 text-xs text-ink-dim">
            Confirma o corrige la cuenta, categoría, fecha y el importe de cada movimiento antes de registrarlo. Lo aprendido (banco → cuenta) se reutiliza.
          </p>
          <ul className="space-y-2">
            {rows.map((r, i) => (
              <li key={`${r.key}-${i}`} className="rounded-xl border border-white/10 bg-white/5 p-3">
                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1 size-4 accent-gain"
                    checked={r.include}
                    onChange={(e) => patchRow(i, { include: e.target.checked })}
                    aria-label={`Incluir ${r.description}`}
                  />
                  <div className="flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-medium">{r.description}</span>
                      <span className="text-[10px] text-ink-dim">{TYPE_LABEL[r.type] || "Doc"} · {r.txCount > 1 ? `${r.txCount} movs` : ""}</span>
                      <span className={`rounded-full px-2 py-0.5 text-[10px] ${r.confidence >= 0.6 ? "bg-gain/15 text-gain" : "bg-loss/15 text-loss"}`}>
                        {pct(r.confidence)} confianza
                      </span>
                      {r.accountConfident && <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] text-accent-soft">cuenta sugerida</span>}
                    </div>
                    <div className="grid gap-2 sm:grid-cols-4">
                      <Field label="Cuenta">
                        <select className={inputCls} value={r.accountId} onChange={(e) => patchRow(i, { accountId: e.target.value })}>
                          <option value="">— sin asignar —</option>
                          {accOptions}
                        </select>
                      </Field>
                      <Field label="Categoría">
                        <select className={inputCls} value={r.category} onChange={(e) => patchRow(i, { category: e.target.value })}>
                          {catOptions}
                        </select>
                      </Field>
                      <Field label="Fecha">
                        <input className={inputCls} type="date" value={r.date} onChange={(e) => patchRow(i, { date: e.target.value })} />
                      </Field>
                      <Field label="Importe">
                        <div className="flex gap-1.5">
                          <select className={`${inputCls} w-20`} value={r.direction} onChange={(e) => patchRow(i, { direction: e.target.value })} aria-label="Dirección">
                            <option value="out">−</option>
                            <option value="in">+</option>
                          </select>
                          <input className={inputCls} type="number" min="0" step="0.01" value={r.amount} onChange={(e) => patchRow(i, { amount: parseFloat(e.target.value) || 0 })} />
                          <span className="flex items-center text-xs text-ink-dim">{r.currency}</span>
                        </div>
                      </Field>
                    </div>
                    <div className="text-[10px] text-ink-dim/70">Archivo: {r.name}{r.hints.length ? ` · pistas: ${r.hints.join(", ")}` : ""}</div>
                  </div>
                </label>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Btn onClick={registerSelected}>✓ Registrar {rows.filter((r) => r.include && r.accountId && r.amount > 0).length} seleccionadas</Btn>
            <Btn variant="ghost" onClick={() => { setRows([]); setBatch(null); setProgress(""); }}>Descartar todo</Btn>
          </div>
          {registered > 0 && <p className="mt-2 text-sm text-gain">✓ {registered} registradas y subidas a la nube.</p>}
        </Glass>
      )}
    </div>
  );
}