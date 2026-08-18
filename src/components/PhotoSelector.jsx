import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../store.jsx";
import { getAccessToken } from "../services/googlePhotos.js";
import { analyzeMediaItem, buildQueueItems, scanForReceipts, thumbnailUrl } from "../services/photoScanner.js";
import { ocrImage, parseReceipt, parseTransfer } from "../ocr.js";
import { parseStatement } from "../statement-parser.js";
import { Btn, Modal } from "./UI.jsx";

const KIND_LABEL = { receipt: "Recibo", statement: "Estado de cuenta", transfer: "Transferencia" };

/**
 * OPERACIÓN PHOTO VAULT — Selector de fotos detectadas como documentos.
 * Escanea Google Photos (progresivo, con topes), hace OCR de los candidatos,
 * muestra una vista previa y encola lo seleccionado en la Review Queue MCP.
 */
export default function PhotoSelector({ onClose, onImport }) {
  const { state, dispatch } = useStore();

  const [phase, setPhase] = useState("loading"); // loading | scanning | ready | error
  const [progress, setProgress] = useState({ scanned: 0, candidates: 0 });
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState({});
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const [enqueueing, setEnqueueing] = useState(false);
  const nextPageTokenRef = useRef(null);
  const abortRef = useRef(null);

  const analyze = useMemo(
    () => (item) =>
      analyzeMediaItem(item, {
        ocr: ocrImage,
        categories: state.categories,
        accounts: state.accounts,
        categoryAliases: state.categoryAliases || {},
        statementPatterns: state.statementPatterns || {},
        transferAliases: state.transferAliases || {},
        parseReceipt,
        parseStatement,
        parseTransfer,
      }),
    [state.categories, state.accounts, state.categoryAliases, state.statementPatterns, state.transferAliases]
  );

  const run = useCallback(async () => {
    setError(null);
    setPhase(results.length ? "scanning" : "loading");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const token = await getAccessToken();
      if (!token) throw new Error("No se pudo obtener acceso a Google Photos. Reconecta la cuenta.");
      const scan = await scanForReceipts(token, {
        pageToken: nextPageTokenRef.current,
        analyze,
        onResult: (res) => setResults((prev) => [...prev, res]),
        onProgress: (scanned, candidates) => setProgress({ scanned, candidates }),
        signal: controller.signal,
        maxItems: 60,
        maxCandidates: 12,
        timeBudgetMs: 60_000,
      });
      nextPageTokenRef.current = scan.nextPageToken;
      setDone(scan.done);
      setPhase("ready");
    } catch (e) {
      if (e?.name === "AbortError") return;
      setError(e.message || "Error escaneando Google Photos.");
      setPhase("error");
    }
  }, [analyze]);

  useEffect(() => {
    run();
    return () => abortRef.current?.abort();
  }, [run]);

  const toggle = (key) => setSelected((s) => ({ ...s, [key]: !s[key] }));

  const enqueue = () => {
    const keys = Object.entries(selected).filter(([, on]) => on).map(([k]) => k);
    if (!keys.length) return;
    setEnqueueing(true);
    let count = 0;
    const events = [];
    for (const key of keys) {
      const res = results[Number(key)];
      for (const item of buildQueueItems(res, { accounts: state.accounts })) {
        dispatch({ type: "review_enqueue", item });
        events.push({ ts: Date.now(), source: "ocr", kind: "enqueue", detail: item.preview?.description || "item" });
        count++;
      }
    }
    if (events.length) dispatch({ type: "mcp_batch", events });
    onImport(count);
  };

  const selectedCount = Object.values(selected).filter(Boolean).length;

  return (
    <Modal title="Escanear Google Photos" onClose={onClose} size="lg" labelId="photo-selector-title">
      <div className="space-y-3">
        <p className="text-xs text-ink-dim">
          Se analizan hasta 60 fotos (12 con OCR en esta pasada). Cada documento detectado se encola en el{" "}
          <strong className="text-ink">MCP Command Center</strong> y solo se registra cuando lo apruebas.
        </p>

        {phase === "loading" && <p role="status" className="text-sm text-ink-dim">Conectando con Google Photos…</p>}
        {phase === "scanning" && (
          <p role="status" className="text-sm text-ink-dim">
            Escaneando… {progress.scanned} revisadas · {progress.candidates} candidatas con OCR
          </p>
        )}
        {phase === "error" && (
          <div className="space-y-2">
            <p role="alert" className="text-sm text-loss">⚠ {error}</p>
            <Btn onClick={run}>Reintentar</Btn>
          </div>
        )}

        {results.length > 0 && (
          <ul className="grid max-h-[50vh] gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
            {results.map((res, i) => {
              const kind = res.analysis?.kind || res.detection?.kind;
              const conf = Math.round((res.analysis?.detection?.confidence ?? 0) * 100);
              const a = res.analysis;
              return (
                <li key={i} className="rounded-xl border border-white/10 bg-white/5 p-2.5">
                  <label className="flex cursor-pointer items-start gap-2">
                    <input
                      type="checkbox"
                      className="mt-1 size-4 shrink-0 accent-gain"
                      checked={!!selected[i]}
                      onChange={() => toggle(i)}
                      aria-label={`Incluir ${res.item.filename || "foto"}`}
                    />
                    {res.item.baseUrl ? (
                      <img
                        src={thumbnailUrl(res.item.baseUrl, 300)}
                        alt=""
                        className="h-16 w-16 shrink-0 rounded-lg object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <span className="flex h-16 w-16 shrink-0 items-center justify-center rounded-lg bg-white/8 text-xs text-ink-dim">📄</span>
                    )}
                    <div className="min-w-0 flex-1 space-y-0.5 text-xs">
                      <div className="flex items-center justify-between gap-1">
                        <span className="truncate font-medium">{res.item.filename || "Foto"}</span>
                        <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] ${kind ? "bg-accent/15 text-accent-soft" : "bg-white/8 text-ink-dim"}`}>
                          {KIND_LABEL[kind] || "—"}
                        </span>
                      </div>
                      {a?.kind === "receipt" && (
                        <p className="truncate text-ink-dim">
                          {a.merchant || "Recibo"} · {a.total != null ? `$${a.total.toFixed(2)}` : "sin total"}
                          {a.date ? ` · ${a.date}` : ""}
                        </p>
                      )}
                      {a?.kind === "statement" && (
                        <p className="truncate text-ink-dim">{a.merchant || "Estado de cuenta"} · {a.movements?.length || 0} movimientos</p>
                      )}
                      {a?.kind === "transfer" && (
                        <p className="truncate text-ink-dim">
                          {a.transfer?.from?.name || "?"} → {a.transfer?.to?.name || "?"} · {a.transfer?.amount != null ? `$${a.transfer.amount.toFixed(2)}` : "sin importe"}
                        </p>
                      )}
                      {!a && <p className="truncate text-ink-dim/60">Sin análisis (no parece documento)</p>}
                      <p className="text-[10px] text-ink-dim/60">confianza {conf}%</p>
                    </div>
                  </label>
                </li>
              );
            })}
          </ul>
        )}

        {phase === "ready" && results.length === 0 && (
          <p className="text-sm text-ink-dim">No se encontraron fotos que parezcan documentos en esta pasada.</p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {phase === "ready" && !done && (
            <Btn variant="ghost" onClick={run}>Escanear más</Btn>
          )}
          {results.length > 0 && (
            <Btn onClick={enqueue} disabled={!selectedCount || enqueueing}>
              {enqueueing ? "Encolando…" : `✓ Encolar ${selectedCount} en MCP`}
            </Btn>
          )}
          <Btn variant="ghost" onClick={onClose}>Cerrar</Btn>
        </div>
      </div>
    </Modal>
  );
}