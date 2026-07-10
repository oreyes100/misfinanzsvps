import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { useStore } from "../store.jsx";
import { Glass, Btn, inputCls } from "./UI.jsx";

const SEV_COLORS = {
  high: { bg: "bg-red-500/15", text: "text-red-300", border: "border-red-500/30", dot: "bg-red-400" },
  medium: { bg: "bg-amber-500/15", text: "text-amber-300", border: "border-amber-500/30", dot: "bg-amber-400" },
  low: { bg: "bg-blue-500/15", text: "text-blue-300", border: "border-blue-500/30", dot: "bg-blue-400" },
};
const TYPE_LABELS = {
  missing_transaction: "Movimiento faltante",
  missing_transfer: "Transferencia faltante",
  amount_mismatch: "Importe incorrecto",
  phantom_transaction: "Asiento sin respaldo",
  detail_mismatch: "Detalle inconsistente",
  wrong_sign: "Signo incorrecto",
};

export default function AuditChecklist({ result, accountId, itemStates, onToggleItem }) {
  const { state, dispatch } = useStore();
  // Ediciones por item: { [itemId]: { description, category, notes } }
  const [edits, setEdits] = useState({});

  const summary = result.summary;
  const totalIssues = result.checklist.length;
  const hasIssues = totalIssues > 0;

  const editFor = (item) => ({
    description: item.proposal?.description ?? item.description ?? "",
    category: item.proposal?.category ?? item.category ?? "",
    notes: item.proposal?.notes ?? "",
    ...(edits[item.id] || {}),
  });

  const setEdit = (id, patch) =>
    setEdits((prev) => ({ ...prev, [id]: { ...(prev[id] || {}), ...patch } }));

  const categoryOptions = useMemo(
    () => state.categories.map((c) => c.name),
    [state.categories]
  );

  const accountCurrency = useMemo(
    () => state.accounts.find((a) => a.id === accountId)?.currency ?? null,
    [state.accounts, accountId]
  );

  if (!hasIssues) {
    return (
      <Glass className="!rounded-2xl p-5 text-center">
        <p className="text-lg font-medium text-green-300">✅ Todo en orden</p>
        <p className="mt-1 text-sm text-ink-dim">
          Los {summary.totalMovements} movimientos del extracto coinciden con los registrados
          {result.aiVerified ? " (verificado con IA)" : ""}.
        </p>
        {result.aiVerified === false && (
          <p className="mt-2 text-xs text-amber-300">
            ⚠ La verificación con IA no estuvo disponible; este resultado es del análisis heurístico local.
          </p>
        )}
      </Glass>
    );
  }

  // Un clic: aplica la corrección con los valores editados (o los propuestos).
  const onApplyItem = (item) => {
    const ed = editFor(item);
    const notes = ed.notes?.trim() || undefined;
    const category = ed.category || null;
    const description = ed.description?.trim() || item.description || "Movimiento bancario";

    switch (item.action) {
      case "add_transaction": {
        dispatch({
          type: "add_transaction",
          tx: {
            date: item.proposal?.date || item.date,
            description,
            amount: item.direction === "out" ? -item.amount : item.amount,
            category,
            accountId,
            ...(accountCurrency ? { currency: accountCurrency } : {}),
            notes,
            auto: false,
          },
        });
        break;
      }
      case "add_transfer": {
        dispatch({
          type: "add_transaction",
          tx: {
            date: item.proposal?.date || item.date,
            description: description + (item.direction === "out" ? " (origen)" : " (destino)"),
            amount: item.direction === "out" ? -item.amount : item.amount,
            category: "Transferencia",
            accountId,
            ...(accountCurrency ? { currency: accountCurrency } : {}),
            notes,
            auto: false,
          },
        });
        break;
      }
      case "correct_amount": {
        if (!item.tx) return;
        const fixed = item.direction === "out" ? -item.amount : item.amount;
        dispatch({
          type: "update_transaction",
          id: item.tx.id,
          patch: {
            amount: Math.round(fixed * 100) / 100,
            ...(description !== item.tx.description ? { description } : {}),
            ...(category && category !== item.tx.category ? { category } : {}),
            ...(notes ? { notes } : {}),
          },
        });
        break;
      }
      case "correct_details": {
        if (!item.tx) return;
        dispatch({
          type: "update_transaction",
          id: item.tx.id,
          patch: {
            description,
            ...(category && category !== item.tx.category ? { category } : {}),
            ...(notes ? { notes } : {}),
          },
        });
        break;
      }
      case "correct_sign": {
        if (!item.tx) return;
        const fixed = item.direction === "out" ? -Math.abs(item.tx.amount) : Math.abs(item.tx.amount);
        dispatch({
          type: "update_transaction",
          id: item.tx.id,
          patch: { amount: Math.round(fixed * 100) / 100, ...(notes ? { notes } : {}) },
        });
        break;
      }
      case "remove_transaction": {
        if (!item.tx) return;
        dispatch({ type: "delete_transaction", id: item.tx.id });
        break;
      }
      default:
        return;
    }
    onToggleItem(item.id, "applied");
  };

  const applyAll = () => {
    for (const item of result.checklist) {
      if (itemStates[item.id] !== "pending") continue;
      onApplyItem(item);
    }
  };

  const pendingCount = result.checklist.filter((c) => itemStates[c.id] === "pending").length;

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <SummaryCard label="Coinciden" value={summary.exactMatches} color="text-green-300" />
        {summary.missingTransactions > 0 && (
          <SummaryCard label="Faltantes" value={summary.missingTransactions} color="text-red-300" />
        )}
        {(summary.wrongSigns || 0) > 0 && (
          <SummaryCard label="Signo err." value={summary.wrongSigns} color="text-red-300" />
        )}
        {summary.amountMismatches > 0 && (
          <SummaryCard label="Importes dif." value={summary.amountMismatches} color="text-amber-300" />
        )}
        {(summary.phantomTransactions || 0) > 0 && (
          <SummaryCard label="Sin respaldo" value={summary.phantomTransactions} color="text-amber-300" />
        )}
        {(summary.detailMismatches || 0) > 0 && (
          <SummaryCard label="Detalles" value={summary.detailMismatches} color="text-blue-300" />
        )}
        {summary.missingTransfers > 0 && (
          <SummaryCard label="Transf. falt." value={summary.missingTransfers} color="text-red-300" />
        )}
        <SummaryCard label="Total extracto" value={summary.totalMovements} color="text-ink-dim" />
      </div>

      {/* Apply all button */}
      {pendingCount > 0 && (
        <Btn onClick={applyAll} className="w-full">
          Aplicar todas las correcciones ({pendingCount})
        </Btn>
      )}

      {/* Checklist */}
      <div className="space-y-2">
        {result.checklist.map((item) => {
          const sev = SEV_COLORS[item.severity] || SEV_COLORS.low;
          const state_ = itemStates[item.id] || "pending";
          const ed = editFor(item);
          const editable = state_ === "pending" && item.action !== "remove_transaction" && item.action !== "correct_sign";

          return (
            <motion.div
              key={item.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              className={`${sev.bg} border ${sev.border} rounded-xl p-3.5 transition-all ${state_ === "applied" ? "opacity-50" : ""}`}
            >
              <div className="flex items-start gap-3">
                {/* Status */}
                <div className="mt-0.5">
                  {state_ === "applied" ? (
                    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-green-500/30 text-[10px] text-green-300">✓</span>
                  ) : (
                    <span className={`block h-2.5 w-2.5 rounded-full ${sev.dot} shadow-sm`} />
                  )}
                </div>

                {/* Content */}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className={`text-xs font-semibold uppercase tracking-wider ${sev.text}`}>
                      {TYPE_LABELS[item.type] || item.type}
                    </span>
                    {item.date && <span className="text-[11px] text-ink-dim">{item.date}</span>}
                    {item.source === "ai" && <span className="text-[10px] text-green-400">IA</span>}
                  </div>

                  <p className="mt-0.5 text-sm font-medium text-ink">{item.description || "—"}</p>

                  {item.type === "amount_mismatch" && (
                    <p className="mt-0.5 text-xs text-ink-dim">
                      Registrado: <span className="font-medium text-ink">{item.registeredAmount?.toFixed(2)}</span>
                      {" → "}Extracto: <span className="font-medium text-amber-200">{item.amount.toFixed(2)}</span>
                      {item.difference != null && <span className="text-amber-400"> (dif: {item.difference.toFixed(2)})</span>}
                    </p>
                  )}
                  {item.type === "detail_mismatch" && item.registeredDescription && (
                    <p className="mt-0.5 text-xs text-ink-dim">
                      Registrado como: <span className="font-medium text-ink">"{item.registeredDescription}"</span>
                    </p>
                  )}
                  {(item.type === "missing_transaction" || item.type === "missing_transfer" || item.type === "phantom_transaction" || item.type === "wrong_sign") && (
                    <p className="mt-0.5 text-xs text-ink-dim">
                      Importe: <span className="font-medium text-ink">{item.amount.toFixed(2)}</span>
                      {" · "}{item.direction === "in" ? "Abono" : "Cargo"}
                    </p>
                  )}

                  {item.proposed && <p className="mt-1 text-xs italic text-ink-dim">{item.proposed}</p>}

                  {/* Campos editables antes de aplicar */}
                  {editable && (
                    <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
                      <input
                        className={`${inputCls} !py-1.5 !text-xs`}
                        value={ed.description}
                        onChange={(e) => setEdit(item.id, { description: e.target.value })}
                        placeholder="Descripción"
                        aria-label="Descripción de la corrección"
                      />
                      <select
                        className={`${inputCls} !py-1.5 !text-xs`}
                        value={ed.category || ""}
                        onChange={(e) => setEdit(item.id, { category: e.target.value || null })}
                        aria-label="Categoría de la corrección"
                      >
                        <option value="">Categoría automática</option>
                        {categoryOptions.map((c) => (
                          <option key={c} value={c}>{c}</option>
                        ))}
                      </select>
                      <input
                        className={`${inputCls} !py-1.5 !text-xs sm:col-span-2`}
                        value={ed.notes}
                        onChange={(e) => setEdit(item.id, { notes: e.target.value })}
                        placeholder="Notas (opcional)"
                        aria-label="Notas de la corrección"
                      />
                    </div>
                  )}
                </div>

                {/* Action button */}
                <div className="shrink-0">
                  {state_ === "pending" && (
                    <button
                      type="button"
                      onClick={() => onApplyItem(item)}
                      className="pressable rounded-lg bg-accent/20 px-3 py-1.5 text-xs font-medium text-accent-soft transition hover:bg-accent/30"
                    >
                      {item.action === "remove_transaction" ? "Eliminar" : "Aplicar"}
                    </button>
                  )}
                  {state_ === "applied" && <span className="text-xs text-green-400">✓ Aplicado</span>}
                </div>
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

function SummaryCard({ label, value, color }) {
  return (
    <Glass className="!rounded-xl p-3 text-center">
      <p className="text-xs text-ink-dim">{label}</p>
      <p className={`mt-0.5 text-xl font-bold ${color}`}>{value}</p>
    </Glass>
  );
}
