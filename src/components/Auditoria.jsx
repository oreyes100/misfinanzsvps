import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { useStore } from "../store.jsx";
import { fmtMoney, groupedAccounts } from "../utils.js";
import { aiAudit, aiExtract, ocrImage } from "../ocr.js";
import { aiItemsToChecklist, auditStatement, summarizeChecklist } from "../audit.js";
import { parseStatement, makePatternKey, buildPattern } from "../statement-parser.js";
import AuditChecklist from "./AuditChecklist.jsx";
import { Btn, Glass, inputCls } from "./UI.jsx";

const ACCEPT = "image/jpeg,image/png,image/webp,application/pdf";
const MAX_SIZE = 20 * 1024 * 1024; // 20 MB

// Extrae texto de un PDF usando renderizado a canvas + OCR
async function pdfPageToImage(file, pageNum = 1) {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url
  ).href;
  const arr = file instanceof File ? await file.arrayBuffer() : file;
  const doc = await pdfjs.getDocument({ data: arr }).promise;
  const page = await doc.getPage(pageNum);
  const viewport = page.getViewport({ scale: 2 });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

// Convierte todo un PDF a imágenes (página por página)
async function pdfToImages(file) {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url
  ).href;
  const arr = file instanceof File ? await file.arrayBuffer() : file;
  const doc = await pdfjs.getDocument({ data: arr }).promise;
  const blobs = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    blobs.push(blob);
  }
  return blobs;
}

export default function Auditoria() {
  const { state, dispatch } = useStore();
  const accounts = state.accounts;
  const settings = state.settings;
  const statementPatterns = state.statementPatterns || {};

  const [phase, setPhase] = useState("upload"); // upload | processing | account_select | results | error
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [progress, setProgress] = useState(0);
  const [progressLabel, setProgressLabel] = useState("");
  const [extract, setExtract] = useState(null);
  const [result, setResult] = useState(null);
  const [selectedAccountId, setSelectedAccountId] = useState(null);
  const [error, setError] = useState(null);
  const [itemStates, setItemStates] = useState({});

  const fileRef = useRef(null);
  const inputRef = useRef(null);

  // Limpiar preview URL al desmontar
  useEffect(() => {
    return () => { if (preview) URL.revokeObjectURL(preview); };
  }, [preview]);

  const reset = () => {
    setPhase("upload");
    setFile(null);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    setProgress(0);
    setProgressLabel("");
    setExtract(null);
    setResult(null);
    setSelectedAccountId(null);
    setError(null);
    setItemStates({});
  };

  // Aprende un patrón cuando el usuario aplica una corrección
  const learnPattern = (correctionItem) => {
    const pattern = buildPattern(correctionItem, selectedAccountId);
    if (pattern) {
      dispatch({ type: "learn_statement_pattern", key: pattern.key, pattern: pattern.pattern });
    }
  };

  // Auditoría en dos pasos: heurística local + (si hay API key) verificación
  // comparativa con IA, que es la fuente autoritativa cuando responde.
  const runAudit = useCallback(async (extractData, overrideAccountId) => {
    const opts = overrideAccountId ? { overrideAccountId } : {};
    let auditResult = auditStatement(extractData, accounts, state.transactions, opts);

    const geminiKey = settings.geminiKey;
    if (geminiKey && auditResult.account) {
      try {
        setProgressLabel("Verificando con IA (análisis comparativo)...");
        setProgress(95);
        const accountTx = state.transactions.filter((t) => t.accountId === auditResult.account.id);
        // Acotar al período del extracto (±5 días de margen) para no mandar todo el historial
        const periodTx = auditResult.period
          ? accountTx.filter((t) => {
              const lo = new Date(auditResult.period.from + "T00:00:00") - 5 * 86400000;
              const hi = new Date(auditResult.period.to + "T00:00:00").getTime() + 5 * 86400000;
              const d = new Date((t.date || "1970-01-01") + "T12:00:00").getTime();
              return d >= lo && d <= hi;
            })
          : accountTx;
        const ai = await aiAudit(extractData.movements || [], periodTx, geminiKey, { categories: state.categories });
        const aiChecklist = aiItemsToChecklist(ai.items, state.transactions);
        auditResult = {
          ...auditResult,
          checklist: aiChecklist,
          summary: summarizeChecklist(aiChecklist, (extractData.movements || []).length),
          aiVerified: true,
        };
      } catch (e) {
        console.warn("aiAudit falló, usando auditoría heurística:", e);
        auditResult = { ...auditResult, aiVerified: false, aiError: e.message };
      }
    }
    return auditResult;
  }, [accounts, state.transactions, state.categories, settings.geminiKey]);

  const onFile = useCallback(async (f) => {
    if (!f) return;
    if (f.size > MAX_SIZE) {
      setError("El archivo es demasiado grande (máximo 20MB)");
      return;
    }
    reset();
    setFile(f);
    setPhase("processing");
    setProgressLabel("Leyendo archivo...");
    setProgress(5);

    try {
      setProgressLabel("Analizando con OCR...");
      setProgress(20);

      let imagesToAnalyze = [];

      if (f.type === "application/pdf") {
        setProgressLabel("Renderizando PDF a imágenes...");
        imagesToAnalyze = await pdfToImages(f);
        setProgress(40);
        setPreview(URL.createObjectURL(imagesToAnalyze[0]));
      } else {
        setPreview(URL.createObjectURL(f));
        imagesToAnalyze = [f];
      }

      // Si tenemos API key de Gemini, usar aiExtract (más preciso)
      const geminiKey = settings.geminiKey;
      if (geminiKey) {
        setProgressLabel("Analizando con IA (Gemini)...");
        setProgress(50);

        let allMovements = [];
        let merchant = "";
        for (let i = 0; i < imagesToAnalyze.length; i++) {
          setProgressLabel(`Analizando página ${i + 1}/${imagesToAnalyze.length} con IA...`);
          setProgress(50 + Math.round((i / imagesToAnalyze.length) * 40));

          const pageFile = new File([imagesToAnalyze[i]], `page_${i + 1}.png`, { type: "image/png" });
          const pageExtract = await aiExtract(pageFile, geminiKey, {
            categories: state.categories,
            accounts,
          });

          if (!merchant && pageExtract.merchant) merchant = pageExtract.merchant;
          if (pageExtract.movements?.length) allMovements.push(...pageExtract.movements);
        }

        // Mejorar movimientos con patrones aprendidos
        allMovements = allMovements.map((m) => {
          const key = makePatternKey(m.description);
          const learned = statementPatterns[key];
          if (learned) {
            return {
              ...m,
              description: learned.description || m.description,
              category: learned.category || m.category,
              direction: learned.direction || m.direction,
            };
          }
          return m;
        });

        setProgress(90);
        setProgressLabel("Aplicando auditoría...");

        const combinedExtract = {
          type: "statement",
          merchant: merchant || f.name,
          movements: allMovements,
        };
        setExtract(combinedExtract);

        const auditResult = await runAudit(combinedExtract);
        setResult(auditResult);

        const states = {};
        for (const item of auditResult.checklist) {
          states[item.id] = "pending";
        }
        setItemStates(states);

        if (auditResult.account) {
          setSelectedAccountId(auditResult.account.id);
          setPhase("results");
        } else {
          setPhase("account_select");
          if (accounts.length === 1) {
            setSelectedAccountId(accounts[0].id);
          }
        }
      } else {
        // Sin Gemini: usar Tesseract.js local + statement-parser
        setProgressLabel("Aplicando OCR local...");
        let allText = "";
        for (let i = 0; i < imagesToAnalyze.length; i++) {
          setProgressLabel(`Aplicando OCR página ${i + 1}/${imagesToAnalyze.length}...`);
          setProgress(40 + Math.round((i / imagesToAnalyze.length) * 40));
          const pageFile = new File([imagesToAnalyze[i]], `page_${i + 1}.png`, { type: "image/png" });
          const text = await ocrImage(pageFile, (p) => setProgress(40 + Math.round(p * 40)));
          allText += text + "\n";
        }

        setProgress(85);
        setProgressLabel("Analizando texto OCR...");

        // Parser inteligente con detección de banco y patrones aprendidos
        const parsed = parseStatement(allText, {
          statementPatterns,
          accounts,
        });

        const parsedExtract = {
          type: "statement",
          merchant: parsed.merchant || f.name,
          movements: parsed.movements,
          detectedBank: parsed.detectedBank,
        };
        setExtract(parsedExtract);

        const auditResult = await runAudit(parsedExtract);
        setResult(auditResult);

        const states = {};
        for (const item of auditResult.checklist) states[item.id] = "pending";
        setItemStates(states);

        if (auditResult.account) {
          setSelectedAccountId(auditResult.account.id);
          setPhase("results");
        } else {
          setPhase("account_select");
          if (accounts.length === 1) setSelectedAccountId(accounts[0].id);
        }
      }

      setProgress(100);
      setProgressLabel("Listo");
    } catch (err) {
      console.error("Audit error:", err);
      setError(err.message || "Error al procesar el archivo");
      setPhase("error");
    }
  }, [accounts, state.categories, state.transactions, state.settings, statementPatterns, preview, runAudit]);

  const confirmAccount = async () => {
    if (!selectedAccountId) return;
    setPhase("processing");
    setProgressLabel("Auditando cuenta seleccionada...");
    setProgress(90);
    const auditResult = await runAudit(extract, selectedAccountId);
    setResult(auditResult);
    const states = {};
    for (const item of auditResult.checklist) states[item.id] = "pending";
    setItemStates(states);
    setPhase("results");
  };

  const toggleItem = (id, newState) => {
    setItemStates((prev) => ({ ...prev, [id]: newState }));
    // Cuando el usuario aplica una corrección, aprender el patrón
    if (newState === "applied" && result) {
      const item = result.checklist.find((c) => c.id === id);
      if (item) learnPattern(item);
    }
  };

  // --- Render por fase ---

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold tracking-tight">📋 Auditoría</h2>
        {phase !== "upload" && (
          <button
            type="button"
            onClick={reset}
            className="pressable rounded-lg bg-white/8 px-3 py-1.5 text-xs font-medium text-ink-dim transition hover:bg-white/15"
          >
            Nueva auditoría
          </button>
        )}
      </div>

      {phase === "upload" && <UploadZone onClick={() => inputRef.current?.click()} />}

      {phase === "processing" && (
        <div className="space-y-4">
          <Glass className="!rounded-2xl p-6 text-center">
            <div className="mx-auto mb-3 h-10 w-10 animate-spin rounded-full border-2 border-accent border-t-transparent" />
            <p className="text-sm font-medium text-ink">{progressLabel}</p>
            <div className="mx-auto mt-3 h-2 w-48 overflow-hidden rounded-full bg-white/8">
              <motion.div
                className="h-full rounded-full bg-accent"
                initial={{ width: "0%" }}
                animate={{ width: `${progress}%` }}
                transition={{ duration: 0.3 }}
              />
            </div>
          </Glass>
          {preview && (
            <img src={preview} alt="Vista previa" className="mx-auto max-h-60 rounded-xl object-contain" />
          )}
        </div>
      )}

      {phase === "account_select" && (
        <Glass className="!rounded-2xl p-5 space-y-4">
          <p className="text-sm text-ink-dim">
            No se pudo identificar automáticamente la cuenta. Selecciona manualmente:
          </p>
          <p className="text-xs text-ink-dim">
            Extracto: <strong>{extract?.merchant || file?.name}</strong>
            {" · "}{extract?.movements?.length || 0} movimientos detectados
            {extract?.detectedBank && ` · Banco: ${extract.detectedBank}`}
          </p>
          <select
            className={inputCls}
            value={selectedAccountId || ""}
            onChange={(e) => setSelectedAccountId(e.target.value)}
          >
            <option value="">Seleccionar cuenta...</option>
            {groupedAccounts(accounts).map((g) => (
              <optgroup key={g.type} label={g.label}>
                {g.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} — {fmtMoney(a.balance, a.currency)}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          <Btn onClick={confirmAccount} disabled={!selectedAccountId} className="w-full">
            Confirmar y auditar
          </Btn>
        </Glass>
      )}

      {phase === "results" && result && (
        <div className="space-y-4">
          {/* Account info + bank + learned patterns count */}
          <Glass className="!rounded-2xl p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="text-xs text-ink-dim">Cuenta:</span>
                <span className="ml-2 text-sm font-medium text-ink">
                  {result.account?.name || "—"}
                  {result.account && ` (${fmtMoney(result.account.balance, result.account.currency)})`}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                {result.aiVerified && (
                  <span className="rounded-full bg-green-500/20 px-2.5 py-0.5 text-[11px] text-green-300">
                    🧠 Verificado con IA
                  </span>
                )}
                {result.aiVerified === false && (
                  <span className="rounded-full bg-amber-500/20 px-2.5 py-0.5 text-[11px] text-amber-300" title={result.aiError}>
                    ⚠ IA no disponible — análisis heurístico
                  </span>
                )}
                <span className="rounded-full bg-accent/20 px-2.5 py-0.5 text-[11px] text-accent-soft">
                  Confianza: {Math.round(result.accountConfidence * 100)}%
                </span>
              </div>
            </div>
            {result.accountReason && (
              <p className="mt-1 text-xs text-ink-dim">Motivo: {result.accountReason}</p>
            )}
            {extract?.merchant && (
              <p className="mt-1 text-xs text-ink-dim">Origen: {extract.merchant}</p>
            )}
            {extract?.detectedBank && (
              <p className="text-xs text-ink-dim">Banco detectado: {extract.detectedBank}</p>
            )}
            {result.period && (
              <p className="text-xs text-ink-dim">
                Período: {result.period.from} → {result.period.to}
              </p>
            )}
            {Object.keys(statementPatterns).length > 0 && (
              <p className="mt-1 text-xs text-green-400">
                🧠 {Object.keys(statementPatterns).length} patrón(es) aprendido(s) activo(s)
              </p>
            )}
          </Glass>

          {/* Checklist */}
          <AuditChecklist
            result={result}
            accountId={selectedAccountId}
            itemStates={itemStates}
            onToggleItem={toggleItem}
          />
        </div>
      )}

      {phase === "error" && (
        <Glass className="!rounded-2xl p-5 text-center">
          <p className="text-sm font-medium text-red-300">⚠ Error</p>
          <p className="mt-1 text-sm text-ink-dim">{error}</p>
          <Btn onClick={reset} className="mt-4">
            Reintentar
          </Btn>
        </Glass>
      )}

      {/* Hidden file input */}
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onFile(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}

// ---------- Upload Zone ----------

function UploadZone({ onClick }) {
  const [drag, setDrag] = useState(false);

  return (
    <button
      type="button"
      onClick={onClick}
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => { e.preventDefault(); setDrag(false); }}
      className={`group w-full cursor-pointer rounded-2xl border-2 border-dashed p-12 text-center transition-all ${
        drag
          ? "border-accent bg-accent/10"
          : "border-white/15 bg-white/5 hover:border-accent/50 hover:bg-accent/5"
      }`}
    >
      <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-accent/15 text-2xl">
        📄
      </div>
      <p className="text-sm font-medium text-ink">Sube un estado de cuenta</p>
      <p className="mt-1 text-xs text-ink-dim">PDF o imagen (JPG/PNG) · máx 20MB</p>
      <p className="mt-3 text-[11px] text-ink-dim opacity-60">
        Detecta el banco, identifica la cuenta, y aprende de cada corrección que apliques
      </p>
      <div className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-accent/20 px-4 py-1.5 text-xs font-medium text-accent-soft">
        <span>Seleccionar archivo</span>
      </div>
    </button>
  );
}
