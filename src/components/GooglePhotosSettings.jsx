import { useState } from "react";
import { useStore } from "../store.jsx";
import { isConfigured, revokeTokens, startAuth } from "../services/googlePhotos.js";
import { Btn, Glass } from "./UI.jsx";
import PhotoSelector from "./PhotoSelector.jsx";

const DEFAULT_GP = {
  connected: false,
  email: null,
  connectedAt: null,
  lastScanAt: null,
  lastImportCount: 0,
};

/**
 * OPERACIÓN PHOTO VAULT — Sección de Ajustes de Google Photos.
 * Conecta la cuenta (OAuth PKCE), muestra estado y dispara el escaneo de
 * recibos/EDCs hacia la Review Queue MCP. Los tokens jamás tocan la nube.
 */
export default function GooglePhotosSettings() {
  const { state, dispatch } = useStore();
  const gp = { ...DEFAULT_GP, ...(state.settings.googlePhotos || {}) };
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [selectorOpen, setSelectorOpen] = useState(false);

  const flash = (tone, text) => { setMsg({ tone, text }); setTimeout(() => setMsg(null), 5000); };

  const patch = (partial) => dispatch({ type: "update_settings", patch: { googlePhotos: { ...gp, ...partial } } });

  const connect = async () => {
    setBusy(true);
    try {
      await startAuth(); // navega a Google; el retorno lo procesa App.jsx
    } catch (e) {
      flash("loss", e.message || "No se pudo iniciar la conexión.");
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!confirm("¿Desconectar Google Photos? Se revocarán los tokens en Google y se borrarán de este dispositivo.")) return;
    setBusy(true);
    await revokeTokens().catch(() => {});
    patch({ connected: false, email: null, connectedAt: null });
    setBusy(false);
    flash("gain", "Google Photos desconectado. Tokens revocados y eliminados.");
  };

  return (
    <Glass aria-label="Google Photos">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-base font-semibold">📸 Google Photos (Photo Vault)</h2>
        <span className={`text-xs ${gp.connected ? "text-gain" : "text-ink-dim"}`} role="status">
          {gp.connected ? "● Conectado" : "○ Sin conexión"}
        </span>
      </div>

      {!isConfigured() ? (
        <div className="space-y-2 text-sm">
          <p className="text-ink-dim">
            Esta integración lee tu <strong className="text-ink">Google Photos</strong> para detectar recibos,
            estados de cuenta y comprobantes, y pasarlos por OCR a la Review Queue MCP. Falta configurar las
            credenciales de Google:
          </p>
          <ol className="list-decimal space-y-1 pl-5 text-xs text-ink-dim">
            <li>En <strong className="text-ink">Google Cloud Console</strong> crea un OAuth Client ID de tipo <em>Web application</em>.</li>
            <li>Añade a <em>Authorized redirect URIs</em>: <code className="rounded bg-white/6 px-1">{typeof window !== "undefined" ? `${window.location.origin}/oauth/callback` : "/oauth/callback"}</code></li>
            <li>Activa la <em>Google Photos Library API</em> para tu proyecto.</li>
            <li>Guarda el Client ID en el build con <code className="rounded bg-white/6 px-1">VITE_GOOGLE_PHOTOS_CLIENT_ID</code>.</li>
          </ol>
          <p className="text-[11px] text-ink-dim/70">
            Los tokens se cifran con AES-256-GCM (clave derivada de tu sesión) y solo viven en este dispositivo.
            Nunca se suben a la nube.
          </p>
        </div>
      ) : !gp.connected ? (
        <div className="space-y-3">
          <p className="text-sm text-ink-dim">
            Conecta tu cuenta de Google para escanear automáticamente recibos, estados de cuenta y comprobantes
            de transferencia. Todo lo detectado se encola en el <strong className="text-ink">MCP Command Center</strong> para tu aprobación.
          </p>
          <Btn onClick={connect} disabled={busy}>{busy ? "Conectando…" : "🔗 Conectar Google Photos"}</Btn>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-ink-dim">
            Conectado{gp.email ? ` como <strong className="text-ink">${gp.email}</strong>` : ""}.
            Escanea tus fotos para detectar documentos financieros; cada candidato se analiza con OCR y se encola
            en MCP para revisión antes de registrarlo.
          </p>

          {gp.lastScanAt && (
            <p className="text-xs text-ink-dim">
              Último escaneo: {new Date(gp.lastScanAt).toLocaleString("es-MX")}
              {gp.lastImportCount > 0 ? ` · ${gp.lastImportCount} documento(s) encolado(s)` : ""}.
            </p>
          )}

          <div className="flex flex-wrap gap-2">
            <Btn onClick={() => setSelectorOpen(true)}>🔍 Escanear fotos ahora</Btn>
            <Btn variant="danger" onClick={disconnect} disabled={busy}>Desconectar</Btn>
          </div>
          <p className="text-[11px] text-ink-dim/70">
            Los tokens están cifrados en este dispositivo (AES-256-GCM) y nunca se sincronizan a la nube.
          </p>
        </div>
      )}

      {msg && <p role="status" className={`mt-2 text-sm ${msg.tone === "gain" ? "text-gain" : "text-loss"}`}>{msg.text}</p>}

      {selectorOpen && (
        <PhotoSelector
          onClose={() => setSelectorOpen(false)}
          onImport={(count) => {
            patch({ lastScanAt: new Date().toISOString(), lastImportCount: count });
            setSelectorOpen(false);
            flash("gain", count > 0 ? `✓ ${count} documento(s) encolados en MCP para revisión.` : "No se encoló nada: revisa el resultado del escaneo.");
          }}
        />
      )}
    </Glass>
  );
}