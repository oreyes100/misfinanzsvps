import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useStore } from "../store.jsx";
import { Btn, Field, Glass, Money } from "./UI.jsx";
import { useVirtualScroll } from "../hooks/useVirtualScroll.js";
import { pendingCounts, CLASS_NEEDS_FIX, CLASS_NEEDS_REVIEW } from "../review.js";
import { categorize, categorizeSemanticAsync } from "../utils.js";
import McpPipelineHealth from "./McpPipelineHealth.jsx";
import { ReceiptThumbnail, ReceiptViewer } from "./ReceiptPreview.jsx";

// ═══ Constantes ═══
const PAGE_SIZE = 20;
const SEVERITY_ORDER = { [CLASS_NEEDS_FIX]: 0, [CLASS_NEEDS_REVIEW]: 1, auto_ok: 2 };

const SOURCE_META = {
  assistant: { icon: "🤖", label: "Asistente" },
  ocr: { icon: "📷", label: "OCR" },
  ai: { icon: "🤖", label: "IA" },
  manual: { icon: "✍️", label: "Manual" },
  sync: { icon: "🔁", label: "Sync" },
  demo: { icon: "🎬", label: "Demo" },
};

const DAY_MS = 86_400_000;

/**
 * ═══ MCP COMMAND CENTER ═══
 * Menú principal para revisar, corregir y gestionar los items que el MCP
 * (Asistente/OCR/IA) encola antes de aplicarlos al estado financiero.
 *
 * - FASE 1: agrupación por batch + filtros + paginación.
 * - FASE 3: virtual scrolling en listas largas (resueltas/descartadas).
 * - FASE 4: optimistic locking al corregir (conflicto si el item cambió).
 * - FASE 5: sin estado propio — lee y dispatchea sobre el store central.
 * - FASE 6: tabs ARIA, aria-live, focus, labels, prefers-reduced-motion.
 */
export default function McpMenu() {
  const { state, dispatch } = useStore();
  const queue = state.reviewQueue ?? { pending: [], resolved: [], dismissed: [] };
  const { pending, resolved, dismissed } = queue;
  const counts = pendingCounts(queue);
  const reduceMotion = useReducedMotion();

  const [tab, setTab] = useState("pending");
  const [severity, setSeverity] = useState("all");
  const [source, setSource] = useState("all");
  const [date, setDate] = useState("all");
  const [account, setAccount] = useState("all");
  const [sortBy, setSortBy] = useState("severity");
  const [expanded, setExpanded] = useState(new Set());
  const [batchShown, setBatchShown] = useState({});
  const [editing, setEditing] = useState(null);

  const listForTab = tab === "pending" ? pending : tab === "resolved" ? resolved : dismissed;

  // ─── Filtros + ordenación ──────────────────────────────
  const filtered = useMemo(() => {
    let items = listForTab;
    if (severity !== "all") items = items.filter((i) => i.classification === severity);
    if (source !== "all") items = items.filter((i) => i.source === source);
    if (account !== "all") items = items.filter((i) => i.preview?.accountId === account);
    if (date !== "all") {
      const windowMs = { today: DAY_MS, week: 7 * DAY_MS, month: 30 * DAY_MS }[date];
      const now = Date.now();
      items = items.filter((i) => now - i.createdAt < windowMs);
    }
    return [...items].sort((a, b) => {
      switch (sortBy) {
        case "amount":
          return Math.abs(b.preview?.amount || 0) - Math.abs(a.preview?.amount || 0);
        case "date":
          return b.createdAt - a.createdAt;
        case "confidence":
          return (a.confidence ?? 1) - (b.confidence ?? 1);
        case "severity":
        default:
          return (SEVERITY_ORDER[a.classification] ?? 3) - (SEVERITY_ORDER[b.classification] ?? 3);
      }
    });
  }, [listForTab, severity, source, account, date, sortBy]);

  // ─── Agrupación por batch (FASE 1) ─────────────────────
  const batches = useMemo(() => {
    const map = new Map();
    for (const item of filtered) {
      const key = item.batchId || "no_batch";
      if (!map.has(key)) {
        map.set(key, { id: key, source: item.source, items: [], needsFix: 0, needsReview: 0 });
      }
      const b = map.get(key);
      b.items.push(item);
      if (item.classification === CLASS_NEEDS_FIX) b.needsFix += 1;
      if (item.classification === CLASS_NEEDS_REVIEW) b.needsReview += 1;
    }
    return [...map.values()].sort((a, b) => b.items[0].createdAt - a.items[0].createdAt);
  }, [filtered]);

  // ─── Virtual scroll solo para listas largas (FASE 3) ──
  const list = tab === "pending" ? filtered : filtered.slice(0, 2000); // vista plana de resueltas
  const virtual = useVirtualScroll({
    itemCount: list.length,
    itemHeight: 96,
    containerHeight: 520,
  });

  // ─── Acciones ──────────────────────────────────────────
  const accept = useCallback(
    (item) => {
      if (item.action) dispatch(item.action);
      dispatch({ type: "review_accept", itemId: item.id });
    },
    [dispatch]
  );

  const dismiss = useCallback((item) => dispatch({ type: "review_dismiss", itemId: item.id }), [dispatch]);

  const acceptAll = useCallback(() => {
    for (const item of filtered) {
      if (item.classification === CLASS_NEEDS_REVIEW && item.action) dispatch(item.action);
    }
    dispatch({ type: "review_accept_all" });
  }, [filtered, dispatch]);

  const dismissAll = useCallback(() => dispatch({ type: "review_dismiss_all" }), [dispatch]);

  const toggleBatch = useCallback((id) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const showMore = useCallback(
    (id) => setBatchShown((prev) => ({ ...prev, [id]: (prev[id] || PAGE_SIZE) + PAGE_SIZE })),
    []
  );

  const isStillPending = useCallback((id) => pending.some((i) => i.id === id), [pending]);

  const onSaveFix = useCallback(
    (item, patch) => {
      const action = item.action;
      if (action?.type === "add_transaction") {
        // RECEIPT VISION: el patch puede incluir monto, fecha, descripción, categoría, cuenta.
        const base = action.tx;
        const amount = patch.amount !== undefined && patch.amount !== "" ? Number(patch.amount) : base.amount;
        dispatch({
          type: "add_transaction",
          tx: {
            ...base,
            description: patch.description ?? base.description,
            amount,
            date: patch.date ?? base.date,
            category: patch.category ?? base.category,
            accountId: patch.accountId ?? base.accountId,
            ...(patch.receiptId ? { receiptId: patch.receiptId } : {}),
          },
        });
      } else if (action) {
        dispatch(action);
      }
      dispatch({ type: "review_accept", itemId: item.id });
    },
    [dispatch]
  );

  const tabs = [
    { id: "pending", label: `Pendientes (${counts.total})` },
    { id: "resolved", label: `Resueltas (${resolved.length})` },
    { id: "dismissed", label: `Descartadas (${dismissed.length})` },
  ];

  return (
    <Glass className="p-4">
      {/* Header */}
      <header className="mb-4">
        <h2 className="flex items-center gap-2 text-lg font-bold">
          <span aria-hidden="true" className="flex size-8 items-center justify-center rounded-full bg-accent/20 text-accent-soft">🤖</span>
          MCP Command Center
        </h2>
        <p className="mt-1 text-xs text-ink-dim">
          Revisa y corrige transacciones procesadas automáticamente. Nada se aplica sin tu aprobación.
        </p>
      </header>

      {/* Salud del pipeline (GHOST PIPELINE) */}
      <McpPipelineHealth />

      {/* Onboarding: primera visita sin actividad */}
      {counts.total === 0 && !(state.pipelineEvents?.length) && (
        <div className="mb-4 rounded-2xl border border-dashed border-accent/40 bg-accent/10 p-3 text-xs text-ink-dim">
          El pipeline está listo. Pide algo al <strong className="text-ink">asistente</strong> o escanea un comprobante en
          Google Photos para verlo en acción. O prueba con el botón <strong className="text-ink">🎬 Ver demo</strong> de arriba.
        </div>
      )}

      {/* Tabs (FASE 6: ARIA tabs) */}
      <div role="tablist" aria-label="Secciones de revisión" className="mb-3 flex gap-1.5">
        {tabs.map((t) => (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={tab === t.id}
            aria-controls="mcp-tabpanel"
            onClick={() => setTab(t.id)}
            className={`pressable rounded-xl px-3 py-1.5 text-xs font-medium transition-colors ${
              tab === t.id ? "bg-accent/20 text-accent-soft ring-1 ring-accent/40" : "text-ink-dim hover:bg-white/8"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Filtros + ordenación */}
      <div className="mb-4 flex flex-wrap gap-2">
        <select value={severity} onChange={(e) => setSeverity(e.target.value)} aria-label="Filtrar por severidad" className="pressable rounded-lg border border-white/12 bg-white/6 px-2 py-1 text-xs">
          <option value="all">Todas las severidades</option>
          <option value={CLASS_NEEDS_FIX}>⚠️ Corregir</option>
          <option value={CLASS_NEEDS_REVIEW}>👁️ Revisar</option>
        </select>
        <select value={source} onChange={(e) => setSource(e.target.value)} aria-label="Filtrar por fuente" className="pressable rounded-lg border border-white/12 bg-white/6 px-2 py-1 text-xs">
          <option value="all">Todas las fuentes</option>
          <option value="assistant">🤖 Asistente</option>
          <option value="ocr">📷 OCR</option>
          <option value="ai">🤖 IA</option>
          <option value="manual">✍️ Manual</option>
          <option value="sync">🔁 Sync</option>
          <option value="demo">🎬 Demo</option>
        </select>
        <select value={date} onChange={(e) => setDate(e.target.value)} aria-label="Filtrar por fecha" className="pressable rounded-lg border border-white/12 bg-white/6 px-2 py-1 text-xs">
          <option value="all">Cualquier fecha</option>
          <option value="today">Hoy</option>
          <option value="week">Esta semana</option>
          <option value="month">Este mes</option>
        </select>
        <select value={account} onChange={(e) => setAccount(e.target.value)} aria-label="Filtrar por cuenta" className="pressable rounded-lg border border-white/12 bg-white/6 px-2 py-1 text-xs">
          <option value="all">Todas las cuentas</option>
          {state.accounts.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
        <select value={sortBy} onChange={(e) => setSortBy(e.target.value)} aria-label="Ordenar por" className="pressable rounded-lg border border-white/12 bg-white/6 px-2 py-1 text-xs">
          <option value="severity">Por severidad</option>
          <option value="amount">Por monto</option>
          <option value="date">Por fecha</option>
          <option value="confidence">Por confianza</option>
        </select>
      </div>

      {/* Acciones batch */}
      {tab === "pending" && counts.total > 0 && (
        <div className="mb-4 flex flex-wrap gap-2">
          <Btn size="sm" onClick={acceptAll}>✅ Aceptar sugerencias</Btn>
          <Btn size="sm" variant="ghost" onClick={dismissAll}>🗑️ Descartar todas</Btn>
        </div>
      )}

      {/* Lista */}
      <div id="mcp-tabpanel" role="tabpanel" aria-live="polite">
        {tab === "pending" ? (
          filtered.length === 0 ? (
            <EmptyState text="No hay transacciones pendientes de revisión 🎉" />
          ) : (
            <div className="space-y-3">
              {batches.map((batch) => (
                <BatchCard
                  key={batch.id}
                  batch={batch}
                  reduceMotion={reduceMotion}
                  isExpanded={expanded.has(batch.id)}
                  shown={batchShown[batch.id] || PAGE_SIZE}
                  onToggle={() => toggleBatch(batch.id)}
                  onShowMore={() => showMore(batch.id)}
                  onAccept={accept}
                  onDismiss={dismiss}
                  onEdit={setEditing}
                />
              ))}
            </div>
          )
        ) : (
          list.length === 0 ? (
            <EmptyState text={tab === "resolved" ? "Aún no has resuelto nada" : "Aún no hay descartes"} />
          ) : (
            <div
              ref={virtual.containerRef}
              onScroll={virtual.onScroll}
              style={{ height: 520, overflowY: "auto" }}
              className="rounded-xl border border-white/8 bg-white/4"
            >
              <div style={{ height: virtual.totalHeight, position: "relative" }}>
                <div style={{ transform: `translateY(${virtual.offsetY}px)` }}>
                  {list.slice(virtual.startIndex, virtual.endIndex + 1).map((item) => (
                    <ReviewRow key={item.id} item={item} onAccept={accept} onDismiss={dismiss} onEdit={setEditing} />
                  ))}
                </div>
              </div>
            </div>
          )
        )}
      </div>

      {/* Panel de edición con optimistic locking (FASE 4 + RECEIPT VISION) */}
      <AnimatePresence>
        {editing && (
          <EditPanel
            item={editing}
            state={state}
            dispatch={dispatch}
            isStillPending={isStillPending}
            onSave={(patch) => onSaveFix(editing, patch)}
            onClose={() => setEditing(null)}
          />
        )}
      </AnimatePresence>
    </Glass>
  );
}

// ═══ Tarjeta de batch agrupado (FASE 1) ═══
function BatchCard({ batch, reduceMotion, isExpanded, shown, onToggle, onShowMore, onAccept, onDismiss, onEdit }) {
  const meta = SOURCE_META[batch.source] || { icon: "📦", label: "Batch" };
  const visible = batch.items.slice(0, shown);

  return (
    <Glass className="overflow-hidden !rounded-xl">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={isExpanded}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left hover:bg-white/5"
      >
        <div className="flex min-w-0 items-center gap-3">
          <span className="text-xl" aria-hidden="true">{meta.icon}</span>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{meta.label} · {new Date(batch.items[0].createdAt).toLocaleDateString("es-ES", { day: "numeric", month: "short" })}</p>
            <p className="text-xs text-ink-dim">
              {batch.items.length} items
              {batch.needsFix > 0 && <span className="ml-1.5 text-loss">⚠️ {batch.needsFix}</span>}
              {batch.needsReview > 0 && <span className="ml-1.5 text-amber-400">👁️ {batch.needsReview}</span>}
            </p>
          </div>
        </div>
        <span className="text-ink-dim" aria-hidden="true">{isExpanded ? "▲" : "▼"}</span>
      </button>

      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            animate={reduceMotion ? { opacity: 1 } : { height: "auto", opacity: 1 }}
            exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <div className="divide-y divide-white/6 border-t border-white/8">
              {visible.map((item) => (
                <ReviewRow key={item.id} item={item} onAccept={onAccept} onDismiss={onDismiss} onEdit={onEdit} />
              ))}
            </div>
            {batch.items.length > shown && (
              <div className="p-2 text-center">
                <Btn size="sm" variant="ghost" onClick={onShowMore}>
                  Cargar más ({batch.items.length - shown} restantes)
                </Btn>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </Glass>
  );
}

// ═══ Fila de revisión ═══
function ReviewRow({ item, onAccept, onDismiss, onEdit }) {
  const { dispatch } = useStore();
  const preview = item.preview || {};
  const meta = SOURCE_META[item.source] || { icon: "📦", label: "MCP" };
  const isFix = item.classification === CLASS_NEEDS_FIX;

  // Sugerencia de categoría por keywords cuando el item no tiene categoría.
  const lacksCategory = !preview.category || preview.category === "null" || preview.category === "—";
  const suggested = lacksCategory && preview.description
    ? categorize(preview.description)
    : null;
  const hasSuggestion = suggested && suggested.category && suggested.category !== "Otros";

  const applySuggestion = () => {
    if (!hasSuggestion || !item.action) return;
    dispatch({ type: "add_transaction", tx: { ...item.action.tx, category: suggested.category } });
    dispatch({ type: "review_accept", itemId: item.id });
  };

  return (
    <div className={`px-4 py-3 ${isFix ? "border-l-2 border-l-loss bg-loss/6" : "border-l-2 border-l-amber-400/70 bg-amber-400/6"}`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{preview.description || "Sin descripción"}</p>
          <p className="text-sm tabular-nums text-ink">
            <Money value={preview.amount} /> {preview.date ? `· ${preview.date}` : ""}
          </p>
          <p className="mt-1 text-xs text-ink-dim">
            {meta.icon} {meta.label} · Confianza {(item.confidence * 100).toFixed(0)}% ·
            Categoría {preview.category || "—"} · Cuenta {preview.accountName || "—"}
          </p>
        </div>
        <button
          type="button"
          onClick={() => onEdit(item)}
          title={isFix ? "Abrir editor para corregir" : "Abrir editor para revisar"}
          className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors pressable ${
            isFix ? "bg-loss/15 text-loss hover:bg-loss/25" : "bg-amber-400/15 text-amber-400 hover:bg-amber-400/25"
          }`}
        >
          {isFix ? "⚠️ Corregir" : "👁️ Revisar"}
        </button>
      </div>

      {hasSuggestion && (
        <div className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-gain/10 px-3 py-2">
          <p className="text-xs text-gain">
            🤖 Sugerencia: <strong>{suggested.category}</strong> ({(suggested.confidence * 100).toFixed(0)}%)
          </p>
          <button type="button" onClick={applySuggestion} className="pressable rounded-lg bg-gain/20 px-2.5 py-1 text-xs font-medium text-gain hover:bg-gain/30">
            ✅ Aplicar
          </button>
        </div>
      )}

      <div className="mt-2 flex gap-1.5">
        {item.action?.type === "add_transaction" && (
          <button type="button" onClick={() => onEdit(item)} className="pressable rounded-lg bg-white/8 px-2.5 py-1 text-xs text-ink hover:bg-white/15">
            ✏️ Corregir
          </button>
        )}
        <button type="button" onClick={() => onAccept(item)} className="pressable rounded-lg bg-gain/15 px-2.5 py-1 text-xs text-gain hover:bg-gain/25">
          ✅ Aceptar
        </button>
        <button type="button" onClick={() => onDismiss(item)} className="pressable rounded-lg bg-white/6 px-2.5 py-1 text-xs text-ink-dim hover:bg-white/12">
          🗑️ Descartar
        </button>
      </div>
    </div>
  );
}

// ═══ Panel de edición con optimistic locking (FASE 4 + RECEIPT VISION) ═══
// Editor completo: descripción, monto, fecha, categoría, cuenta + recibo visible
// + convertir a transferencia (RV-04).
function EditPanel({ item, state, dispatch, isStillPending, onSave, onClose }) {
  const tx = item.action?.type === "add_transaction" ? item.action.tx : null;
  const [description, setDescription] = useState(tx?.description ?? item.preview?.description ?? "");
  const [amount, setAmount] = useState(tx?.amount !== undefined ? String(Math.abs(tx.amount)) : "");
  const [date, setDate] = useState(tx?.date ?? item.preview?.date ?? "");
  const [category, setCategory] = useState(tx?.category ?? item.preview?.category ?? state.categories[0]?.name ?? "");
  const [accountId, setAccountId] = useState(tx?.accountId ?? item.preview?.accountId ?? state.accounts[0]?.id ?? "");
  const [showReceipt, setShowReceipt] = useState(false);
  const [convertTo, setConvertTo] = useState(""); // "" | accountId destino
  const [conflict, setConflict] = useState(null);
  const [semanticSuggestion, setSemanticSuggestion] = useState(null);

  // Top of Mind A: sugerencia semántica (embeddings en el backend) al abrir la edición.
  // Solo se muestra como badge (no se aplica automáticamente) para que el usuario decida.
  useEffect(() => {
    let alive = true;
    setSemanticSuggestion(null);
    const text = description?.trim();
    if (text && text.length >= 2) {
      categorizeSemanticAsync(text, state.categories).then((r) => {
        if (!alive || !r?.category || r.category === "Otros") return;
        if (!state.categories.some((c) => c.name === r.category)) return;
        if (r.confidence >= 0.9 && r.semantic !== false) setSemanticSuggestion(r);
      });
    }
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [description, state.categories]);

  const handleSave = () => {
    // Optimistic lock: el item debe seguir pendiente al guardar.
    if (!isStillPending(item.id)) {
      setConflict({ type: "removed", message: "Este item ya fue resuelto o descartado mientras lo editabas." });
      return;
    }
    // RECEIPT VISION RV-04: convertir la propuesta en transferencia (par atómico).
    if (convertTo) {
      const amt = Number(amount);
      if (!Number.isFinite(amt) || amt <= 0 || convertTo === accountId) {
        setConflict({ type: "invalid", message: "Introduce un importe válido y un destino distinto de la cuenta de cargo." });
        return;
      }
      dispatch({
        type: "convert_item_to_transfer",
        itemId: item.id,
        toAccountId: convertTo,
        fromAccountId: accountId,
        amount: amt,
        description,
        date,
        receiptId: item.receiptId || tx?.receiptId || null,
      });
      onClose();
      return;
    }
    const amt = Number(amount);
    const patch = { description, category, accountId, date };
    if (Number.isFinite(amt) && amt > 0) patch.amount = tx?.amount < 0 ? -amt : amt;
    if (item.receiptId) patch.receiptId = item.receiptId;
    onSave(patch);
  };

  const hasReceipt = Boolean(item.receiptUrl || item.receiptBlob || item.receiptId);
  const baseAccount = tx?.accountId || item.preview?.accountId || state.accounts[0]?.id;
  const transferTargets = state.accounts.filter((a) => a.id !== accountId && a.id !== baseAccount);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label="Corregir transacción">
      <Glass className="w-full max-w-md !rounded-2xl p-5">
        <h3 className="mb-1 text-base font-semibold">✏️ Corregir transacción</h3>
        <p className="mb-4 text-xs text-ink-dim">{item.preview?.description} · <Money value={item.preview?.amount} /></p>

        {conflict && (
          <div className="mb-4 rounded-xl border border-amber-400/40 bg-amber-400/10 p-3">
            <p className="mb-2 text-sm font-medium text-amber-300">⚠️ {conflict.message}</p>
            <div className="flex gap-2">
              {conflict.type === "removed" && (
                <Btn size="sm" variant="ghost" onClick={onClose}>✕ Cerrar</Btn>
              )}
            </div>
          </div>
        )}

        {!conflict && (
          <>
            {/* Sugerencia semántica (Top of Mind A) — badge visible, el usuario decide */}
            {semanticSuggestion && (
              <div className="mb-3 flex items-center gap-2 rounded-lg border border-gain/30 bg-gain/10 px-3 py-2">
                <span className="text-green-400" aria-hidden="true">✨</span>
                <p className="min-w-0 flex-1 text-xs text-gain">
                  IA sugiere <strong>{semanticSuggestion.category}</strong>{" "}
                  ({(semanticSuggestion.confidence * 100).toFixed(0)}% confianza)
                </p>
                <button
                  type="button"
                  onClick={() => setCategory(semanticSuggestion.category)}
                  className="pressable shrink-0 rounded-lg bg-gain/20 px-2.5 py-1 text-xs font-medium text-gain hover:bg-gain/30"
                >
                  Aplicar
                </button>
              </div>
            )}

            {/* Recibo visible (RV-01) */}
            {hasReceipt && (
              <div className="mb-4 flex items-center gap-3 rounded-xl border border-white/10 bg-white/4 p-3">
                <ReceiptThumbnail
                  receiptUrl={item.receiptUrl}
                  receiptBlob={item.receiptBlob}
                  receiptId={item.receiptId}
                  alt={item.preview?.description || "recibo"}
                  onClick={() => setShowReceipt(true)}
                />
                <div className="flex-1">
                  <p className="text-xs text-ink-dim">Valida el recibo antes de aceptar.</p>
                  <button type="button" onClick={() => setShowReceipt(true)} className="mt-1 text-xs font-medium text-accent-soft hover:underline">
                    🔍 Ver recibo
                  </button>
                </div>
              </div>
            )}

            <div className="space-y-3">
              <Field label="Descripción">
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="pressable w-full rounded-lg border border-white/12 bg-white/6 px-2 py-1.5 text-sm"
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Monto">
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="pressable w-full rounded-lg border border-white/12 bg-white/6 px-2 py-1.5 text-sm"
                  />
                </Field>
                <Field label="Fecha">
                  <input
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    className="pressable w-full rounded-lg border border-white/12 bg-white/6 px-2 py-1.5 text-sm"
                  />
                </Field>
              </div>
              <Field label="Categoría">
                <select value={category} onChange={(e) => setCategory(e.target.value)} autoFocus className="pressable w-full rounded-lg border border-white/12 bg-white/6 px-2 py-1.5 text-sm">
                  {state.categories.map((c) => (
                    <option key={c.id} value={c.name}>{c.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="Cuenta">
                <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className="pressable w-full rounded-lg border border-white/12 bg-white/6 px-2 py-1.5 text-sm">
                  {state.accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </Field>

              {/* RECEIPT VISION RV-04: convertir en transferencia */}
              <div className="rounded-xl border border-white/10 bg-white/4 p-3">
                <label className="mb-1.5 flex items-center justify-between text-xs font-medium text-ink-dim">
                  <span>🔄 ¿Es una transferencia?</span>
                  <input
                    type="checkbox"
                    checked={convertTo !== ""}
                    onChange={(e) => setConvertTo(e.target.checked ? (transferTargets[0]?.id || "") : "")}
                    className="size-4 accent-[var(--color-accent)]"
                    aria-label="Convertir en transferencia"
                  />
                </label>
                {convertTo !== "" && (
                  <select
                    value={convertTo}
                    onChange={(e) => setConvertTo(e.target.value)}
                    className="pressable w-full rounded-lg border border-white/12 bg-white/6 px-2 py-1.5 text-sm"
                    aria-label="Cuenta destino"
                  >
                    <option value="">Seleccionar cuenta destino…</option>
                    {transferTargets.map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                )}
                {convertTo !== "" && (
                  <p className="mt-1.5 text-[11px] text-ink-dim">
                    Se registrará como par de transferencias (cargo en origen, abono en destino) sin duplicados.
                  </p>
                )}
              </div>
            </div>
            <div className="mt-5 flex gap-2">
              <Btn onClick={handleSave}>💾 Guardar y aplicar</Btn>
              <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
            </div>
          </>
        )}
      </Glass>

      {/* Viewer del recibo (RV-01) */}
      <AnimatePresence>
        {showReceipt && (
          <ReceiptViewer
            receiptUrl={item.receiptUrl}
            receiptBlob={item.receiptBlob}
            receiptId={item.receiptId}
            onClose={() => setShowReceipt(false)}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function EmptyState({ text }) {
  return (
    <div className="py-12 text-center text-ink-dim">
      <p className="mb-2 text-3xl" aria-hidden="true">🎉</p>
      <p className="text-sm">{text}</p>
    </div>
  );
}