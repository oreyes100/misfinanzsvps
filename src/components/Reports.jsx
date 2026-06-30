import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { useStore } from "../store.jsx";
import { catColor, convert, fmtMoney, fmtPct, downloadReportCSV, downloadReportPDF } from "../utils.js";
import { Glass, Btn, inputCls } from "./UI.jsx";

const PERIODS = [
  { id: 3, label: "3 meses" },
  { id: 6, label: "6 meses" },
  { id: 12, label: "1 año" },
];

const GRANULARITIES = [
  { id: 'dia', label: 'Día' },
  { id: 'semana', label: 'Semana' },
  { id: 'mes', label: 'Mes' },
  { id: 'trimestre', label: 'Trimestre' },
  { id: 'semestre', label: 'Semestre' },
  { id: 'ano', label: 'Año' },
];

function getGroupKey(dateStr, gran) {
  const d = new Date(dateStr);
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const day = d.getDate();
  if (gran === 'dia') return dateStr.slice(0, 10);
  if (gran === 'semana') {
    const firstDay = new Date(y, 0, 1).getDay();
    const week = Math.ceil(((d.getTime() - new Date(y, 0, 1).getTime()) / 86400000 + firstDay) / 7);
    return `${y}-W${String(week).padStart(2, '0')}`;
  }
  if (gran === 'mes') return `${y}-${String(m).padStart(2, '0')}`;
  if (gran === 'trimestre') {
    const q = Math.ceil(m / 3);
    return `${y}-Q${q}`;
  }
  if (gran === 'semestre') {
    const s = Math.ceil(m / 6);
    return `${y}-S${s}`;
  }
  return String(y);
}

function monthKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Reportes históricos estilo corporativo, adaptado a finanzas personales. */
export default function Reports() {
  const { state } = useStore();
  const [period, setPeriod] = useState(6);
  const [gran, setGran] = useState('mes');
  const base = state.settings.baseCurrency;
  const toBase = (amount, currency) => convert(amount, currency, base, state.fx);

  const data = useMemo(() => {
    // Esqueleto de meses del periodo (más antiguo → más reciente)
    const months = [];
    const now = new Date();
    for (let i = period - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({ key: monthKey(d), label: d.toLocaleDateString("es-ES", { month: "short", year: "2-digit" }), income: 0, expense: 0, byCat: {} });
    }
    const idx = Object.fromEntries(months.map((m, i) => [m.key, i]));

    for (const t of state.transactions) {
      const k = t.date?.slice(0, 7);
      if (!(k in idx)) continue;
      if (t.category === "Transferencia") continue; // movimientos internos no son ingreso/gasto
      const eur = toBase(Math.abs(t.amount), t.currency);
      const m = months[idx[k]];
      if (t.amount > 0) m.income += eur;
      else {
        m.expense += eur;
        m.byCat[t.category] = (m.byCat[t.category] || 0) + eur;
      }
    }

    const totalIncome = months.reduce((s, m) => s + m.income, 0);
    const totalExpense = months.reduce((s, m) => s + m.expense, 0);
    const net = totalIncome - totalExpense;
    const savingsRate = totalIncome > 0 ? net / totalIncome : 0;
    const avgExpense = totalExpense / period;
    const avgIncome = totalIncome / period;

    // Gasto por categoría agregado + tendencia (última mitad vs primera mitad)
    const catTotals = {};
    const half = Math.floor(period / 2);
    const catFirstHalf = {};
    const catSecondHalf = {};
    months.forEach((m, i) => {
      for (const [c, v] of Object.entries(m.byCat)) {
        catTotals[c] = (catTotals[c] || 0) + v;
        if (i < half) catFirstHalf[c] = (catFirstHalf[c] || 0) + v;
        else catSecondHalf[c] = (catSecondHalf[c] || 0) + v;
      }
    });
    const categories = Object.entries(catTotals)
      .sort((a, b) => b[1] - a[1])
      .map(([name, total]) => {
        const f = catFirstHalf[name] || 0;
        const s = catSecondHalf[name] || 0;
        const trend = f > 0 ? (s - f) / f : s > 0 ? 1 : 0;
        return { name, total, pct: totalExpense > 0 ? total / totalExpense : 0, trend };
      });

    // Fondo de emergencia: efectivo y ahorro / gasto medio mensual
    const cash = state.accounts
      .filter((a) => !["credit", "auto_loan"].includes(a.type))
      .reduce((s, a) => s + toBase(a.balance, a.currency), 0);
    const emergencyMonths = avgExpense > 0 ? cash / avgExpense : Infinity;

    // Recomendaciones (reglas de finanzas personales)
    const recs = [];
    if (savingsRate < 0) recs.push({ icon: "🚨", level: "alta", text: `Gastas más de lo que ingresas en este periodo (flujo neto ${fmtMoney(net, base)}). Revisa las 2 categorías principales y fija un tope.` });
    else if (savingsRate < 0.2) recs.push({ icon: "⚠️", level: "media", text: `Tu tasa de ahorro es ${fmtPct(savingsRate)} — el estándar recomendado es ≥20 % (regla 50/30/20). Apunta a ahorrar ${fmtMoney(avgIncome * 0.2, base)}/mes.` });
    else recs.push({ icon: "✅", level: "ok", text: `Tasa de ahorro saludable: ${fmtPct(savingsRate)}. Considera automatizar el excedente hacia inversión.` });

    if (emergencyMonths < 3) recs.push({ icon: "🛟", level: "alta", text: `Tu fondo de emergencia cubre ${emergencyMonths.toFixed(1)} meses de gasto. El mínimo recomendado es 3-6 meses (${fmtMoney(avgExpense * 3, base)}–${fmtMoney(avgExpense * 6, base)}).` });
    else if (emergencyMonths > 12) recs.push({ icon: "📈", level: "media", text: `Tienes ${emergencyMonths.toFixed(0)} meses de gasto en efectivo. El exceso sobre 6 meses (${fmtMoney(cash - avgExpense * 6, base)}) podría rendir más en inversión.` });

    const topCat = categories[0];
    if (topCat && topCat.pct > 0.35) recs.push({ icon: "🎯", level: "media", text: `"${topCat.name}" concentra ${fmtPct(topCat.pct)} de tu gasto. Diversificar o renegociar este rubro tiene el mayor impacto potencial.` });
    const rising = categories.filter((c) => c.trend > 0.25 && c.total > avgExpense * 0.1);
    for (const c of rising.slice(0, 2)) {
      recs.push({ icon: "📊", level: "media", text: `El gasto en "${c.name}" creció ${fmtPct(c.trend)} en la segunda mitad del periodo. Verifica si es puntual o tendencia.` });
    }

    return { months, totalIncome, totalExpense, net, savingsRate, avgExpense, avgIncome, categories, emergencyMonths, cash, recs };
  }, [state.transactions, state.accounts, state.fx, period, base]);

  // Reporte comprensivo por granularidad (día/semana/mes/trimestre/etc)
  const comprehensiveReport = useMemo(() => {
    const txs = Array.isArray(state.transactions) ? state.transactions : [];
    const fx = state.fx || {};
    const groups = {};
    for (const t of txs) {
      if (!t || t.category === 'Transferencia' || !t.date) continue;
      const key = getGroupKey(t.date, gran);
      if (!groups[key]) groups[key] = { period: key, income: 0, expense: 0, count: 0, byCat: {} };
      const eur = toBase(Math.abs(t.amount || 0), t.currency || base);
      if ((t.amount || 0) > 0) {
        groups[key].income += eur;
      } else {
        groups[key].expense += eur;
        groups[key].byCat[t.category] = (groups[key].byCat[t.category] || 0) + eur;
      }
      groups[key].count++;
    }
    const list = Object.values(groups).sort((a, b) => a.period.localeCompare(b.period));
    const totalIncome = list.reduce((s, g) => s + g.income, 0);
    const totalExpense = list.reduce((s, g) => s + g.expense, 0);
    return { groups: list, totalIncome, totalExpense, net: totalIncome - totalExpense };
  }, [state.transactions, state.fx, gran, base]);

  // Descargas
  const handleDownloadCSV = () => downloadReportCSV(comprehensiveReport.groups, `reporte-${gran}-ingresos-gastos.csv`);
  const handleDownloadPDF = () => downloadReportPDF(comprehensiveReport.groups, gran);

  const maxBar = Math.max(1, ...data.months.map((m) => Math.max(m.income, m.expense)));

  return (
    <div className="space-y-4">
      {/* Selector de periodo */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold">Reportes</h2>
        <div className="flex gap-1 rounded-full bg-white/5 p-1" role="tablist" aria-label="Periodo del reporte">
          {PERIODS.map((p) => (
            <button
              key={p.id}
              role="tab"
              aria-selected={period === p.id}
              onClick={() => setPeriod(p.id)}
              className={`rounded-full px-3 py-1 text-xs font-medium transition ${period === p.id ? "bg-accent text-base-950" : "text-ink-dim"}`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* KPIs ejecutivos */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          ["Ingresos del periodo", fmtMoney(data.totalIncome, base), "text-gain"],
          ["Gastos del periodo", fmtMoney(data.totalExpense, base), "text-loss"],
          ["Flujo neto", fmtMoney(data.net, base), data.net >= 0 ? "text-gain" : "text-loss"],
          ["Tasa de ahorro", fmtPct(data.savingsRate), data.savingsRate >= 0.2 ? "text-gain" : "text-gold"],
        ].map(([label, value, color]) => (
          <Glass key={label} className="!p-3">
            <p className="text-xs text-ink-dim">{label}</p>
            <p className={`mt-1 text-xl font-bold tabular-nums ${color}`}>{value}</p>
          </Glass>
        ))}
      </div>

      {/* Ingresos vs Gastos por mes */}
      <Glass aria-label="Ingresos contra gastos por mes">
        <h3 className="mb-3 text-sm font-semibold">Ingresos vs Gastos</h3>
        <div className="flex items-end gap-2" style={{ height: 160 }} role="img"
          aria-label={data.months.map((m) => `${m.label}: ingresos ${fmtMoney(m.income, base, { compact: true })}, gastos ${fmtMoney(m.expense, base, { compact: true })}`).join("; ")}>
          {data.months.map((m) => (
            <div key={m.key} className="flex flex-1 flex-col items-center gap-1">
              <div className="flex w-full items-end justify-center gap-0.5" style={{ height: 130 }}>
                <motion.div
                  initial={{ height: 0 }} animate={{ height: `${(m.income / maxBar) * 100}%` }}
                  className="w-2/5 rounded-t bg-gradient-to-t from-emerald-600 to-emerald-400" title={`Ingresos ${fmtMoney(m.income, base)}`} />
                <motion.div
                  initial={{ height: 0 }} animate={{ height: `${(m.expense / maxBar) * 100}%` }}
                  className="w-2/5 rounded-t bg-gradient-to-t from-rose-700 to-rose-400" title={`Gastos ${fmtMoney(m.expense, base)}`} />
              </div>
              <span className="text-[10px] text-ink-dim">{m.label}</span>
            </div>
          ))}
        </div>
        <div className="mt-2 flex gap-4 text-xs text-ink-dim">
          <span className="flex items-center gap-1"><span className="size-2 rounded-sm bg-emerald-500" aria-hidden="true" /> Ingresos</span>
          <span className="flex items-center gap-1"><span className="size-2 rounded-sm bg-rose-500" aria-hidden="true" /> Gastos</span>
        </div>
      </Glass>

      {/* Gasto por categoría con tendencia */}
      <Glass aria-label="Gasto por categoría">
        <h3 className="mb-3 text-sm font-semibold">Gasto por categoría · tendencia</h3>
        <ul className="space-y-2">
          {data.categories.slice(0, 8).map((c) => (
            <li key={c.name}>
              <div className="mb-0.5 flex items-baseline justify-between text-xs">
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full" style={{ background: catColor(c.name, state.categories) }} aria-hidden="true" />
                  {c.name}
                  {c.trend > 0.15 && <span className="text-loss">▲ {fmtPct(c.trend)}</span>}
                  {c.trend < -0.15 && <span className="text-gain">▼ {fmtPct(Math.abs(c.trend))}</span>}
                </span>
                <span className="tabular-nums">{fmtMoney(c.total, base)} <span className="text-ink-dim">({fmtPct(c.pct)})</span></span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-white/8">
                <motion.div initial={{ width: 0 }} animate={{ width: `${c.pct * 100}%` }}
                  className="h-full rounded-full" style={{ background: catColor(c.name, state.categories) }} />
              </div>
            </li>
          ))}
          {!data.categories.length && <li className="text-xs text-ink-dim">Sin gastos en el periodo.</li>}
        </ul>
      </Glass>

      {/* Salud financiera */}
      <Glass aria-label="Salud financiera">
        <h3 className="mb-3 text-sm font-semibold">Salud financiera</h3>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          <div>
            <p className="text-xs text-ink-dim">Fondo de emergencia</p>
            <p className="text-lg font-bold tabular-nums">{Number.isFinite(data.emergencyMonths) ? `${data.emergencyMonths.toFixed(1)} meses` : "—"}</p>
            <p className="text-[10px] text-ink-dim">meta: 3–6 meses de gasto</p>
          </div>
          <div>
            <p className="text-xs text-ink-dim">Gasto medio mensual</p>
            <p className="text-lg font-bold tabular-nums">{fmtMoney(data.avgExpense, base)}</p>
          </div>
          <div>
            <p className="text-xs text-ink-dim">Ingreso medio mensual</p>
            <p className="text-lg font-bold tabular-nums">{fmtMoney(data.avgIncome, base)}</p>
          </div>
        </div>
      </Glass>

      {/* Recomendaciones */}
      <Glass aria-label="Recomendaciones financieras">
        <h3 className="mb-3 text-sm font-semibold">Recomendaciones</h3>
        <ul className="space-y-2">
          {data.recs.map((r, i) => (
            <li key={i} className={`flex gap-2 rounded-xl px-3 py-2 text-sm ${r.level === "alta" ? "bg-loss/10" : r.level === "media" ? "bg-gold/10" : "bg-gain/10"}`}>
              <span aria-hidden="true">{r.icon}</span>
              <span>{r.text}</span>
            </li>
          ))}
        </ul>
      </Glass>

      {/* Reporte comprensivo */}
      <Glass aria-label="Reporte comprensivo de ingresos y gastos">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-base font-semibold">Reporte Comprensivo de Ingresos y Gastos</h2>
          <select className={inputCls + " !w-36"} value={gran} onChange={e => setGran(e.target.value)}>
            {GRANULARITIES.map(g => <option key={g.id} value={g.id}>{g.label}</option>)}
          </select>
        </div>
        <p className="mb-2 text-xs text-ink-dim">Agrupado por la granularidad elegida. Excluye transferencias internas.</p>

        <div className="max-h-64 overflow-auto border border-white/10 rounded">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-white/5">
                <th className="text-left p-1">Periodo</th>
                <th className="text-right p-1">Ingresos</th>
                <th className="text-right p-1">Gastos</th>
                <th className="text-right p-1">Neto</th>
                <th className="text-right p-1"># Tx</th>
              </tr>
            </thead>
            <tbody>
              {comprehensiveReport.groups.map((g) => (
                <tr key={g.period} className="border-t border-white/5">
                  <td className="p-1 font-medium">{g.period}</td>
                  <td className="p-1 text-right text-gain">{fmtMoney(g.income, base)}</td>
                  <td className="p-1 text-right text-loss">{fmtMoney(g.expense, base)}</td>
                  <td className={`p-1 text-right ${g.income - g.expense >= 0 ? 'text-gain' : 'text-loss'}`}>
                    {fmtMoney(g.income - g.expense, base)}
                  </td>
                  <td className="p-1 text-right">{g.count}</td>
                </tr>
              ))}
              {comprehensiveReport.groups.length === 0 && (
                <tr><td colSpan={5} className="p-2 text-center text-ink-dim">Sin datos para agrupar.</td></tr>
              )}
            </tbody>
            <tfoot>
              <tr className="border-t bg-white/5 font-semibold">
                <td className="p-1">TOTAL</td>
                <td className="p-1 text-right text-gain">{fmtMoney(comprehensiveReport.totalIncome, base)}</td>
                <td className="p-1 text-right text-loss">{fmtMoney(comprehensiveReport.totalExpense, base)}</td>
                <td className={`p-1 text-right ${comprehensiveReport.net >= 0 ? 'text-gain' : 'text-loss'}`}>{fmtMoney(comprehensiveReport.net, base)}</td>
                <td className="p-1 text-right">{comprehensiveReport.groups.reduce((s, g) => s + g.count, 0)}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <Btn variant="ghost" onClick={handleDownloadCSV}>⬇️ CSV (abre en Excel)</Btn>
          <Btn variant="ghost" onClick={handleDownloadPDF}>⬇️ PDF (imprimir → Guardar como PDF)</Btn>
          <span className="text-[10px] text-ink-dim self-center">Excel: abre el CSV en Excel / Google Sheets</span>
        </div>
      </Glass>
    </div>
  );
}
