import { useEffect, useState } from "react";

// W26: panel de configuración de motores IA (OCR/LLM/embeddings).
// Muestra primary + fallback + timeout por tarea y permite probar cada
// provider (ping ligero, sin inferencia pesada).

const TASK_LABEL = {
  ocr: "OCR (texto de imágenes)",
  llm: "LLM (extracción y auditoría)",
  embeddings: "Embeddings (categorización semántica)",
};

const PROVIDER_LABEL = {
  paddle: "PaddleOCR (local)",
  ollama: "Ollama (local)",
};

function providerLabel(id) {
  return PROVIDER_LABEL[id] || id;
}

export default function AIConfigPanel() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);
  const [testing, setTesting] = useState({});
  const [results, setResults] = useState({});

  useEffect(() => {
    let alive = true;
    fetch("/api/ai-config", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d) => { if (alive) setStatus(d.status); })
      .catch((e) => { if (alive) setError(String(e.message || e)); });
    return () => { alive = false; };
  }, []);

  const testProvider = async (task, provider) => {
    const key = `${task}:${provider}`;
    setTesting((t) => ({ ...t, [key]: true }));
    setResults((r) => ({ ...r, [key]: null }));
    try {
      const res = await fetch("/api/ai-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task, provider }),
      });
      const data = await res.json();
      setResults((r) => ({ ...r, [key]: data.ok ? `✅ ${data.latencyMs}ms` : `❌ ${data.error || "fallo"}` }));
    } catch (e) {
      setResults((r) => ({ ...r, [key]: `❌ ${String(e.message || e)}` }));
    } finally {
      setTesting((t) => ({ ...t, [key]: false }));
    }
  };

  if (error) {
    return (
      <Glass className="p-4">
        <h3 className="mb-1 font-semibold">Motores de IA</h3>
        <p className="text-sm text-loss">No se pudo cargar la configuración: {error}</p>
      </Glass>
    );
  }
  if (!status) {
    return (
      <Glass className="p-4">
        <h3 className="mb-1 font-semibold">Motores de IA</h3>
        <p className="text-sm text-ink-dim">Cargando…</p>
      </Glass>
    );
  }

  return (
    <Glass className="p-4">
      <h3 className="mb-3 font-semibold">Motores de IA</h3>
      <div className="space-y-4">
        {Object.entries(status).map(([task, cfg]) => (
          <div key={task} className="rounded-xl bg-white/5 p-3">
            <div className="mb-1.5 flex items-baseline justify-between gap-2">
              <span className="text-sm font-medium">{TASK_LABEL[task] || task}</span>
              <span className="text-[10px] text-ink-dim">timeout {Math.round(cfg.timeoutMs / 1000)}s</span>
            </div>
            <div className="space-y-1.5">
              {[cfg.primary, ...(cfg.fallback || [])].map((p, i) => {
                const key = `${task}:${p}`;
                const circuit = cfg.providers?.find((x) => x.id === p)?.circuit;
                return (
                  <div key={key} className="flex items-center justify-between gap-2 text-xs">
                    <span>
                      <span className="text-ink-dim">{i === 0 ? "primario" : "fallback"}:</span>{" "}
                      {providerLabel(p)}
                      {circuit && circuit.state !== "CLOSED" && (
                        <span className="ml-1.5 text-loss" title={`${circuit.failures} fallos`}>
                          (circuit {circuit.state})
                        </span>
                      )}
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="text-[10px]">{results[key] || ""}</span>
                      <button
                        type="button"
                        onClick={() => testProvider(task, p)}
                        disabled={testing[key]}
                        className="rounded-lg bg-white/10 px-2 py-0.5 text-[10px] transition hover:bg-white/20 active:bg-white/30 disabled:opacity-50"
                      >
                        {testing[key] ? "probando…" : "probar"}
                      </button>
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </Glass>
  );
}
