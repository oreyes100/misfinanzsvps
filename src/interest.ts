// interest.ts — Devengo de intereses (módulo puro, sin React)
import type { Account, AppState, Transaction, AccrualFrequency, InterestAnomaly } from "./types.ts";
import { DAY_MS, daysBetween, todayISO } from "./utils.ts";

/** Máximo interés plausible: tasa_diaria_máxima × capital × días × factor_seguridad */
export function interestSanityCap(acc: Account, days: number): number {
  const maxRate = Math.max(acc.rate || 0, acc.rate1 || 0, acc.rate2 || 0);
  if (maxRate <= 0) return Infinity;
  return acc.balance * (maxRate / 360) * days * 2;
}

const r2 = (x: number): number => Math.round(x * 100) / 100;

export function addDaysISO(iso: string, n: number): string {
  return new Date(new Date(iso).getTime() + n * DAY_MS).toISOString().slice(0, 10);
}

function getDepositDate(iso: string, acc?: Account): string {
  const dow = new Date(iso + "T12:00:00").getDay();
  const pref = (acc && acc.weekendDepositDay) || 'monday';
  if (dow === 6) return pref === 'saturday' ? iso : addDaysISO(iso, 2);
  if (dow === 0) return pref === 'saturday' ? iso : addDaysISO(iso, 1);
  return iso;
}

/**
 * Lista de fechas de pago en el intervalo (last, now] para cuentas con día
 * de depósito explícito (mensual con payoutDayOfMonth, semanal con payoutWeekday).
 * Devuelve [] si no hay fechas en el intervalo — en ese caso no se emite nada.
 */
export function payoutDatesBetween(last: string, now: string, acc: Account): string[] {
  const dates: string[] = [];
  const accrual = acc.accrual;

  if (accrual === "monthly" && acc.payoutDayOfMonth != null) {
    const d = acc.payoutDayOfMonth;
    // Iterar mes a mes desde el mes de `last` hasta el mes de `now`
    const start = new Date(last + "T12:00:00");
    const end = new Date(now + "T12:00:00");
    // Primer candidato: día de pago en el mes de start
    let y = start.getFullYear();
    let m = start.getMonth(); // 0-indexed
    while (true) {
      // Calcular el día real para este mes (d=31 o > último día del mes → último día)
      const lastDayOfMonth = new Date(y, m + 1, 0).getDate();
      const actualDay = d === 31 || d > lastDayOfMonth ? lastDayOfMonth : d;
      const candidate = new Date(y, m, actualDay, 12, 0, 0);
      if (candidate > end) break;
      const iso = candidate.toISOString().slice(0, 10);
      if (iso > last && iso <= now) dates.push(iso);
      m++;
      if (m > 11) { m = 0; y++; }
      // Safety: no más de 120 meses (10 años)
      if (dates.length > 120 || (y > end.getFullYear() + 1)) break;
    }
  } else if (accrual === "weekly" && acc.payoutWeekday != null) {
    const targetDow = acc.payoutWeekday; // 0=Dom…6=Sáb
    const start = new Date(last + "T12:00:00");
    const end = new Date(now + "T12:00:00");
    // Primer candidato: primer día después de start con el día correcto
    let cur = new Date(start.getTime() + DAY_MS); // strictly after last
    while (cur <= end) {
      if (cur.getDay() === targetDow) {
        dates.push(cur.toISOString().slice(0, 10));
      }
      cur = new Date(cur.getTime() + DAY_MS);
      if (dates.length > 520) break; // ~10 años de semanas
    }
  }

  return dates;
}

interface AccrueTier {
  n: 1 | 2;
  rate: number;
  accrual: AccrualFrequency;
  base: number;
  gainCap: number;
  gainAcc: number;
  last: string;
  label: string;
}

interface AccrueCappedResult {
  account: Account;
  txs: Transaction[];
}

function accrueCapped(acc: Account, now: string, existingIds: Set<string>): AccrueCappedResult {
  const txs: Transaction[] = [];
  let balance = acc.balance;
  const startBalance = acc.balance;
  const cap1 = acc.balanceCap1 || 0;
  const cap2 = acc.balanceCap2 || 0;
  const isrRate = acc.isrRate || 0;
  const DAYS_PER_YEAR = 360;

  const base1 = cap1 > 0 ? Math.min(startBalance, cap1) : startBalance;
  const base2 = cap2 > 0 ? Math.min(Math.max(startBalance - cap1, 0), cap2) : 0;

  const tiers: AccrueTier[] = [
    { n: 1, rate: acc.rate1 || 0, accrual: acc.accrual1 || "none", base: base1, gainCap: acc.gainCap1 || 0, gainAcc: acc.gainAccrued1 || 0, last: acc.lastAccrual1 || acc.lastAccrual, label: "tasa principal" },
    { n: 2, rate: acc.rate2 || 0, accrual: acc.accrual2 || "none", base: base2, gainCap: acc.gainCap2 || 0, gainAcc: acc.gainAccrued2 || 0, last: acc.lastAccrual2 || acc.lastAccrual, label: "tasa secundaria" },
  ];

  const out: Record<string, string | number> = {
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

    if (room <= 0 || t.base <= 0) continue;

    const periodicRate = t.accrual === "daily" ? t.rate / DAYS_PER_YEAR : t.rate / 12;
    let gain = t.base * (Math.pow(1 + periodicRate, periods) - 1);
    if (gain > room) gain = room;
    gain = r2(gain);

    const taxDivisor = t.accrual === "daily" ? DAYS_PER_YEAR : 12;
    const tax = r2(isrRate > 0 ? t.base * (isrRate / taxDivisor) * periods : 0);

    const postDate = getDepositDate(now, acc);
    // Solo emitir si el día de depósito ya llegó (evita fechas futuras cuando pref lunes y hoy sábado)
    if (postDate > now) {
      // defer: no postear todavía; last no se actualiza para que el próximo día atrape el acumulado
      out[`lastAccrual${t.n}`] = t.last; // mantener
      continue;
    }
    const nDeposits = (acc.weekendDeposits || 1) as 1 | 2 | 3;
    const isWeekendRelated = postDate !== now || [6, 0].includes(new Date(now + "T12:00:00").getDay());
    if (gain > 0.005) {
      let gainCredited = false;
      if (nDeposits > 1 && isWeekendRelated) {
        const part = r2(gain / nDeposits);
        for (let k = 1; k <= nDeposits; k++) {
          const id = `int-${acc.id}-t${t.n}-${postDate}-k${k}`;
          if (!existingIds.has(id)) {
            txs.push({
              id, date: postDate,
              description: `Intereses ${acc.name} · ${t.label} (${(t.rate * 100).toFixed(2)} % TAE) (depósito ${k}/${nDeposits})`,
              amount: part, currency: acc.currency, category: "Intereses", accountId: acc.id, auto: true,
            });
            gainCredited = true;
          }
        }
      } else {
        const id = `int-${acc.id}-t${t.n}-${postDate}-k1`;
        if (!existingIds.has(id)) {
          txs.push({
            id, date: postDate,
            description: `Intereses ${acc.name} · ${t.label} (${(t.rate * 100).toFixed(2)} % TAE)`,
            amount: gain, currency: acc.currency, category: "Intereses", accountId: acc.id, auto: true,
          });
          gainCredited = true;
        }
      }
      if (gainCredited) {
        balance = r2(balance + gain);
        out[`gainAccrued${t.n}`] = r2(t.gainAcc + gain);
      }
    }
    if (isrRate > 0 && tax > 0.005) {
      let taxCredited = false;
      if (nDeposits > 1 && isWeekendRelated) {
        const partTax = r2(tax / nDeposits);
        for (let k = 1; k <= nDeposits; k++) {
          const id = `isr-${acc.id}-t${t.n}-${postDate}-k${k}`;
          if (!existingIds.has(id)) {
            txs.push({
              id, date: postDate,
              description: `Impuesto intereses ${acc.name} · ${t.label} (${(isrRate * 100).toFixed(4)} % anual) (depósito ${k}/${nDeposits})`,
              amount: -partTax, currency: acc.currency, category: "Impuestos", accountId: acc.id, auto: true,
            });
            taxCredited = true;
          }
        }
      } else {
        const id = `isr-${acc.id}-t${t.n}-${postDate}-k1`;
        if (!existingIds.has(id)) {
          txs.push({
            id, date: postDate,
            description: `Impuesto intereses ${acc.name} · ${t.label} (${(isrRate * 100).toFixed(4)} % anual)`,
            amount: -tax, currency: acc.currency, category: "Impuestos", accountId: acc.id, auto: true,
          });
          taxCredited = true;
        }
      }
      if (taxCredited) {
        balance = r2(balance - tax);
      }
    }
    out[`lastAccrual${t.n}`] = newLast;
  }

  return { account: { ...acc, balance, lastAccrual: now, ...out, ...(txs.length > 0 ? { _updatedAt: Date.now() } : {}) } as Account, txs };
}

export const isCappedAccount = (a: Account): boolean =>
  !!a.capped && a.currency === "MXN" && (a.type === "investment" || a.type === "sofipo");

export function accrueInterest(state: AppState): AppState {
  const now = todayISO();
  const existingIds = new Set(state.transactions.map(t => t.id));

  // No skip global de fines de semana: cada cuenta decide el día de depósito vía weekendDepositDay
  // y si se pospone (si pref 'monday' en sábado, se emite el lunes).
  const accounts: Account[] = [];
  const newTx: Transaction[] = [];
  const anomalies: InterestAnomaly[] = [];

  for (const acc of state.accounts) {
    if (isCappedAccount(acc)) {
      const { account, txs } = accrueCapped(acc, now, existingIds);
      accounts.push(account);
      newTx.push(...txs);
      continue;
    }

    if (!acc.rate || acc.accrual === "none") { accounts.push(acc); continue; }
    const days = daysBetween(acc.lastAccrual, now);
    if (days <= 0) { accounts.push(acc); continue; }

    // ── Ruta con día de depósito explícito (mensual payoutDayOfMonth, semanal payoutWeekday) ──
    const hasExplicitPayout =
      (acc.accrual === "monthly" && acc.payoutDayOfMonth != null) ||
      (acc.accrual === "weekly"  && acc.payoutWeekday != null);

    if (hasExplicitPayout) {
      const payDates = payoutDatesBetween(acc.lastAccrual, now, acc);
      if (payDates.length === 0) { accounts.push(acc); continue; } // aún no llega el día

      const isrRate = acc.isrRate || 0;
      const periodicRate = acc.accrual === "weekly" ? acc.rate / 52 : acc.rate / 12;
      const periodDays   = acc.accrual === "weekly" ? 7 : 30;
      let newBalance = acc.balance;
      let lastEmitted = acc.lastAccrual;
      let anyEmitted = false;

      for (const payDate of payDates) {
        const gain = r2(acc.balance * periodicRate);
        const cap  = interestSanityCap({ ...acc, lastAccrual: lastEmitted }, periodDays);
        if (gain > cap) {
          anomalies.push({ accountId: acc.id, accountName: acc.name, date: payDate, gain, cap, days: periodDays });
          lastEmitted = payDate;
          continue;
        }
        const intId = `int-${acc.id}-t1-${payDate}-k1`;
        if (!existingIds.has(intId) && gain > 0.005) {
          newTx.push({ id: intId, date: payDate,
            description: `Intereses ${acc.name} (${(acc.rate * 100).toFixed(2)} % TAE)`,
            amount: gain, currency: acc.currency, category: "Intereses", accountId: acc.id, auto: true });
          anyEmitted = true;
          newBalance = r2(newBalance + gain);
        }
        if (isrRate > 0) {
          const tax = r2(acc.balance * (isrRate / (acc.accrual === "weekly" ? 52 : 12)));
          if (tax > 0.005) {
            const isrId = `isr-${acc.id}-t1-${payDate}-k1`;
            if (!existingIds.has(isrId)) {
              newTx.push({ id: isrId, date: payDate,
                description: `Impuesto intereses ${acc.name} (${(isrRate * 100).toFixed(4)} % anual)`,
                amount: -tax, currency: acc.currency, category: "Impuestos", accountId: acc.id, auto: true });
              anyEmitted = true;
              newBalance = r2(newBalance - tax);
            }
          }
        }
        lastEmitted = payDate;
      }

      if (anyEmitted) {
        accounts.push({ ...acc, balance: newBalance, lastAccrual: lastEmitted, _updatedAt: Date.now() });
      } else {
        accounts.push({ ...acc, lastAccrual: lastEmitted });
      }
      continue;
    }

    // ── Ruta sin día de depósito explícito (comportamiento histórico) ──
    const startBalance = acc.balance;
    let balance = acc.balance;
    let gained = 0;
    let periods = 0;

    if (acc.accrual === "daily") {
      // ⚠️ ZONA PROHIBIDA — no modificar esta rama (weekendDepositDay intacto)
      periods = days;
      const grown = balance * Math.pow(1 + acc.rate / 365, days);
      gained = grown - balance;
      balance = grown;
    } else if (acc.accrual === "weekly") {
      periods = Math.floor(days / 7);
      if (periods > 0) {
        const grown = balance * Math.pow(1 + acc.rate / 52, periods);
        gained = grown - balance;
        balance = grown;
      }
    } else if (acc.accrual === "monthly") {
      periods = Math.floor(days / 30);
      if (periods > 0) {
        const grown = balance * Math.pow(1 + acc.rate / 12, periods);
        gained = grown - balance;
        balance = grown;
      }
    }

    if (gained > 0.005) {
      const postDate = getDepositDate(now, acc);
      if (postDate > now) {
        // diferir (ej. sábado con pref lunes): no emitir, mantener last para que el lunes acumule
        accounts.push(acc);
        continue;
      }
      // Sanity guard: quarantine if gain exceeds mathematical cap (2× simple interest for the period)
      const cap = interestSanityCap(acc, days);
      if (gained > cap) {
        anomalies.push({ accountId: acc.id, accountName: acc.name, date: postDate, gain: r2(gained), cap: r2(cap), days });
        accounts.push({ ...acc, lastAccrual: now });
        continue;
      }
      const nDeposits = (acc.weekendDeposits || 1) as 1 | 2 | 3;
      const dowNow = new Date(now + "T12:00:00").getDay();
      const isWeekendRelated = (postDate !== now) || (dowNow === 6 || dowNow === 0);
      const isrRate = acc.isrRate || 0;
      const taxDivisor = acc.accrual === "daily" ? 365 : acc.accrual === "weekly" ? 52 : 12;
      const tax = r2(isrRate > 0 ? startBalance * (isrRate / taxDivisor) * periods : 0);
      let anyInterestEmitted = false;
      let anyTaxEmitted = false;
      if (nDeposits > 1 && isWeekendRelated) {
        const partGain = r2(gained / nDeposits);
        for (let k = 1; k <= nDeposits; k++) {
          const id = `int-${acc.id}-t1-${postDate}-k${k}`;
          if (!existingIds.has(id)) {
            newTx.push({
              id, date: postDate,
              description: `Intereses ${acc.name} (${(acc.rate * 100).toFixed(2)} % TAE) (depósito ${k}/${nDeposits})`,
              amount: partGain, currency: acc.currency, category: "Intereses", accountId: acc.id, auto: true,
            });
            anyInterestEmitted = true;
          }
        }
        if (isrRate > 0 && tax > 0.005) {
          const partTax = r2(tax / nDeposits);
          for (let k = 1; k <= nDeposits; k++) {
            const id = `isr-${acc.id}-t1-${postDate}-k${k}`;
            if (!existingIds.has(id)) {
              newTx.push({
                id, date: postDate,
                description: `Impuesto intereses ${acc.name} (${(isrRate * 100).toFixed(4)} % anual) (depósito ${k}/${nDeposits})`,
                amount: -partTax, currency: acc.currency, category: "Impuestos", accountId: acc.id, auto: true,
              });
              anyTaxEmitted = true;
            }
          }
        }
      } else {
        const id = `int-${acc.id}-t1-${postDate}-k1`;
        if (!existingIds.has(id)) {
          newTx.push({
            id, date: postDate,
            description: `Intereses ${acc.name} (${(acc.rate * 100).toFixed(2)} % TAE)`,
            amount: r2(gained), currency: acc.currency, category: "Intereses", accountId: acc.id, auto: true,
          });
          anyInterestEmitted = true;
        }
        if (isrRate > 0 && tax > 0.005) {
          const isrId = `isr-${acc.id}-t1-${postDate}-k1`;
          if (!existingIds.has(isrId)) {
            newTx.push({
              id: isrId, date: postDate,
              description: `Impuesto intereses ${acc.name} (${(isrRate * 100).toFixed(4)} % anual)`,
              amount: -tax, currency: acc.currency, category: "Impuestos", accountId: acc.id, auto: true,
            });
            anyTaxEmitted = true;
          }
        }
      }
      if (anyInterestEmitted || anyTaxEmitted) {
        let finalBalance = r2(balance);
        if (anyTaxEmitted && tax > 0.005) finalBalance = r2(finalBalance - tax);
        accounts.push({ ...acc, balance: finalBalance, lastAccrual: now, _updatedAt: Date.now() });
      } else {
        // IDs already existed — advance lastAccrual but keep balance
        accounts.push({ ...acc, lastAccrual: now });
      }
    } else {
      accounts.push(acc);
    }
  }

  if (!newTx.length && !anomalies.length) return state;
  const pendingInterestAnomalies = anomalies.length
    ? [...(state.pendingInterestAnomalies || []).filter(a => !anomalies.some(n => n.accountId === a.accountId && n.date === a.date)), ...anomalies]
    : (state.pendingInterestAnomalies || []);
  return {
    ...state,
    accounts,
    transactions: newTx.length ? [...newTx, ...state.transactions] : state.transactions,
    pendingInterestAnomalies,
  };
}
