import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useStore } from "../store.jsx";
import { catColor, fmtDate, fmtMoney, groupedAccounts, todayISO } from "../utils.js";
import { TransactionModal } from "./Modals.jsx";
import { Btn, Glass, Money, inputCls } from "./UI.jsx";

const DATE_PRESETS = [
  { id: "all", label: "Todo" },
  { id: "today", label: "Hoy" },
  { id: "week", label: "Semana" },
  { id: "month", label: "Mes" },
  { id: "custom", label: "Día…" },
];

function periodBounds(filter, customDate) {
  const today = todayISO();
  if (filter === "today") return [today, today];
  if (filter === "week") {
    const d = new Date(`${today}T12:00:00`);
    const mon = new Date(d);
    mon.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    const sun = new Date(mon);
    sun.setDate(mon.getDate() + 6);
    return [mon.toISOString().slice(0, 10), sun.toISOString().slice(0, 10)];
  }
  if (filter === "month") return [today.slice(0, 7) + "-01", today];
  if (filter === "custom" && customDate) return [customDate, customDate];
  return [null, null];
}

export default function Transactions() {
  const { state } = useStore();
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState("Todas");
  const [acctId, setAcctId] = useState("Todas");
  const [editing, setEditing] = useState(null); // "new" | transacción
  const [dateFilter, setDateFilter] = useState("all");
  const [customDate, setCustomDate] = useState("");

  const cats = useMemo(
    () => ["Todas", ...new Set(state.transactions.map((t) => t.category))],
    [state.transactions]
  );

  // Orden canónico: por fecha descendente (lo más reciente arriba). El sort de JS
  // es estable, así que ante misma fecha se preserva el orden de inserción (la
  // última generada queda arriba). Esta lista ordena tanto el saldo corriente
  // como lo que se muestra.
  const sorted = useMemo(
    () => [...state.transactions].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)),
    [state.transactions]
  );

  // Saldo corriente por transacción: para cada cuenta, partir del saldo actual
  // (más reciente) y descontar hacia atrás el importe de cada movimiento más nuevo.
  const runningById = useMemo(() => {
    const map = {};
    for (const acc of state.accounts) {
      let running = acc.balance;
      for (const t of sorted) {
        if (t.accountId !== acc.id) continue;
        map[t.id] = running; // saldo justo después de este movimiento
        running = Math.round((running - t.amount) * 100) / 100;
      }
    }
    return map;
  }, [sorted, state.accounts]);

  const [dateFrom, dateTo] = useMemo(() => periodBounds(dateFilter, customDate), [dateFilter, customDate]);

  const list = useMemo(
    () =>
      sorted.filter(
        (t) =>
          (cat === "Todas" || t.category === cat) &&
          (acctId === "Todas" || t.accountId === acctId) &&
          (!dateFrom || t.date >= dateFrom) &&
          (!dateTo || t.date <= dateTo) &&
          (t.description.toLowerCase().includes(query.toLowerCase()) || (t.notes || "").toLowerCase().includes(query.toLowerCase()))
      ),
    [sorted, query, cat, acctId, dateFrom, dateTo]
  );

  const accName = (id) => {
    const a = state.accounts.find((x) => x.id === id);
    return a ? a.name : (id ? "— (huérfana)" : "—");
  };

  return (
    <Glass aria-label="Historial de movimientos">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-base font-semibold">Movimientos</h2>
        <Btn onClick={() => setEditing("new")} className="!py-1.5 text-xs">+ Nuevo</Btn>
      </div>

      {/* Filtros de período */}
      <div className="mb-2 flex flex-wrap items-center gap-1">
        {DATE_PRESETS.map((p) => (
          <button
            key={p.id}
            onClick={() => setDateFilter(p.id)}
            className={`rounded-full px-3 py-1 text-xs font-medium transition ${dateFilter === p.id ? "bg-accent text-base-950" : "bg-white/8 text-ink-dim hover:bg-white/15"}`}
          >
            {p.label}
          </button>
        ))}
        {dateFilter === "custom" && (
          <input
            type="date"
            className={`${inputCls} !w-36 shrink-0`}
            value={customDate}
            onChange={(e) => setCustomDate(e.target.value)}
            aria-label="Fecha específica"
          />
        )}
      </div>

      <div className="mb-3 flex flex-wrap gap-2">
        <input
          className={`${inputCls} min-w-40 flex-1`}
          placeholder="Buscar descripción…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Buscar movimientos"
        />
        <select className={`${inputCls} !w-36 shrink-0`} value={acctId} onChange={(e) => setAcctId(e.target.value)} aria-label="Filtrar por cuenta">
          <option value="Todas">Todas las cuentas</option>
          {groupedAccounts(state.accounts).map(({ type, label, accounts }) => (
            <optgroup key={type} label={label}>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </optgroup>
          ))}
        </select>
        <select className={`${inputCls} !w-36 shrink-0`} value={cat} onChange={(e) => setCat(e.target.value)} aria-label="Filtrar por categoría">
          {cats.map((c) => <option key={c}>{c}</option>)}
        </select>
      </div>

      <ul className="divide-y divide-white/6">
        <AnimatePresence initial={false}>
          {list.map((t) => (
            <motion.li
              key={t.id}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.18 }}
            >
              <button
                type="button"
                onClick={() => setEditing(t)}
                aria-label={`Editar movimiento: ${t.description}, ${fmtMoney(Math.abs(t.amount), t.currency)}`}
                className="pressable flex w-full items-center gap-3 rounded-xl px-1 py-2.5 text-left transition-colors duration-150 hover:bg-white/5"
              >
                <span
                  className="flex size-9 shrink-0 items-center justify-center rounded-xl text-xs font-bold"
                  style={{ background: `${catColor(t.category, state.categories)}22`, color: catColor(t.category, state.categories) }}
                  aria-hidden="true"
                >
                  {(t.category || "Otro").slice(0, 2).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{t.description}</p>
                  {t.notes && <p className="mt-0.5 line-clamp-2 text-[11px] text-ink-dim/75">📝 {t.notes}</p>}
                  <p className="text-xs text-ink-dim">
                    {fmtDate(t.date)} · {t.category}{t.subcategory ? ` › ${t.subcategory}` : ""} · {accName(t.accountId)}
                    {t.category === "Transferencia" && t.counterpartId && (
                      <span> → {accName(t.counterpartId)}</span>
                    )}
                    {t.auto && t.category === "Intereses" && <span className="ml-1 text-gain">⚡ automático</span>}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <Money value={t.amount} formatted={fmtMoney(Math.abs(t.amount), t.currency)} className="block text-sm font-semibold" />
                  {runningById[t.id] != null && (
                    <span className="block text-xs text-ink-dim tabular-nums">
                      Saldo: {fmtMoney(runningById[t.id], t.currency)}
                    </span>
                  )}
                </div>
                <span aria-hidden="true" className="text-ink-dim/50">✏️</span>
              </button>
            </motion.li>
          ))}
        </AnimatePresence>
        {!list.length && <li className="py-6 text-center text-sm text-ink-dim">Sin resultados.</li>}
      </ul>

      <AnimatePresence>
        {editing && (
          <TransactionModal tx={editing === "new" ? null : editing} onClose={() => setEditing(null)} />
        )}
      </AnimatePresence>
    </Glass>
  );
}
