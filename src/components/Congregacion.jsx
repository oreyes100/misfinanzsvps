import { useEffect, useState } from "react";
import { Btn, Glass } from "./UI.jsx";

// Producción: app desplegada en Vercel (sin servidor local, BD en Vercel Blob).
// Si corres el server local (puerto 3002), se usa esa instancia automáticamente.
const PROD_URL = "https://cuentas-congregacion-bay.vercel.app";
const LOCAL_URL = "http://localhost:3002";

/** Sección restringida: subproyecto Cuentas (contabilidad de congregación). */
export default function Congregacion() {
  const [url, setUrl] = useState(PROD_URL);
  const [status, setStatus] = useState("checking"); // checking | online | offline

  useEffect(() => {
    let alive = true;
    // Preferir instancia local si está corriendo; si no, usar producción.
    fetch(`${LOCAL_URL}/api/health`, { mode: "no-cors" })
      .then(() => { if (alive) { setUrl(LOCAL_URL); setStatus("online"); } })
      .catch(() => {
        if (!alive) return;
        fetch(`${PROD_URL}/api/health`)
          .then((r) => { if (alive) { setUrl(PROD_URL); setStatus(r.ok ? "online" : "offline"); } })
          .catch(() => alive && setStatus("offline"));
      });
    return () => { alive = false; };
  }, []);

  const isLocal = url === LOCAL_URL;

  return (
    <div className="space-y-4">
      <Glass aria-label="Cuentas de la congregación">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">Cuentas · Congregación</h2>
            <p className="text-xs text-ink-dim">Contabilidad con registro de donaciones, gastos y conciliación de hojas S-26/S-30. OCR de recibos incluido. BD en la nube (Vercel Blob).</p>
          </div>
          <span className={`rounded-full px-3 py-1 text-xs font-medium ${status === "online" ? "bg-gain/15 text-gain" : status === "offline" ? "bg-loss/15 text-loss" : "bg-white/8 text-ink-dim"}`}>
            {status === "online" ? (isLocal ? "● Local" : "● En la nube") : status === "offline" ? "○ No disponible" : "… verificando"}
          </span>
        </div>

        {status === "offline" && (
          <div className="mb-3 rounded-xl bg-loss/10 px-3 py-2 text-sm">
            No se pudo conectar con la app de Cuentas en la nube. Reintenta en unos segundos.
          </div>
        )}

        <div className="flex gap-2">
          <Btn onClick={() => window.open(url, "_blank")} disabled={status !== "online"} className="!py-2 text-sm">
            Abrir Cuentas ↗
          </Btn>
        </div>
      </Glass>

      {status === "online" && (
        <Glass className="!p-0 overflow-hidden" aria-label="Vista embebida de Cuentas">
          <iframe
            src={url}
            title="Cuentas de la congregación"
            className="h-[70vh] w-full border-0"
          />
        </Glass>
      )}
    </div>
  );
}
