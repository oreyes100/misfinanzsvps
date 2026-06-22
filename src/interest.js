// ---------- Devengo de intereses (módulo puro, sin React) ----------
// Importado por store.jsx (app) y por scripts/recalc-intereses.mjs (command).
// Mantener libre de dependencias de React/DOM para que corra también en Node.

import { DAY_MS, daysBetween, todayISO, uid } from "./utils.js";

/** ISR México: 0.9 % ANUAL sobre el capital que genera intereses (no sobre la ganancia). */
export const INTEREST_TAX_RATE = 0.009;

/** ISR reducido para cuentas de inversión en pesos (p. ej. OBmio): 0.0524 % anual ≈ 0.000144 % diario. */
export const MXN_INVESTMENT_TAX_RATE = 0.000524;

const r2 = (x) => Math.round(x * 100) / 100;

/** Suma n días a una fecha ISO (n puede ser negativo). */
export function addDaysISO(iso, n) {
  return new Date(new Date(iso).getTime() + n * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Fecha de depósito real de los intereses. Sábado/domingo se desplazan al lunes
 * para que viernes+sábado+domingo se acumulen en una sola transacción el lunes.
 */
function depositDate(iso) {
  const dow = new Date(iso + "T12:00:00").getDay(); // 0=dom, 6=sáb
  if (dow === 6) return addDaysISO(iso, 2); // sábado → lunes
  if (dow === 0) return addDaysISO(iso, 1); // domingo → lunes
  return iso;
}

// ---------- Cuentas con tope escalonado (investment / sofipo + capped) ----------
// Modelo de 2 tramos ACUMULATIVOS:
//   - Tramo principal: el dinero hasta `balanceCap1` gana `rate1`.
//   - Tramo secundario: el dinero ENTRE balanceCap1 y (balanceCap1 + balanceCap2) gana `rate2`.
//   - Por encima de (balanceCap1 + balanceCap2) NO genera intereses.
// Topes de ganancias (`gainCap1/2`) son ACUMULADOS de por vida: al alcanzarlos, el tramo
// deja de generar intereses. Cada abono de intereses genera además una transacción de
// impuesto (0.9 % anual sobre el capital del tramo, prorrateado a su frecuencia).
function accrueCapped(acc, now) {
  const txs = [];
  let balance = acc.balance;
  const startBalance = acc.balance;
  const cap1 = acc.balanceCap1 || 0;
  const cap2 = acc.balanceCap2 || 0;
  const chargesISR = acc.type === "investment"; // SOFIPOs NO pagan ISR; solo inversión.
  // Bancos mexicanos usan año comercial: 360 días (30 días × 12 meses).
  const DAYS_PER_YEAR = 360;

  // Tasa de ISR: las inversiones en pesos usan la tasa reducida (0.0524 % anual).
  const taxRate = (chargesISR && acc.currency === "MXN") ? MXN_INVESTMENT_TAX_RATE : INTEREST_TAX_RATE;

  // Bases por tramo, calculadas sobre el saldo al inicio del devengo (deterministas).
  const base1 = cap1 > 0 ? Math.min(startBalance, cap1) : startBalance;
  const base2 = cap2 > 0 ? Math.min(Math.max(startBalance - cap1, 0), cap2) : 0;

  const tiers = [
    { n: 1, rate: acc.rate1 || 0, accrual: acc.accrual1 || "none", base: base1, gainCap: acc.gainCap1 || 0, gainAcc: acc.gainAccrued1 || 0, last: acc.lastAccrual1 || acc.lastAccrual, label: "tasa principal" },
    { n: 2, rate: acc.rate2 || 0, accrual: acc.accrual2 || "none", base: base2, gainCap: acc.gainCap2 || 0, gainAcc: acc.gainAccrued2 || 0, last: acc.lastAccrual2 || acc.lastAccrual, label: "tasa secundaria" },
  ];

  const out = {
    lastAccrual1: tiers[0].last, lastAccrual2: tiers[1].last,
    gainAccrued1: tiers[0].gainAcc, gainAccrued2: tiers[1].gainAcc,
  };

  for (const t of tiers) {
    if (!t.rate || t.accrual === "none") continue;
    const days = daysBetween(t.last, now);
    if (days <= 0) continue;
    const periodDays = t.accrual === "daily" ? 1 : 30;
    const periods = t.accrual === "daily" ? days : Math.floor(days / 30);
    if (periods <= 0) continue;

    const newLast = addDaysISO(t.last, periods * periodDays);
    const room = t.gainCap > 0 ? Math.max(0, t.gainCap - t.gainAcc) : Infinity;

    // Tramo agotado (tope de ganancias alcanzado) o sin capital → solo avanzar reloj.
    if (room <= 0 || t.base <= 0) {
      out[`lastAccrual${t.n}`] = newLast;
      continue;
    }

    const periodicRate = t.accrual === "daily" ? t.rate / DAYS_PER_YEAR : t.rate / 12;
    let gain = t.base * (Math.pow(1 + periodicRate, periods) - 1);
    if (gain > room) gain = room;
    gain = r2(gain);

    const taxDivisor = t.accrual === "daily" ? DAYS_PER_YEAR : 12;
    const tax = r2(t.base * (taxRate / taxDivisor) * periods);

    const date = depositDate(now);
    if (gain > 0.005) {
      txs.push({
        id: uid(), date,
        description: `Intereses ${acc.name} · ${t.label} (${(t.rate * 100).toFixed(2)} % TAE)`,
        amount: gain, currency: acc.currency, category: "Intereses", accountId: acc.id, auto: true,
      });
      balance = r2(balance + gain);
      out[`gainAccrued${t.n}`] = r2(t.gainAcc + gain);
    }
    // ISR (0.9 % anual) SOLO para inversión; las SOFIPOs no pagan ISR.
    if (chargesISR && tax > 0.005) {
      txs.push({
        id: uid(), date,
        description: `Impuesto intereses ${acc.name} · ${t.label} (0.0524 % anual)`,
        amount: -tax, currency: acc.currency, category: "Impuestos", accountId: acc.id, auto: true,
      });
      balance = r2(balance - tax);
    }
    out[`lastAccrual${t.n}`] = newLast;
  }

  return { account: { ...acc, balance, lastAccrual: now, ...out }, txs };
}

/** ¿La cuenta usa el modelo escalonado con tope? Solo aplica a cuentas en pesos (MXN). */
export const isCappedAccount = (a) =>
  !!a.capped && a.currency === "MXN" && (a.type === "investment" || a.type === "sofipo");

// ---------- Devengo general ----------
// Recorre cada cuenta y registra las ganancias pendientes desde el último cierre.
// Cuentas con tope → modelo escalonado; el resto → modelo simple (rate/accrual).
export function accrueInterest(state) {
  const now = todayISO();

  // Fin de semana: no devengar. Viernes→lunes se acumulan 3 días en una transacción.
  const dow = new Date(now + "T12:00:00").getDay();
  if (dow === 6 || dow === 0) return state;

  const accounts = [];
  const newTx = [];

  for (const acc of state.accounts) {
    if (isCappedAccount(acc)) {
      const { account, txs } = accrueCapped(acc, now);
      accounts.push(account);
      newTx.push(...txs);
      continue;
    }

    // --- Modelo simple (ahorro, depósito, inversión/sofipo sin tope) ---
    if (!acc.rate || acc.accrual === "none") { accounts.push(acc); continue; }
    const days = daysBetween(acc.lastAccrual, now);
    if (days <= 0) { accounts.push(acc); continue; }

    const startBalance = acc.balance;
    let balance = acc.balance;
    let gained = 0;
    let periods = 0;

    if (acc.accrual === "daily") {
      periods = days;
      const grown = balance * Math.pow(1 + acc.rate / 365, days);
      gained = grown - balance;
      balance = grown;
    } else if (acc.accrual === "monthly") {
      periods = Math.floor(days / 30);
      if (periods > 0) {
        const grown = balance * Math.pow(1 + acc.rate / 12, periods);
        gained = grown - balance;
        balance = grown;
      }
    }

    if (gained > 0.005) {
      const date = depositDate(now);
      newTx.push({
        id: uid(), date,
        description: `Intereses ${acc.name} (${(acc.rate * 100).toFixed(2)} % TAE)`,
        amount: r2(gained), currency: acc.currency, category: "Intereses", accountId: acc.id, auto: true,
      });
      let finalBalance = r2(balance);
      // ISR (0.0524 % anual) para inversión en pesos; SOFIPOs/ahorro/depósito no pagan.
      if (acc.type === "investment" && acc.currency === "MXN") {
        const taxDivisor = acc.accrual === "daily" ? 365 : 12;
        const tax = r2(startBalance * (MXN_INVESTMENT_TAX_RATE / taxDivisor) * periods);
        if (tax > 0.005) {
          newTx.push({
            id: uid(), date,
            description: `Impuesto intereses ${acc.name} (0.0524 % anual)`,
            amount: -tax, currency: acc.currency, category: "Impuestos", accountId: acc.id, auto: true,
          });
          finalBalance = r2(finalBalance - tax);
        }
      }
      accounts.push({ ...acc, balance: finalBalance, lastAccrual: now });
    } else {
      accounts.push(acc);
    }
  }

  if (!newTx.length) return state;
  return { ...state, accounts, transactions: [...newTx, ...state.transactions] };
}
