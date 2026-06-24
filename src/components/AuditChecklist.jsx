import { useMemo } from "react";
import { motion } from "framer-motion";
import { useStore } from "../store.jsx";
import { fmtMoney } from "../utils.js";
import { buildCorrectionActions } from "../audit.js";
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
};

export default function AuditChecklist({ result, accountId, onApplyAll, itemStates, onToggleItem }) {
  const { state, dispatch } = useStore();
  const accounts = state.accounts;

  const actions = useMemo(
    () => buildCorrectionActions(result.checklist, accountId, accounts),
    [result.checklist, accountId, accounts]
  );

  const summary = result.summary;
  const hasIssues = summary.amountMismatches + summary.missingTransactions + summary.missingTransfers > 0;

  if (!hasIssues) {
    return (
      <Glass className="!rounded-2xl p-5 text-center">
        <p className="text-lg font-medium text-green-300">✅ Todo en orden</p>
        <p className="mt-1 text-sm text-ink-dim">
          Los {summary.totalMovements} movimientos del extracto coinciden con los registrados.
        </p>
      </Glass>
    );
  }

  const applyAll = () => {
    for (const item of result.checklist) {
      if (itemStates[item.id] !== "pending") continue;
      onApplyItem(item);
    }
  };

  const onApplyItem = (item) => {
    const action = actions.find((a) => a.id === item.id);
    if (!action) return;
    if (action.needsCounterpart) {
      // Para transferencias, necesitamos que el usuario seleccione la contraparte
      // Por ahora, registramos solo el movimiento de la cuenta identificada
      // El usuario completa el resto manualmente
      if (item.direction === "out") {
        dispatch({
          type: "add_transaction",
          tx: {
            date: item.date,
            description: (item.description || "Transferencia") + " (origen)",
            amount: -item.amount,
            category: "Transferencia",
            accountId,
            auto: false,
          },
        });
      } else {
        dispatch({
          type: "add_transaction",
          tx: {
            date: item.date,
            description: (item.description || "Transferencia") + " (destino)",
            amount: item.amount,
            category: "Transferencia",
            accountId,
            auto: false,
          },
        });
      }
    } else {
      dispatch(action.payload);
    }
    onToggleItem(item.id, "applied");
  };

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <SummaryCard label="Coinciden" value={summary.exactMatches} color="text-green-300" />
        {summary.amountMismatches > 0 && (
          <SummaryCard label="Importes dif." value={summary.amountMismatches} color="text-amber-300" />
        )}
        {summary.missingTransactions > 0 && (
          <SummaryCard label="Movs. faltantes" value={summary.missingTransactions} color="text-red-300" />
        )}
        {summary.missingTransfers > 0 && (
          <SummaryCard label="Transf. faltantes" value={summary.missingTransfers} color="text-red-300" />
        )}
        <SummaryCard label="Total extracto" value={summary.totalMovements} color="text-ink-dim" />
      </div>

      {/* Apply all button */}
      {result.checklist.some((c) => itemStates[c.id] === "pending") && (
        <Btn onClick={applyAll} className="w-full">
          Aplicar todas las correcciones ({result.checklist.filter((c) => itemStates[c.id] === "pending").length})
        </Btn>
      )}

      {/* Checklist */}
      <div className="space-y-2">
        {result.checklist.map((item) => {
          const sev = SEV_COLORS[item.severity] || SEV_COLORS.low;
          const state_ = itemStates[item.id] || "pending";
          const action = actions.find((a) => a.id === item.id);

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
                    {item.date && (
                      <span className="text-[11px] text-ink-dim">{item.date}</span>
                    )}
                  </div>

                  <p className="mt-0.5 text-sm font-medium text-ink">{item.description || "—"}</p>

                  {item.type === "amount_mismatch" && (
                    <p className="mt-0.5 text-xs text-ink-dim">
                      Registrado: <span className="font-medium text-ink">{item.registeredAmount?.toFixed(2)}</span>
                      {" → "}Extracto: <span className="font-medium text-amber-200">{item.amount.toFixed(2)}</span>
                      {" "}<span className="text-amber-400">(dif: {item.difference?.toFixed(2)})</span>
                    </p>
                  )}

                  {item.type === "missing_transaction" && (
                    <p className="mt-0.5 text-xs text-ink-dim">
                      Importe: <span className="font-medium text-ink">{item.amount.toFixed(2)}</span>
                      {" · "}{item.direction === "in" ? "Abono" : "Cargo"}
                    </p>
                  )}

                  {item.type === "missing_transfer" && (
                    <p className="mt-0.5 text-xs text-ink-dim">
                      Importe: <span className="font-medium text-ink">{item.amount.toFixed(2)}</span>
                      {" · "}{item.direction === "in" ? "Entrante" : "Saliente"}
                    </p>
                  )}

                  <p className="mt-1 text-xs italic text-ink-dim">{item.proposed}</p>
                </div>

                {/* Action button */}
                <div className="shrink-0">
                  {state_ === "pending" && action && (
                    <button
                      type="button"
                      onClick={() => onApplyItem(item)}
                      className="pressable rounded-lg bg-accent/20 px-3 py-1.5 text-xs font-medium text-accent-soft transition hover:bg-accent/30"
                    >
                      Aplicar
                    </button>
                  )}
                  {state_ === "applied" && (
                    <span className="text-xs text-green-400">✓ Aplicado</span>
                  )}
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
