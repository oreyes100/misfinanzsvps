import { useMemo, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { monthSpend, netWorthEUR, pendingCardPayments, useStore } from "../store.jsx";
import { ACCOUNT_TYPES, LIABILITY_ACCOUNT_TYPES, catColor, convert, fmtMoney, fmtPct, groupedAccounts, sortedAccounts } from "../utils.js";
import { LineChart, PieChart } from "./Charts.jsx";
import { TransactionModal, TransferModal } from "./Modals.jsx";
import { Btn, Glass, Money } from "./UI.jsx";

function Delta({ value }) {
  return (
    <span className={`text-xs font-medium tabular-nums ${value >= 0 ? "text-gain" : "text-loss"}`}>
      {fmtPct(value)}
    </span>
  );
}

/** Barras de ingresos mensuales; la porción de intereses se resalta en azul. */
function IncomeBars({ months, base, fx }) {
  const inBase = (eur) => convert(eur, "EUR", base, fx);
  const max = Math.max(1, ...months.map((m) => m.total));
  return (
    <div
      className="flex h-36 items-end gap-2"
      role="img"
      aria-label={`Ingresos últimos meses: ${months.map((m) => `${m.label} ${fmtMoney(inBase(m.total), base, { compact: true })}`).join(", ")}`}
    >
      {months.map((m) => {
        const h = (m.total / max) * 100;
        const interestPct = m.total > 0 ? (m.interest / m.total) * 100 : 0;
        return (
          <div key={m.key} className="flex flex-1 flex-col items-center gap-1">
            <span className="text-[10px] tabular-nums text-ink-dim">{m.total > 0 ? fmtMoney(inBase(m.total), base, { compact: true }) : ""}</span>
            {base !== "EUR" && (
              <span className="text-[9px] tabular-nums text-ink-dim/60">{m.total > 0 ? `≈ ${fmtMoney(m.total, "EUR", { compact: true })}` : ""}</span>
            )}
            <div className="flex w-full max-w-10 flex-1 items-end">
              <div className="relative w-full overflow-hidden rounded-t-md bg-gain/80" style={{ height: `${Math.max(h, 1)}%` }} title={`${m.label}: ${fmtMoney(inBase(m.total), base)} (intereses ${fmtMoney(inBase(m.interest), base)})`}>
                {interestPct > 0 && (
                  <div className="absolute inset-x-0 bottom-0 bg-accent" style={{ height: `${interestPct}%` }} aria-hidden="true" />
                )}
              </div>
            </div>
            <span className="text-[11px] capitalize text-ink-dim">{m.label}</span>
          </div>
        );
      })}
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
  const featuredRE = state.assets.realEstate.find((r) => r.featured) || state.assets.realEstate[0];

  // Total invertido/líquido = todas las cuentas de activo (corriente, ahorro,
  // depósito, inversión, sofipo). Total deudas = pasivos (tarjeta, préstamo).
  const assetAccounts = state.accounts.filter((a) => !LIABILITY_ACCOUNT_TYPES.includes(a.type));
  const investTotal = assetAccounts.reduce((s, a) => s + a.balance * (state.fx[a.currency] ?? 1), 0);
  // Subtotal por divisa nativa (USD, MXN, …) ordenado de mayor a menor.
  const investByCurrency = Object.entries(
    assetAccounts.reduce((m, a) => ({ ...m, [a.currency]: (m[a.currency] || 0) + a.balance }), {})
  ).sort((x, y) => y[1] * (state.fx[y[0]] ?? 1) - x[1] * (state.fx[x[0]] ?? 1));
  const debtTotal = state.accounts
    .filter((a) => LIABILITY_ACCOUNT_TYPES.includes(a.type))
    .reduce((s, a) => s + Math.abs(a.balance) * (state.fx[a.currency] ?? 1), 0);

  const cardAlerts = pendingCardPayments(state);

  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:grid-rows-[auto_auto_auto]">
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

        <div className="mt-4 flex gap-2">
          <Btn onClick={() => setModal("transfer")}>⇄ Transferir</Btn>
          <Btn variant="ghost" onClick={() => setModal("tx")}>+ Movimiento</Btn>
        </div>
      </Glass>

      {/* ---- Cripto y Oro combinados ---- */}
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

      {/* ---- Inmuebles: muestra el inmueble destacado (configurable en Gestión) ---- */}
      <Glass className="lg:col-span-1" aria-label="Bienes raíces">
        <div className="mb-1 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold">Inmuebles</h2>
          {featuredRE && <Delta value={(featuredRE.valueEUR - featuredRE.costBasisEUR) / featuredRE.costBasisEUR} />}
        </div>
        {featuredRE ? (
          <>
            <p className="text-xl font-bold tabular-nums">{fmtMoney(inBase(featuredRE.valueEUR), base, { compact: true })}</p>
            <p className="mt-1 text-xs text-ink-dim">{featuredRE.name}<br /><span className="opacity-70">{featuredRE.source}</span></p>
            {state.assets.realEstate.length > 1 && (
              <p className="mt-1 text-xs text-ink-dim/70">+{state.assets.realEstate.length - 1} más · total {fmtMoney(inBase(reValue), base, { compact: true })}</p>
            )}
          </>
        ) : (
          <p className="text-sm text-ink-dim">Sin inmuebles. Añádelos en Gestión.</p>
        )}
      </Glass>

      {/* ---- Total de inversiones (cuentas de activo: corriente, ahorro, depósito, inversión, sofipo) ---- */}
      <Glass className="lg:col-span-1" aria-label="Total de inversiones y efectivo">
        <h2 className="mb-1 text-sm font-semibold">Total de inversiones</h2>
        <p className="text-xl font-bold tabular-nums text-gain">{fmtMoney(inBase(investTotal), base, { compact: true })}</p>
        <p className="mt-1 text-xs text-ink-dim">Efectivo, ahorro, depósitos, inversión y sofipos</p>
        <ul className="mt-2 space-y-1 text-xs">
          {investByCurrency.map(([cur, amount]) => (
            <li key={cur} className="flex items-center justify-between">
              <span className="text-ink-dim">{cur}</span>
              <span className="flex items-center gap-2">
                <span className="font-medium tabular-nums">{fmtMoney(amount, cur, { compact: true })}</span>
                {cur !== base && (
                  <span className="tabular-nums text-ink-dim/70">≈ {fmtMoney(convert(amount, cur, base, state.fx), base, { compact: true })}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </Glass>

      {/* ---- Total de deudas (pasivos: tarjeta, préstamo) ---- */}
      <Glass className="lg:col-span-1" aria-label="Total de deudas">
        <h2 className="mb-1 text-sm font-semibold">Total de deudas</h2>
        <p className={`text-xl font-bold tabular-nums ${debtTotal > 0 ? "text-loss" : "text-ink"}`}>
          {debtTotal > 0 ? "−" : ""}{fmtMoney(inBase(debtTotal), base, { compact: true })}
        </p>
        {debtTotal > 0 ? (
          <ul className="mt-2 space-y-1 text-xs">
            {state.accounts
              .filter((a) => LIABILITY_ACCOUNT_TYPES.includes(a.type))
              .map((a) => (
                <li key={a.id} className="flex justify-between">
                  <span className="truncate text-ink-dim">{ACCOUNT_TYPES[a.type]} · {a.name}</span>
                  <span className="tabular-nums text-loss">{fmtMoney(convert(Math.abs(a.balance), a.currency, base, state.fx), base, { compact: true })}</span>
                </li>
              ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-ink-dim">Sin deudas registradas. 🎉</p>
        )}
      </Glass>

      {/* ---- Cuentas ---- */}
      <Glass className="col-span-2 lg:col-span-2" aria-label="Cuentas bancarias">
        <h2 className="mb-2 text-sm font-semibold">Cuentas</h2>
        <ul className="space-y-1">
          {groupedAccounts(state.accounts).map(({ type, label, accounts }) => (
            <li key={type}>
              <p className="mb-1 mt-2 px-1 text-[10px] font-semibold uppercase tracking-widest text-ink-dim first:mt-0">{label}</p>
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

      {/* ---- Distribución de gastos + Ingresos por mes (debajo de la dona) ---- */}
      <Glass className="col-span-2 lg:col-span-2" aria-label="Distribución de gastos e ingresos por mes">
        <h2 className="mb-2 text-sm font-semibold">Distribución de gastos</h2>
        <PieChart slices={expenseSlices} totalLabel={fmtMoney(inBase(spend), base, { compact: true })} />

        <hr className="my-3 border-white/8" />

        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-1">
          <h2 className="text-sm font-semibold">Ingresos por mes</h2>
          <span className="flex items-center gap-3 text-xs text-ink-dim">
            <span className="flex items-center gap-1"><span className="size-2 rounded-sm bg-gain" aria-hidden="true" /> Ingresos</span>
            <span className="flex items-center gap-1"><span className="size-2 rounded-sm bg-accent" aria-hidden="true" /> Intereses</span>
          </span>
        </div>
        <IncomeBars months={incomeMonths} base={base} fx={state.fx} />
        <p className="mt-2 text-xs text-ink-dim tabular-nums">
          Total 6 meses: {fmtMoney(inBase(incomeMonths.reduce((s, m) => s + m.total, 0)), base, { compact: true })}
          {base !== "EUR" && <> ≈ {fmtMoney(incomeMonths.reduce((s, m) => s + m.total, 0), "EUR", { compact: true })}</>}
          {" · "}Intereses: {fmtMoney(inBase(incomeMonths.reduce((s, m) => s + m.interest, 0)), base, { compact: true })}
        </p>
      </Glass>

      <AnimatePresence>
        {modal === "transfer" && <TransferModal onClose={() => setModal(null)} />}
        {modal === "tx" && <TransactionModal onClose={() => setModal(null)} />}
      </AnimatePresence>
    </div>
  );
}
