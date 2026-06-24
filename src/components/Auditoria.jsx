import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { useStore } from "../store.jsx";
import { fmtMoney, groupedAccounts } from "../utils.js";
import { aiExtract, ocrImage } from "../ocr.js";
import { auditStatement } from "../audit.js";
import AuditChecklist from "./AuditChecklist.jsx";
import { Btn, Glass, inputCls } from "./UI.jsx";

const ACCEPT = "image/jpeg,image/png,image/webp,application/pdf";
const MAX_SIZE = 20 * 1024 * 1024; // 20 MB

// Extrae texto de un PDF usando renderizado a canvas + OCR
// (el navegador renderiza el PDF, nosotros capturamos imágenes)
async function pdfPageToImage(file, pageNum = 1) {
  // Usamos pdfjs-dist para renderizar el PDF en un canvas
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    "pdfjs-dist/build/pdf.worker.min.mjs",
    import.meta.url
  ).href;
  const arr = file instanceof File ? await file.arrayBuffer() : file;
  const doc = await pdfjs.getDocument(arr).promise;
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
  const doc = await pdfjs.getDocument(arr).promise;
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
        // Usar la primera página como preview
        setPreview(URL.createObjectURL(imagesToAnalyze[0]));
      } else {
        // Es imagen
        setPreview(URL.createObjectURL(f));
        imagesToAnalyze = [f];
      }

      // Si tenemos API key de Gemini, usar aiExtract (más preciso)
      const geminiKey = settings.geminiApiKey;
      if (geminiKey) {
        setProgressLabel("Analizando con IA (Gemini)...");
        setProgress(50);

        // Analizar cada página con Gemini y combinar resultados
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

        setProgress(90);
        setProgressLabel("Aplicando auditoría...");

        const combinedExtract = {
          type: "statement",
          merchant: merchant || file.name,
          movements: allMovements,
        };
        setExtract(combinedExtract);

        // Ejecutar auditoría
        const auditResult = auditStatement(combinedExtract, accounts, state.transactions);
        setResult(auditResult);

        // Inicializar estados de checklist
        const states = {};
        for (const item of auditResult.checklist) {
          states[item.id] = "pending";
        }
        setItemStates(states);

        if (auditResult.account) {
          setSelectedAccountId(auditResult.account.id);
          setPhase("results");
        } else {
          // No se pudo identificar automáticamente
          setPhase("account_select");
          // Si solo hay una cuenta, preseleccionarla
          if (accounts.length === 1) {
            setSelectedAccountId(accounts[0].id);
          }
        }
      } else {
        // Sin Gemini: usar Tesseract.js local (OCR básico)
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

        // Parse simple del texto OCR
        const simpleExtract = parseTextToMovements(allText);
        setExtract(simpleExtract);

        const auditResult = auditStatement(simpleExtract, accounts, state.transactions);
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
  }, [accounts, state.categories, state.transactions, state.settings, preview]);

  const confirmAccount = () => {
    if (!selectedAccountId) return;
    // Re-ejecutar auditoría con la cuenta seleccionada
    const auditResult = auditStatement(extract, accounts, state.transactions, {
      overrideAccountId: selectedAccountId,
    });
    setResult(auditResult);
    const states = {};
    for (const item of auditResult.checklist) states[item.id] = "pending";
    setItemStates(states);
    setPhase("results");
  };

  const toggleItem = (id, newState) => {
    setItemStates((prev) => ({ ...prev, [id]: newState }));
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
          {/* Account info */}
          <Glass className="!rounded-2xl p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <span className="text-xs text-ink-dim">Cuenta:</span>
                <span className="ml-2 text-sm font-medium text-ink">
                  {result.account?.name || "—"}
                  {result.account && ` (${fmtMoney(result.account.balance, result.account.currency)})`}
                </span>
              </div>
              <span className="rounded-full bg-accent/20 px-2.5 py-0.5 text-[11px] text-accent-soft">
                Confianza: {Math.round(result.accountConfidence * 100)}%
              </span>
            </div>
            {result.accountReason && (
              <p className="mt-1 text-xs text-ink-dim">Motivo: {result.accountReason}</p>
            )}
            {extract?.merchant && (
              <p className="mt-1 text-xs text-ink-dim">Origen: {extract.merchant}</p>
            )}
            {result.period && (
              <p className="text-xs text-ink-dim">
                Período: {result.period.from} → {result.period.to}
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
        El sistema detectará la cuenta, comparará movimientos y generará una checklist de correcciones
      </p>
      <div className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-accent/20 px-4 py-1.5 text-xs font-medium text-accent-soft">
        <span>Seleccionar archivo</span>
      </div>
    </button>
  );
}

// ---------- Fallback OCR parser (sin Gemini) ----------

function parseTextToMovements(text) {
  if (!text) return { type: "statement", merchant: "OCR local", movements: [] };

  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const movements = [];

  // Patrones comunes en EDC mexicanos
  const DATE_RE = /(\d{2}[/-]\d{2}[/-]\d{2,4})/;
  const AMOUNT_RE = /([-+]?\s*[\d,]+\.\d{2})\s*$/;

  for (const line of lines) {
    const dateMatch = line.match(DATE_RE);
    const amountMatch = line.match(AMOUNT_RE);

    if (dateMatch && amountMatch) {
      const date = dateMatch[1].replace(/(\d{2})[/-](\d{2})[/-](\d{2,4})/, (_, d, m, y) => {
        const yy = y.length === 2 ? "20" + y : y;
        return `${yy}-${m}-${d}`;
      });
      const amount = parseFloat(amountMatch[1].replace(/[, ]/g, ""));
      const description = line
        .replace(dateMatch[0], "")
        .replace(amountMatch[0], "")
        .replace(/[-+]\s*/, "")
        .trim();
      const isNegative = line.includes("-") && !line.startsWith("+");
      const direction = isNegative ? "out" : "in";

      if (isFinite(amount) && amount > 0) {
        movements.push({ date, description: description.slice(0, 60), amount, direction, isTransfer: false, category: null });
      }
    }
  }

  return { type: "statement", merchant: "OCR local", movements };
}
