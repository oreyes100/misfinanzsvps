import { useState } from "react";
import { AnimatePresence } from "framer-motion";
import { useStore } from "../store.jsx";
import { ACCOUNT_TYPES, CURRENCIES, INTEREST_ACCOUNT_TYPES, LIABILITY_ACCOUNT_TYPES, convert, fmtMoney, groupedAccounts } from "../utils.js";
import { Btn, Field, Glass, Modal, inputCls } from "./UI.jsx";

/** Alta/edición de cuenta. `account` null → crear. */
function AccountModal({ account, onClose }) {
  const { state, dispatch } = useStore();
  const isNew = !account;
  const [form, setForm] = useState(
    account
      ? {
          // se edita la magnitud; el signo lo da el tipo
          ...account, balance: Math.abs(account.balance),
          // tramos con tope (defaults para que los inputs sean controlados)
          capped: account.capped || false,
          rate1: account.rate1 || 0, balanceCap1: account.balanceCap1 || "", gainCap1: account.gainCap1 || "", accrual1: account.accrual1 || "monthly",
          rate2: account.rate2 || 0, balanceCap2: account.balanceCap2 || "", gainCap2: account.gainCap2 || "", accrual2: account.accrual2 || "monthly",
        }
      : {
          name: "", type: "checking", currency: state.settings.baseCurrency, balance: "", rate: 0, accrual: "none",
          capped: false,
          rate1: 0, balanceCap1: "", gainCap1: "", accrual1: "monthly",
          rate2: 0, balanceCap2: "", gainCap2: "", accrual2: "monthly",
        }
  );
  const [error, setError] = useState("");
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const hasInterest = INTEREST_ACCOUNT_TYPES.includes(form.type);
  const isLiability = LIABILITY_ACCOUNT_TYPES.includes(form.type);
  // El modelo escalonado con tope + impuesto solo aplica a cuentas en pesos (MXN).
  const isCappable = (form.type === "investment" || form.type === "sofipo") && form.currency === "MXN";
  const useTiers = isCappable && form.capped;
  const ratePct = (form.rate * 100).toFixed(2);
  const balance = parseFloat(form.balance) || 0;
  const monthlyEst = hasInterest && !useTiers && form.accrual !== "none" ? balance * (form.rate / 12) : 0;

  const save = (e) => {
    e.preventDefault();
    if (!form.name.trim()) return setError("Ponle un nombre a la cuenta.");
    if (balance < 0) return setError("Introduce el importe como número positivo.");
    const payload = {
      name: form.name.trim(),
      type: form.type,
      currency: form.currency,
      // Pasivos (tarjeta, préstamo) se guardan en negativo: restan del patrimonio.
      balance: (isLiability ? -1 : 1) * Math.round(balance * 100) / 100,
      rate: hasInterest && !useTiers ? form.rate : 0,
      accrual: hasInterest && !useTiers && form.rate > 0 ? form.accrual : "none",
    };
    if (useTiers) {
      payload.capped = true;
      payload.rate1 = form.rate1;
      payload.balanceCap1 = parseFloat(form.balanceCap1) || 0;
      payload.gainCap1 = parseFloat(form.gainCap1) || 0;
      payload.accrual1 = form.accrual1;
      payload.rate2 = form.rate2;
      payload.balanceCap2 = parseFloat(form.balanceCap2) || 0;
      payload.gainCap2 = parseFloat(form.gainCap2) || 0;
      payload.accrual2 = form.accrual2;
    } else if (isCappable) {
      payload.capped = false;
    }
    if (form.type === "credit") {
      payload.cutDay = Math.min(31, Math.max(1, parseInt(form.cutDay, 10) || 0)) || null;
      payload.payDay = Math.min(31, Math.max(1, parseInt(form.payDay, 10) || 0)) || null;
    }
    if (isNew) dispatch({ type: "add_account", account: payload });
    else dispatch({ type: "update_account", accountId: account.id, patch: payload });
    onClose();
  };

  return (
    <Modal title={isNew ? "Nueva cuenta" : `Editar «${account.name}»`} onClose={onClose} labelId="account-modal-title">
      <form className="space-y-3" onSubmit={save}>
        <Field label="Nombre">
          <input className={inputCls} value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="Ej.: Ahorro vacaciones" required />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Tipo">
            <select className={inputCls} value={form.type} onChange={(e) => set("type", e.target.value)}>
              {Object.entries(ACCOUNT_TYPES).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
          <Field label="Divisa">
            <select className={inputCls} value={form.currency} onChange={(e) => set("currency", e.target.value)}>
              {CURRENCIES.map((c) => <option key={c}>{c}</option>)}
            </select>
          </Field>
        </div>

        <Field
          label={isLiability ? "Deuda pendiente" : isNew ? "Saldo inicial" : "Saldo"}
          hint={isLiability ? "Importe que debes. Se registra como pasivo y resta del patrimonio." : undefined}
        >
          <input
            className={inputCls}
            type="number"
            inputMode="decimal"
            min="0"
            step="0.01"
            value={form.balance}
            onChange={(e) => set("balance", e.target.value)}
            placeholder="0,00"
            required
          />
        </Field>

        {form.type === "credit" && (
          <fieldset className="rounded-xl border border-loss/25 bg-loss/5 p-3">
            <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-loss">Fechas de la tarjeta</legend>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Día de corte" hint="Día del mes (1-31).">
                <input className={inputCls} type="number" min="1" max="31" step="1" value={form.cutDay || ""} onChange={(e) => set("cutDay", e.target.value)} placeholder="Ej.: 5" />
              </Field>
              <Field label="Día límite de pago" hint="Te avisaré a diario hasta pagar.">
                <input className={inputCls} type="number" min="1" max="31" step="1" value={form.payDay || ""} onChange={(e) => set("payDay", e.target.value)} placeholder="Ej.: 22" />
              </Field>
            </div>
          </fieldset>
        )}

        {isCappable && (
          <label className="flex items-center gap-2 rounded-xl bg-white/5 px-3 py-2.5 text-sm">
            <input
              type="checkbox"
              className="h-4 w-4 accent-gain"
              checked={form.capped}
              onChange={(e) => set("capped", e.target.checked)}
            />
            <span>Tasa de interés con tope <span className="text-ink-dim">(2 tramos + impuesto)</span></span>
          </label>
        )}

        {useTiers && (
          <fieldset className="space-y-3 rounded-xl border border-gain/25 bg-gain/5 p-3">
            <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-gain">Intereses con tope — tramos</legend>

            {[
              { n: 1, title: "Tasa principal", rateK: "rate1", balK: "balanceCap1", gainK: "gainCap1", freqK: "accrual1" },
              { n: 2, title: "Tasa secundaria", rateK: "rate2", balK: "balanceCap2", gainK: "gainCap2", freqK: "accrual2" },
            ].map((t) => (
              <div key={t.n} className="rounded-lg bg-white/5 p-2.5">
                <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-dim">{t.title}</p>
                <div className="grid grid-cols-2 gap-2.5">
                  <Field label="Tasa TAE (%)">
                    <input className={inputCls} type="number" inputMode="decimal" min="0" max="50" step="0.01"
                      value={(form[t.rateK] * 100).toFixed(2)}
                      onChange={(e) => set(t.rateK, (parseFloat(e.target.value) || 0) / 100)} />
                  </Field>
                  <Field label="Frecuencia abono">
                    <select className={inputCls} value={form[t.freqK]} onChange={(e) => set(t.freqK, e.target.value)}>
                      <option value="daily">Diario</option>
                      <option value="monthly">Mensual</option>
                    </select>
                  </Field>
                  <Field label="Tope de dinero" hint="Capital que genera intereses a esta tasa.">
                    <input className={inputCls} type="number" inputMode="decimal" min="0" step="0.01"
                      value={form[t.balK]} onChange={(e) => set(t.balK, e.target.value)} placeholder="0,00" />
                  </Field>
                  <Field label="Tope de ganancias" hint="Máx. acumulado de por vida (0 = sin tope).">
                    <input className={inputCls} type="number" inputMode="decimal" min="0" step="0.01"
                      value={form[t.gainK]} onChange={(e) => set(t.gainK, e.target.value)} placeholder="0,00" />
                  </Field>
                </div>
              </div>
            ))}

            <p className="text-xs text-ink-dim">
              Los tramos son <strong>acumulativos</strong>: el dinero por encima de (tope principal + tope secundario) no genera intereses.
              Cada abono genera además un <strong className="text-loss">impuesto del 0,9 % anual</strong> sobre el capital que genera intereses.
            </p>
          </fieldset>
        )}

        {hasInterest && !useTiers && (
          <fieldset className="rounded-xl border border-gain/25 bg-gain/5 p-3">
            <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-gain">Intereses automáticos</legend>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Tasa TAE (%)">
                <input
                  className={inputCls}
                  type="number"
                  inputMode="decimal"
                  min="0"
                  max="50"
                  step="0.01"
                  value={ratePct}
                  onChange={(e) => set("rate", (parseFloat(e.target.value) || 0) / 100)}
                />
              </Field>
              <Field label="Abono de intereses">
                <select className={inputCls} value={form.accrual} onChange={(e) => set("accrual", e.target.value)}>
                  <option value="none">Sin abono</option>
                  <option value="daily">Diario</option>
                  <option value="monthly">Mensual</option>
                </select>
              </Field>
            </div>
            <p className="mt-2 text-xs text-ink-dim">
              {form.rate > 0 && form.accrual !== "none"
                ? <>Las ganancias se registrarán solas en Movimientos. Estimado: <strong className="text-gain">≈ {fmtMoney(monthlyEst, form.currency)}/mes</strong>.</>
                : "Configura tasa y frecuencia para que los intereses se acumulen automáticamente."}
            </p>
          </fieldset>
        )}

        {error && <p role="alert" className="text-sm text-loss">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <Btn variant="ghost" onClick={onClose}>Cancelar</Btn>
          <Btn type="submit" onClick={save}>{isNew ? "Crear cuenta" : "Guardar cambios"}</Btn>
        </div>
      </form>
    </Modal>
  );
}

export default function Accounts() {
  const { state, dispatch } = useStore();
  const [modal, setModal] = useState(null); // "new" | account
  const base = state.settings.baseCurrency;
  const inBase = (eur) => convert(eur, "EUR", base, state.fx);

  // Subtotal por tipo de cuenta en divisa base (encabezado de cada grupo).
  const typeTotals = state.accounts.reduce((m, a) => {
    m[a.type] = (m[a.type] || 0) + a.balance * (state.fx[a.currency] ?? 1);
    return m;
  }, {});

  const remove = (a) => {
    if (confirm(`¿Eliminar la cuenta «${a.name}»? Sus movimientos se conservan en el historial.`)) {
      dispatch({ type: "delete_account", accountId: a.id });
    }
  };

  return (
    <Glass aria-label="Gestión de cuentas">
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Cuentas</h2>
          <p className="text-xs text-ink-dim">Las cuentas con tasa configurada devengan intereses solas.</p>
        </div>
        <Btn onClick={() => setModal("new")} className="!py-1.5 text-xs">+ Nueva cuenta</Btn>
      </div>

      <ul className="space-y-1">
        {groupedAccounts(state.accounts).map(({ type, label, accounts }) => (
          <li key={type}>
            <div className="mb-1 mt-3 flex items-baseline justify-between px-1 first:mt-0">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-ink-dim">{label}</p>
              <p className={`text-xs font-semibold tabular-nums ${LIABILITY_ACCOUNT_TYPES.includes(type) ? "text-loss" : "text-ink"}`}>
                {fmtMoney(inBase(typeTotals[type] ?? 0), base, { compact: true })}
              </p>
            </div>
            <ul className="space-y-1.5">
              {accounts.map((a) => {
                const earning = a.rate > 0 && a.accrual !== "none";
                const tiered = a.capped && a.currency === "MXN" && (a.type === "investment" || a.type === "sofipo");
                return (
                  <li key={a.id} className="flex flex-wrap items-center gap-3 rounded-xl bg-white/5 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium">{a.name}</p>
                      <p className="text-xs text-ink-dim">
                        {a.currency}
                        {earning && (
                          <span className="text-gain"> · ⚡ {(a.rate * 100).toFixed(2)} % TAE, abono {a.accrual === "daily" ? "diario" : "mensual"}</span>
                        )}
                        {tiered && (
                          <span className="text-gain"> · 🎯 {((a.rate1 || 0) * 100).toFixed(2)} % / {((a.rate2 || 0) * 100).toFixed(2)} % con tope{a.type === "investment" ? " · imp. 0,9 %" : ""}</span>
                        )}
                        {a.type === "credit" && (a.cutDay || a.payDay) && (
                          <span> · 📅 corte {a.cutDay || "—"}, pago {a.payDay || "—"}</span>
                        )}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-semibold tabular-nums">{fmtMoney(a.balance, a.currency)}</p>
                      {a.currency !== base && (
                        <p className="text-xs text-ink-dim tabular-nums">≈ {fmtMoney(convert(a.balance, a.currency, base, state.fx), base)}</p>
                      )}
                    </div>
                    <div className="flex gap-1.5">
                      <Btn variant="ghost" className="!px-2.5 !py-1.5 text-xs" onClick={() => setModal(a)} aria-label={`Editar cuenta ${a.name}`}>✏️ Editar</Btn>
                      <Btn variant="danger" className="!px-2.5 !py-1.5 text-xs" onClick={() => remove(a)} aria-label={`Eliminar cuenta ${a.name}`}>🗑</Btn>
                    </div>
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
        {!state.accounts.length && <li className="py-6 text-center text-sm text-ink-dim">Sin cuentas. Crea la primera.</li>}
      </ul>

      <AnimatePresence>
        {modal && <AccountModal account={modal === "new" ? null : modal} onClose={() => setModal(null)} />}
      </AnimatePresence>
    </Glass>
  );
}
