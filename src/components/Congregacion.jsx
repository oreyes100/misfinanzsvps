import { useEffect, useState } from "react";
import { Btn, Glass } from "./UI.jsx";

const CUENTAS_URL = "http://localhost:3002";

/** Sección restringida: subproyecto Cuentas (contabilidad de congregación, app local Express + SQLite). */
export default function Congregacion() {
  const [status, setStatus] = useState("checking"); // checking | online | offline

  useEffect(() => {
    let alive = true;
    fetch(`${CUENTAS_URL}/`, { mode: "no-cors" })
      .then(() => alive && setStatus("online"))
      .catch(() => alive && setStatus("offline"));
    return () => { alive = false; };
  }, []);

  return (
    <div className="space-y-4">
      <Glass aria-label="Cuentas de la congregación">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold">Cuentas · Congregación</h2>
            <p className="text-xs text-ink-dim">Contabilidad con registro de donaciones, gastos y conciliación de hojas S-26/S-30. OCR de recibos incluido.</p>
          </div>
          <span className={`rounded-full px-3 py-1 text-xs font-medium ${status === "online" ? "bg-gain/15 text-gain" : status === "offline" ? "bg-loss/15 text-loss" : "bg-white/8 text-ink-dim"}`}>
            {status === "online" ? "● Servidor activo" : status === "offline" ? "○ Servidor apagado" : "… verificando"}
          </span>
        </div>

        {status === "offline" && (
          <div className="mb-3 rounded-xl bg-gold/10 px-3 py-2 text-sm">
            El servidor local no está corriendo. Inícialo con el lanzador <code className="rounded bg-white/10 px-1">start.command</code> de la carpeta <code className="rounded bg-white/10 px-1">Cuentas/</code> o ejecuta <code className="rounded bg-white/10 px-1">node server.js</code> en esa carpeta.
          </div>
        )}

        <div className="flex gap-2">
          <Btn onClick={() => window.open(CUENTAS_URL, "_blank")} disabled={status !== "online"} className="!py-2 text-sm">
            Abrir Cuentas ↗
          </Btn>
        </div>
      </Glass>

      {status === "online" && (
        <Glass className="!p-0 overflow-hidden" aria-label="Vista embebida de Cuentas">
          <iframe
            src={CUENTAS_URL}
            title="Cuentas de la congregación"
            className="h-[70vh] w-full border-0"
          />
        </Glass>
      )}
    </div>
  );
}
