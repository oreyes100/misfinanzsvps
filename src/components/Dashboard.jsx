import { useMemo, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { useStore } from "../store.jsx";
import { monthSpend, netWorthEUR, pendingCardPayments } from "../selectors.js";
import { ACCOUNT_TYPES, LIABILITY_ACCOUNT_TYPES, cardOn, catColor, convert, fmtMoney, fmtPct, groupedAccounts, sortedAccounts } from "../utils.js";
import { BarChart, LineChart, PieChart } from "./Charts.jsx";
import { TransactionModal, TransferModal } from "./Modals.jsx";
import { Btn, Glass, Money } from "./UI.jsx";

function Delta({ value }) {
  return (
    <span className={`text-xs font-medium tabular-nums ${value >= 0 ? "text-gain" : "text-loss"}`}>
      {fmtPct(value)}
    </span>
  );
}

/** Ingresos del mes corriente: tarjeta grande y colorida, con porción de intereses y comparación vs mes anterior. */
function CurrentMonthIncome({ months, base, fx }) {
  const inBase = (eur) => convert(eur, "EUR", base, fx);
  const current = months[months.length - 1];
  const previous = months[months.length - 2];
  if (!current) return null;
  const interestPct = current.total > 0 ? (current.interest / current.total) * 100 : 0;
  const delta = previous?.total > 0 ? (current.total - previous.total) / previous.total : null;
  const monthName = new Date().toLocaleDateString("es-ES", { month: "long", year: "numeric" });

  return (
    <div
      className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-emerald-500/20 via-teal-500/10 to-sky-500/20 p-5 ring-1 ring-emerald-400/20"
      role="img"
      aria-label={`Ingresos de ${monthName}: ${fmtMoney(inBase(current.total), base)}, de los cuales ${fmtMoney(inBase(current.interest), base)} son intereses`}
    >
      <p className="text-xs font-medium uppercase tracking-widest text-emerald-300/80">{monthName}</p>
      <p className="mt-1 text-4xl font-bold tabular-nums text-white">
        {fmtMoney(inBase(current.total), base)}
      </p>
      {base !== "EUR" && (
        <p className="text-xs tabular-nums text-ink-dim">≈ {fmtMoney(current.total, "EUR")}</p>
      )}
      {delta !== null && (
        <p className={`mt-1 text-sm font-semibold ${delta >= 0 ? "text-gain" : "text-loss"}`}>
          {delta >= 0 ? "▲" : "▼"} {fmtPct(Math.abs(delta))} vs mes anterior
        </p>
      )}

      {/* Barra grande: ingresos con porción de intereses */}
      <div className="mt-4 h-6 overflow-hidden rounded-full bg-white/10">
        <div className="relative h-full rounded-full bg-gradient-to-r from-emerald-500 via-teal-400 to-sky-400" style={{ width: "100%" }}>
          {interestPct > 0 && (
            <div
              className="absolute inset-y-0 right-0 rounded-r-full bg-gradient-to-r from-indigo-400 to-violet-400"
              style={{ width: `${interestPct}%` }}
              title={`Intereses: ${fmtMoney(inBase(current.interest), base)}`}
              aria-hidden="true"
            />
          )}
        </div>
      </div>
      <div className="mt-2 flex justify-between text-xs text-ink-dim">
        <span className="flex items-center gap-1"><span className="size-2 rounded-sm bg-emerald-400" aria-hidden="true" /> Nómina y otros: {fmtMoney(inBase(current.total - current.interest), base, { compact: true })}</span>
        <span className="flex items-center gap-1"><span className="size-2 rounded-sm bg-violet-400" aria-hidden="true" /> Intereses: {fmtMoney(inBase(current.interest), base, { compact: true })}</span>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const { state, dispatch } = useStore();
  const [modal, setModal] = useState(null); // "transfer" | "tx" | null
  const base = state.settings.baseCurrency;
  const nw = netWorthEUR(state);
  const spend = monthSpend(state);

  const inBase = (eur) => convert(eur, "EUR", base, state.fx);

  const expenseSlices = useMemo(() => {
    const month = new Date().toISOString().slice(0, 7);
    const byCat = {};
    for (const t of state.transactions) {
      if (t.amount >= 0 || !t.date.startsWith(month) || t.category === "Transferencia") continue;
      const eur = Math.abs(t.amount) * (state.fx[t.currency] ?? 1);
      byCat[t.category] = (byCat[t.category] || 0) + eur;
    }
    return Object.entries(byCat)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([label, value]) => ({ label, value, color: catColor(label, state.categories) }));
  }, [state.transactions, state.fx, state.categories]);

  // Ingresos por mes (últimos 6 meses), incluye nómina e intereses.
  const incomeMonths = useMemo(() => {
    const months = [];
    const now = new Date();
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, label: d.toLocaleDateString("es-ES", { month: "short" }), total: 0, interest: 0 });
    }
    const idx = Object.fromEntries(months.map((m, i) => [m.key, i]));
    for (const t of state.transactions) {
      if (t.amount <= 0 || t.category === "Transferencia") continue;
      const k = t.date.slice(0, 7);
      if (!(k in idx)) continue;
      const eur = t.amount * (state.fx[t.currency] ?? 1);
      months[idx[k]].total += eur;
      if (t.category === "Intereses") months[idx[k]].interest += eur;
    }
    return months;
  }, [state.transactions, state.fx]);

  // Intereses generados por día (últimos 14 días) en divisa base, y porcentaje
  // global que el interés acumulado representa sobre el total invertido.
  const interestDaily = useMemo(() => {
    const DAYS = 14;
    const perDay = {};
    let totalAll = 0;
    for (const t of state.transactions) {
      if (t.category !== "Intereses" || t.amount <= 0) continue;
      const eur = t.amount * (state.fx[t.currency] ?? 1);
      perDay[t.date] = (perDay[t.date] || 0) + eur;
      totalAll += eur;
    }
    const bars = [];
    const now = new Date();
    for (let i = DAYS - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      bars.push({ iso, label: String(d.getDate()), value: perDay[iso] || 0 });
    }
    // Tendencia actual: promedio diario sobre los días con interés en la ventana
    // (evita que los días sin devengo aún hundan la proyección). Proyección
    // simple = ese ritmo diario × 30 (mes) y × 365 (año).
    const active = bars.filter((b) => b.value > 0);
    const avgDaily = active.length ? active.reduce((s, b) => s + b.value, 0) / active.length : 0;
    return { bars, totalAll, avgDaily, monthly: avgDaily * 30, annual: avgDaily * 365 };
  }, [state.transactions, state.fx]);

  // Tendencia de patrimonio simulada a partir del histórico de precios en vivo
  const nwTrend = useMemo(() => {
    const h = state.priceHistory.BTC;
    if (h.length < 2) return [];
    const btcQty = state.assets.crypto.find((c) => c.symbol === "BTC")?.qty || 0;
    const fixed = nw.total - btcQty * state.fx.BTC;
    return h.map((p) => fixed + btcQty * p);
  }, [state.priceHistory.BTC]); // eslint-disable-line react-hooks/exhaustive-deps

  const cryptoValue = state.assets.crypto.reduce((s, c) => s + c.qty * state.fx[c.symbol], 0);
  const cryptoCost = state.assets.crypto.reduce((s, c) => s + c.costBasisEUR, 0);
  const goldValue = state.assets.gold.grams * state.goldPriceEUR;
  const reValue = state.assets.realEstate.reduce((s, r) => s + r.valueEUR, 0);
  const reCost = state.assets.realEstate.reduce((s, r) => s + r.costBasisEUR, 0);
  const rePct = reCost > 0 ? (reValue - reCost) / reCost : 0;

  // Total invertido/líquido = todas las cuentas de activo (corriente, ahorro,
  // depósito, inversión, sofipo). Total deudas = pasivos (tarjeta, préstamo).
  const assetAccounts = state.accounts.filter((a) => !LIABILITY_ACCOUNT_TYPES.includes(a.type));
  const investTotal = assetAccounts.reduce((s, a) => s + a.balance * (state.fx[a.currency] ?? 1), 0);
  // Desglose por tipo de cuenta, separado por moneda.
  const investByType = groupedAccounts(assetAccounts).map(({ type, label, accounts }) => ({
    type,
    label,
    totalEUR: accounts.reduce((s, a) => s + a.balance * (state.fx[a.currency] ?? 1), 0),
  }));
  // Grupos por moneda: MXN y USD (u otras) con desglose por tipo.
  const INVEST_CURRENCIES = ["MXN", "USD"];
  const investByCurrency = INVEST_CURRENCIES.map((cur) => {
    const accs = assetAccounts.filter((a) => a.currency === cur);
    if (!accs.length) return null;
    const byType = groupedAccounts(accs).map(({ type, label, accounts }) => ({
      type, label,
      native: accounts.reduce((s, a) => s + a.balance, 0),
    })).filter((g) => g.native !== 0);
    const total = accs.reduce((s, a) => s + a.balance, 0);
    return { cur, byType, total };
  }).filter(Boolean);
  // Monedas no listadas: agregar como bloque extra.
  const listedCurs = new Set(INVEST_CURRENCIES);
  const otherCurAccs = assetAccounts.filter((a) => !listedCurs.has(a.currency));
  if (otherCurAccs.length) {
    const extra = [...new Set(otherCurAccs.map((a) => a.currency))];
    extra.forEach((cur) => {
      const accs = otherCurAccs.filter((a) => a.currency === cur);
      const byType = groupedAccounts(accs).map(({ type, label, accounts }) => ({
        type, label, native: accounts.reduce((s, a) => s + a.balance, 0),
      })).filter((g) => g.native !== 0);
      investByCurrency.push({ cur, byType, total: accs.reduce((s, a) => s + a.balance, 0) });
    });
  }
  // Deuda total = solo tarjetas de crédito. El préstamo de auto se reporta
  // aparte (no entra en el total, igual que no resta del patrimonio neto).
  const creditAccounts = state.accounts.filter((a) => a.type === "credit");
  const debtTotal = creditAccounts.reduce((s, a) => s + Math.abs(a.balance) * (state.fx[a.currency] ?? 1), 0);

  // Subtotal por tipo de cuenta (en divisa base) para los encabezados de grupo.
  const accountTypeTotals = state.accounts.reduce((m, a) => {
    m[a.type] = (m[a.type] || 0) + a.balance * (state.fx[a.currency] ?? 1);
    return m;
  }, {});

  const cardAlerts = pendingCardPayments(state);

  const interestAnomalies = state.pendingInterestAnomalies || [];

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:grid-rows-[auto_auto_auto]">
      {/* ---- Alerta de intereses fuera de rango (sanity guard) ---- */}
      {interestAnomalies.map((a) => (
        <Glass key={`${a.accountId}-${a.date}`} className="col-span-2 lg:col-span-4 !rounded-2xl border-yellow-500/40 !bg-yellow-500/10 !p-3" aria-label={`Interés inusual en ${a.accountName}`}>
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-xl" aria-hidden="true">⚠️</span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-yellow-400">Interés inusual bloqueado · {a.accountName}</p>
              <p className="text-xs text-ink-dim">
                {a.date} · Calculado: {a.gain.toLocaleString("es-MX", { style: "currency", currency: "MXN" })} · Máximo esperado: {a.cap.toLocaleString("es-MX", { style: "currency", currency: "MXN" })} · Span: {a.days} días
              </p>
            </div>
            <div className="flex gap-2">
              <Btn size="sm" onClick={() => dispatch({ type: "approve_interest_anomaly", accountId: a.accountId, date: a.date })}>
                Aprobar y registrar
              </Btn>
              <Btn size="sm" variant="danger" onClick={() => dispatch({ type: "discard_interest_anomaly", accountId: a.accountId, date: a.date })}>
                Descartar
              </Btn>
            </div>
          </div>
        </Glass>
      ))}
      {/* ---- Avisos de pago de tarjeta (diarios hasta marcar pagado) ---- */}
      {cardAlerts.length > 0 && (
        <div className="col-span-2 space-y-2 lg:col-span-4">
          {cardAlerts.map((p) => (
            <Glass key={p.account.id} className="!rounded-2xl border-loss/40 !bg-loss/10 !p-3" aria-label={`Pago pendiente de ${p.account.name}`}>
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-xl" aria-hidden="true">⏰</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-loss">
                    Pago pendiente · {p.account.name}
                  </p>
                  <p className="text-xs text-ink-dim">
                    {p.due
                      ? `Venció el día ${p.account.payDay}. `
                      : `Vence el día ${p.account.payDay} (en ${p.daysToDue} día${p.daysToDue === 1 ? "" : "s"}). `}
                    Deuda {fmtMoney(convert(p.debt, p.account.currency, base, state.fx), base)}.
                  </p>
                </div>
                <Btn variant="gain" className="!py-1.5 text-xs" onClick={() => dispatch({ type: "mark_card_paid", accountId: p.account.id, cycle: p.cycle })}>
                  Marcar pagado
                </Btn>
              </div>
            </Glass>
          ))}
        </div>
      )}

      {/* ---- Patrimonio neto: la celda más prominente del bento ---- */}
      <Glass className="col-span-2 row-span-2 flex flex-col justify-between !p-5" aria-label="Patrimonio neto total">
        <div>
          <p className="text-sm text-ink-dim">Patrimonio neto total</p>
          <p className="mt-1 text-4xl font-bold tracking-tight tabular-nums sm:text-5xl">
            {fmtMoney(inBase(nw.total), base, { compact: false })}
          </p>
          <div className="mt-2 flex items-center gap-2 text-xs text-ink-dim">
            <span className="inline-flex size-1.5 animate-pulse rounded-full bg-gain" aria-hidden="true" />
            Valoración en tiempo real · divisa base {base}
          </div>
        </div>

        <div className="my-3">
          <LineChart data={nwTrend} stroke="auto" height={88} label="Tendencia del patrimonio" />
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
          {[
            ["Efectivo y ahorro", nw.cash],
            ["Cripto", nw.crypto],
            ["Oro", nw.gold],
            ["Inmuebles", nw.realEstate],
            ["Bienes (autos…)", nw.depreciating],
          ].map(([k, v]) => (
            <div key={k} className="flex justify-between border-b border-white/6 pb-1">
              <dt className="text-ink-dim">{k}</dt>
              <dd className="tabular-nums">{fmtMoney(inBase(v), base, { compact: true })}</dd>
            </div>
          ))}
        </dl>

        {/* Préstamo de auto: deuda fuera del patrimonio neto, destacada en su propia fila. */}
        {nw.autoLoan < 0 && (
          <div className="mt-3 flex items-baseline justify-between border-t-2 border-loss/30 pt-3">
            <dt className="text-base font-bold text-loss">Préstamo de auto</dt>
            <dd className="text-2xl font-bold tabular-nums text-loss">
              −{fmtMoney(inBase(Math.abs(nw.autoLoan)), base, { compact: true })}
            </dd>
          </div>
        )}

        <div className="mt-4 flex gap-2">
          <Btn onClick={() => setModal("transfer")}>⇄ Transferir</Btn>
          <Btn variant="ghost" onClick={() => setModal("tx")}>+ Movimiento</Btn>
        </div>
      </Glass>

      {/* ---- Intereses generados por día + % sobre la inversión ---- */}
      {cardOn(state.settings, "intereses") && (() => {
        const pct = investTotal > 0 ? (interestDaily.totalAll / investTotal) * 100 : 0;
        const monthlyPct = investTotal > 0 ? (interestDaily.monthly / investTotal) * 100 : 0;
        const annualPct = investTotal > 0 ? (interestDaily.annual / investTotal) * 100 : 0;
        const last = interestDaily.bars[interestDaily.bars.length - 1];
        return (
          <Glass className="col-span-2 lg:col-span-2" aria-label="Intereses generados por día">
            <div className="mb-1 flex items-baseline justify-between">
              <h2 className="text-sm font-semibold">Intereses por día</h2>
              <span className="text-xs text-ink-dim">últimos 14 días</span>
            </div>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <p className="text-xl font-bold tabular-nums text-gain">{fmtMoney(inBase(last?.value || 0), base, { compact: true })}</p>
              <span className="text-xs text-ink-dim">hoy</span>
            </div>
            <div className="mt-2">
              <BarChart
                bars={interestDaily.bars.map((b) => ({ label: b.label, value: inBase(b.value), title: `${b.iso}: ${fmtMoney(inBase(b.value), base)}` }))}
                fmt={(v) => fmtMoney(v, base, { compact: true })}
                label="Intereses por día"
              />
            </div>
            {/* Proyección con la tendencia actual: ritmo diario × 30 y × 365. */}
            <div className="mt-2 grid grid-cols-2 gap-2">
              <div className="rounded-xl bg-white/5 px-3 py-2">
                <p className="text-[10px] uppercase tracking-wide text-ink-dim">Proyección / mes</p>
                <p className="text-base font-bold tabular-nums text-gain">≈ {fmtMoney(inBase(interestDaily.monthly), base, { compact: true })} <span className="text-xs font-normal text-ink-dim">{fmtPct(monthlyPct / 100)}</span></p>
              </div>
              <div className="rounded-xl bg-white/5 px-3 py-2">
                <p className="text-[10px] uppercase tracking-wide text-ink-dim">Proyección / año</p>
                <p className="text-base font-bold tabular-nums text-gain">≈ {fmtMoney(inBase(interestDaily.annual), base, { compact: true })} <span className="text-xs font-normal text-ink-dim">{fmtPct(annualPct / 100)}</span></p>
              </div>
            </div>
            <p className="mt-1 text-[10px] text-ink-dim">Estimado con la tendencia actual ({fmtMoney(inBase(interestDaily.avgDaily), base, { compact: true })}/día).</p>
            <div className="mt-2 flex items-center justify-between border-t border-white/8 pt-2 text-xs">
              <span className="text-ink-dim">Interés acumulado · {fmtMoney(inBase(interestDaily.totalAll), base, { compact: true })}</span>
              <span className="font-semibold tabular-nums text-gain" title="Interés total acumulado ÷ total invertido actual">
                {fmtPct(pct / 100)} sobre la inversión
              </span>
            </div>
          </Glass>
        );
      })()}

      {/* ---- Cripto y Oro combinados ---- */}
      {cardOn(state.settings, "criptoOro") && (
      <Glass className="col-span-2 lg:col-span-1" aria-label="Cripto y oro">
        <div className="mb-1 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold">Cripto y Oro</h2>
          <Delta value={(cryptoValue + goldValue - cryptoCost - state.assets.gold.costBasisEUR) / (cryptoCost + state.assets.gold.costBasisEUR)} />
        </div>
        <p className="text-xl font-bold tabular-nums">{fmtMoney(inBase(cryptoValue + goldValue), base, { compact: true })}</p>

        <div className="mt-2 flex items-center justify-between text-xs">
          <span className="font-medium">Cripto</span>
          <span className="flex items-center gap-2">
            <span className="tabular-nums text-ink-dim">{fmtMoney(inBase(cryptoValue), base, { compact: true })}</span>
            <Delta value={(cryptoValue - cryptoCost) / cryptoCost} />
          </span>
        </div>
        <LineChart data={state.priceHistory.BTC} stroke="auto" height={34} label="Precio de Bitcoin" />

        <div className="mt-1 flex items-center justify-between text-xs">
          <span className="font-medium text-gold">Oro · {state.assets.gold.grams} g</span>
          <span className="flex items-center gap-2">
            <span className="tabular-nums text-ink-dim">{fmtMoney(inBase(goldValue), base, { compact: true })}</span>
            <Delta value={(goldValue - state.assets.gold.costBasisEUR) / state.assets.gold.costBasisEUR} />
          </span>
        </div>
        <LineChart data={state.priceHistory.GOLD} stroke="#f5c451" height={34} label="Precio del oro" />
      </Glass>
      )}

      {/* ---- Inmuebles: todos con total ---- */}
      {cardOn(state.settings, "inmuebles") && (
      <Glass className="lg:col-span-1" aria-label="Bienes raíces">
        <div className="mb-1 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold">Inmuebles</h2>
          {reValue > 0 && <Delta value={rePct} />}
        </div>
        {state.assets.realEstate.length ? (
          <>
            <p className="text-xl font-bold tabular-nums">{fmtMoney(inBase(reValue), base, { compact: true })}</p>
            <ul className="mt-2 space-y-1 text-xs">
              {state.assets.realEstate.map((r) => (
                <li key={r.id} className="flex items-center justify-between">
                  <span className="truncate text-ink-dim">{r.featured ? "★ " : ""}{r.name}</span>
                  <span className="font-medium tabular-nums">{fmtMoney(inBase(r.valueEUR), base, { compact: true })}</span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-sm text-ink-dim">Sin inmuebles. Añádelos en Gestión.</p>
        )}
      </Glass>
      )}

      {/* ---- Total de inversiones por moneda ---- */}
      {cardOn(state.settings, "inversiones") && (
      <Glass className="lg:col-span-1" aria-label="Total de inversiones y efectivo">
        <h2 className="mb-1 text-sm font-semibold">Total de inversiones</h2>
        <p className="text-xl font-bold tabular-nums text-gain">{fmtMoney(inBase(investTotal), base)}</p>
        <p className="mt-1 text-xs text-ink-dim">Efectivo, ahorro, depósitos, inversión y sofipos</p>
        <div className="mt-3 space-y-3">
          {investByCurrency.map(({ cur, byType, total }) => (
            <div key={cur}>
              <ul className="space-y-1 text-xs">
                {byType.map(({ type, label, native }) => (
                  <li key={type} className="flex items-center justify-between">
                    <span className="font-semibold uppercase tracking-wide text-ink-dim">{label}</span>
                    <span className="font-medium tabular-nums">{fmtMoney(native, cur)}</span>
                  </li>
                ))}
              </ul>
              <div className="mt-1 flex items-center justify-between border-t border-white/10 pt-1 text-xs">
                <span className="font-semibold text-ink-dim">Total en {cur === "MXN" ? "pesos" : cur === "USD" ? "dólares" : cur}</span>
                <span className="font-bold tabular-nums text-gain">{fmtMoney(total, cur)}</span>
              </div>
            </div>
          ))}
        </div>
      </Glass>
      )}

      {/* ---- Total de deudas (pasivos: tarjeta, préstamo) ---- */}
      {cardOn(state.settings, "deudas") && (
      <Glass className="lg:col-span-1" aria-label="Total de deudas">
        <h2 className="mb-1 text-sm font-semibold">Total de deudas</h2>
        <p className={`text-xl font-bold tabular-nums ${debtTotal > 0 ? "text-loss" : "text-ink"}`}>
          {debtTotal > 0 ? "−" : ""}{fmtMoney(inBase(debtTotal), base, { compact: true })}
        </p>
        {debtTotal > 0 ? (
          <ul className="mt-2 space-y-1 text-xs">
            {creditAccounts.map((a) => (
              <li key={a.id} className="flex justify-between">
                <span className="truncate text-ink-dim">{ACCOUNT_TYPES[a.type]} · {a.name}</span>
                <span className="tabular-nums text-loss">{fmtMoney(convert(Math.abs(a.balance), a.currency, base, state.fx), base, { compact: true })}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-ink-dim">Sin tarjetas con deuda. 🎉</p>
        )}

        {/* Préstamo de auto: deuda aparte, fuera del total, en letras grandes. */}
        {nw.autoLoan < 0 && (
          <div className="mt-3 border-t-2 border-loss/30 pt-3">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-ink-dim">Préstamo de auto</p>
            <p className="mt-0.5 text-2xl font-bold tabular-nums text-loss">
              −{fmtMoney(inBase(Math.abs(nw.autoLoan)), base, { compact: true })}
            </p>
          </div>
        )}
      </Glass>
      )}

      {/* ---- Cuentas ---- */}
      {cardOn(state.settings, "cuentas") && (
      <Glass className="col-span-2 lg:col-span-2" aria-label="Cuentas bancarias">
        <h2 className="mb-2 text-sm font-semibold">Cuentas</h2>
        <ul className="space-y-1">
          {groupedAccounts(state.accounts).map(({ type, label, accounts }) => (
            <li key={type}>
              <div className="mb-1 mt-2 flex items-baseline justify-between px-1 first:mt-0">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-ink-dim">{label}</p>
                <p className={`text-xs font-semibold tabular-nums ${LIABILITY_ACCOUNT_TYPES.includes(type) ? "text-loss" : "text-ink"}`}>
                  {fmtMoney(inBase(accountTypeTotals[type] ?? 0), base, { compact: true })}
                </p>
              </div>
              <ul className="space-y-1">
                {accounts.map((a) => (
                  <li key={a.id} className="flex items-center justify-between rounded-xl bg-white/5 px-3 py-2">
                    <div>
                      <p className="text-sm font-medium">{a.name}</p>
                      {a.rate > 0 && (
                        <p className="text-xs text-gain">{(a.rate * 100).toFixed(2)} % TAE · {a.accrual === "daily" ? "diario" : "mensual"}</p>
                      )}
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-semibold tabular-nums">{fmtMoney(a.balance, a.currency)}</p>
                      {a.currency !== base && (
                        <p className="text-xs text-ink-dim tabular-nums">≈ {fmtMoney(convert(a.balance, a.currency, base, state.fx), base)}</p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </Glass>
      )}

      {/* ---- Distribución de gastos + Ingresos por mes (debajo de la dona) ---- */}
      {cardOn(state.settings, "gastosIngresos") && (
      <Glass className="col-span-2 lg:col-span-2" aria-label="Distribución de gastos e ingresos por mes">
        <h2 className="mb-2 text-sm font-semibold">Distribución de gastos</h2>
        <PieChart slices={expenseSlices} totalLabel={fmtMoney(inBase(spend), base, { compact: true })} />

        <hr className="my-3 border-white/8" />

        <h2 className="mb-2 text-sm font-semibold">Ingresos del mes</h2>
        <CurrentMonthIncome months={incomeMonths} base={base} fx={state.fx} />
        <p className="mt-2 text-xs text-ink-dim">Histórico de 3, 6 y 12 meses en la sección <strong>Reportes</strong>.</p>
      </Glass>
      )}

      <AnimatePresence>
        {modal === "transfer" && <TransferModal onClose={() => setModal(null)} />}
        {modal === "tx" && <TransactionModal onClose={() => setModal(null)} />}
      </AnimatePresence>
    </div>
  );
}
