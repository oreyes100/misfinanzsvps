// ---------- Devengo de intereses (módulo puro, sin React) ----------
// Importado por store.jsx (app) y por scripts/recalc-intereses.mjs (command).
// Mantener libre de dependencias de React/DOM para que corra también en Node.

import { DAY_MS, daysBetween, todayISO, uid } from "./utils.js";

/** ISR México: 0.9 % ANUAL sobre el capital que genera intereses (no sobre la ganancia). */
export const INTEREST_TAX_RATE = 0.009;

const r2 = (x) => Math.round(x * 100) / 100;

/** Suma n días a una fecha ISO (n puede ser negativo). */
export function addDaysISO(iso, n) {
  return new Date(new Date(iso).getTime() + n * DAY_MS).toISOString().slice(0, 10);
}

/** Siguiente día hábil: lun-jue→+1, vie→+3 (lunes), sáb→+2 (lunes), dom→+1 (lunes). */
function nextBusinessDay(iso) {
  const dow = new Date(iso + "T12:00:00").getDay(); // 0=dom,5=vie,6=sáb
  const add = dow === 5 ? 3 : dow === 6 ? 2 : 1;
  return addDaysISO(iso, add);
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

    const periodicRate = t.accrual === "daily" ? t.rate / 365 : t.rate / 12;
    let gain = t.base * (Math.pow(1 + periodicRate, periods) - 1);
    if (gain > room) gain = room;
    gain = r2(gain);

    const taxDivisor = t.accrual === "daily" ? 365 : 12;
    const tax = r2(t.base * (INTEREST_TAX_RATE / taxDivisor) * periods);

    if (gain > 0.005) {
      txs.push({
        id: uid(), date: nextBusinessDay(now),
        description: `Intereses ${acc.name} · ${t.label} (${(t.rate * 100).toFixed(2)} % TAE)`,
        amount: gain, currency: acc.currency, category: "Intereses", accountId: acc.id, auto: true,
      });
      balance = r2(balance + gain);
      out[`gainAccrued${t.n}`] = r2(t.gainAcc + gain);
    }
    if (tax > 0.005) {
      txs.push({
        id: uid(), date: nextBusinessDay(now),
        description: `Impuesto intereses ${acc.name} · ${t.label} (0.90 % anual)`,
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

    let balance = acc.balance;
    let gained = 0;

    if (acc.accrual === "daily") {
      const dailyRate = acc.rate / 365;
      const grown = balance * Math.pow(1 + dailyRate, days);
      gained = grown - balance;
      balance = grown;
    } else if (acc.accrual === "monthly") {
      const months = Math.floor(days / 30);
      if (months > 0) {
        const grown = balance * Math.pow(1 + acc.rate / 12, months);
        gained = grown - balance;
        balance = grown;
      }
    }

    if (gained > 0.005) {
      newTx.push({
        id: uid(), date: nextBusinessDay(now),
        description: `Intereses ${acc.name} (${(acc.rate * 100).toFixed(2)} % TAE)`,
        amount: r2(gained), currency: acc.currency, category: "Intereses", accountId: acc.id, auto: true,
      });
      accounts.push({ ...acc, balance: r2(balance), lastAccrual: now });
    } else {
      accounts.push(acc);
    }
  }

  if (!newTx.length) return state;
  return { ...state, accounts, transactions: [...newTx, ...state.transactions] };
}
