import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { BASE_FX, DAY_MS, DEFAULT_CATEGORIES, categorize, daysBetween, todayISO, uid } from "./utils.js";

// ---------- Estado semilla ----------

const seedDate = (off) => new Date(Date.now() - off * DAY_MS).toISOString().slice(0, 10);

// Histórico sintético inicial: paseo aleatorio hacia atrás desde el precio actual,
// para que las gráficas salgan completas al abrir en lugar de construirse tick a tick.
function seedHistory(current, n = 48, vol = 0.008) {
  const arr = [current];
  for (let i = 1; i < n; i++) arr.unshift(arr[0] * (1 + (Math.random() - 0.5) * vol));
  return arr;
}

const SEED = {
  settings: {
    baseCurrency: "EUR",
    spendLimit: 1200,
    biometric: true,
  },
  accounts: [
    { id: "acc-corriente", name: "Corriente", type: "checking", currency: "EUR", balance: 2480.55, rate: 0, accrual: "none", lastAccrual: todayISO() },
    { id: "acc-ahorro", name: "Ahorro", type: "savings", currency: "EUR", balance: 9300, rate: 0.031, accrual: "daily", lastAccrual: seedDate(9) },
    { id: "acc-deposito", name: "Depósito 12m", type: "deposit", currency: "EUR", balance: 6000, rate: 0.041, accrual: "monthly", lastAccrual: seedDate(34) },
    { id: "acc-usd", name: "Cuenta USD", type: "savings", currency: "USD", balance: 1800, rate: 0.045, accrual: "daily", lastAccrual: seedDate(9) },
  ],
  assets: {
    crypto: [
      { id: "btc", symbol: "BTC", name: "Bitcoin", qty: 0.082, costBasisEUR: 4350 },
      { id: "eth", symbol: "ETH", name: "Ethereum", qty: 1.4, costBasisEUR: 3980 },
    ],
    gold: { grams: 45, costBasisEUR: 2900 },
    realEstate: [
      { id: "re-1", name: "Piso — Calle Luna 12", valueEUR: 215000, costBasisEUR: 189000, source: "API valoración (Idealista/data, sim.)", featured: true },
    ],
    depreciating: [
      { id: "dep-1", name: "Auto — Mazda 3", kind: "auto", valueEUR: 14000, costBasisEUR: 18000, depRate: 0.15 },
    ],
  },
  transactions: [
    { id: uid(), date: seedDate(1), description: "Dominos Pizza", amount: -18.4, currency: "EUR", category: "Comida", accountId: "acc-corriente", auto: true },
    { id: uid(), date: seedDate(2), description: "Mercadona", amount: -64.2, currency: "EUR", category: "Supermercado", accountId: "acc-corriente", auto: true },
    { id: uid(), date: seedDate(3), description: "Nómina", amount: 2100, currency: "EUR", category: "Ingresos", accountId: "acc-corriente", auto: true },
    { id: uid(), date: seedDate(4), description: "Netflix", amount: -12.99, currency: "EUR", category: "Suscripciones", accountId: "acc-corriente", auto: true },
    { id: uid(), date: seedDate(5), description: "Uber", amount: -14.3, currency: "EUR", category: "Transporte", accountId: "acc-corriente", auto: true },
    { id: uid(), date: seedDate(6), description: "Iberdrola", amount: -78.6, currency: "EUR", category: "Hogar", accountId: "acc-corriente", auto: true },
    { id: uid(), date: seedDate(8), description: "Cine", amount: -21.0, currency: "EUR", category: "Ocio", accountId: "acc-corriente", auto: true },
  ],
  scheduled: [],
  categories: DEFAULT_CATEGORIES,
  transferAliases: {}, // texto OCR normalizado → accountId (aprendizaje)
  fx: { ...BASE_FX },
  priceHistory: {
    BTC: seedHistory(BASE_FX.BTC, 48, 0.012),
    ETH: seedHistory(BASE_FX.ETH, 48, 0.014),
    GOLD: seedHistory(68.4, 48, 0.005),
  },
  goldPriceEUR: 68.4, // €/gramo
};

// ---------- Intereses automáticos ----------
// Recorre cada cuenta con tasa configurada y registra las ganancias pendientes
// (devengo diario o mensual) desde el último cierre.

export function accrueInterest(state) {
  const now = todayISO();
  let accounts = [];
  const newTx = [];

  for (const acc of state.accounts) {
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
        id: uid(),
        date: now,
        description: `Intereses ${acc.name} (${(acc.rate * 100).toFixed(2)} % TAE)`,
        amount: Math.round(gained * 100) / 100,
        currency: acc.currency,
        category: "Intereses",
        accountId: acc.id,
        auto: true,
      });
      accounts.push({ ...acc, balance: Math.round(balance * 100) / 100, lastAccrual: now });
    } else {
      accounts.push(acc);
    }
  }

  if (!newTx.length) return state;
  return { ...state, accounts, transactions: [...newTx, ...state.transactions] };
}

// ---------- Reducer ----------

function reducer(state, action) {
  switch (action.type) {
    case "hydrate":
      return action.state;

    case "tick_prices": {
      // Simulación de mercado en tiempo real (paseo aleatorio suave).
      const jitter = (v, pct) => v * (1 + (Math.random() - 0.5) * pct);
      const fx = {
        ...state.fx,
        USD: jitter(state.fx.USD, 0.002),
        GBP: jitter(state.fx.GBP, 0.002),
        MXN: jitter(state.fx.MXN, 0.003),
        BTC: jitter(state.fx.BTC, 0.012),
        ETH: jitter(state.fx.ETH, 0.014),
      };
      const goldPriceEUR = jitter(state.goldPriceEUR, 0.004);
      const push = (arr, v) => [...arr.slice(-59), v];
      return {
        ...state,
        fx,
        goldPriceEUR,
        priceHistory: {
          BTC: push(state.priceHistory.BTC, fx.BTC),
          ETH: push(state.priceHistory.ETH, fx.ETH),
          GOLD: push(state.priceHistory.GOLD, goldPriceEUR),
        },
      };
    }

    case "add_transaction": {
      const t = action.tx;
      const cat = t.category || categorize(t.description, state.categories).category;
      const tx = { id: uid(), date: t.date || todayISO(), ...t, category: cat };
      const accounts = state.accounts.map((a) =>
        a.id === tx.accountId ? { ...a, balance: Math.round((a.balance + tx.amount) * 100) / 100 } : a
      );
      return { ...state, transactions: [tx, ...state.transactions], accounts };
    }

    case "update_transaction": {
      const old = state.transactions.find((t) => t.id === action.id);
      if (!old) return state;
      const next = { ...old, ...action.patch };
      // Reajuste de saldos: revertir el importe anterior y aplicar el nuevo
      // (cubre cambios de importe, de signo y de cuenta).
      const accounts = state.accounts.map((a) => {
        let bal = a.balance;
        if (a.id === old.accountId) bal -= old.amount;
        if (a.id === next.accountId) bal += next.amount;
        return bal === a.balance ? a : { ...a, balance: Math.round(bal * 100) / 100 };
      });
      const transactions = state.transactions
        .map((t) => (t.id === action.id ? next : t))
        .sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
      return { ...state, accounts, transactions };
    }

    case "delete_transaction": {
      const old = state.transactions.find((t) => t.id === action.id);
      if (!old) return state;
      const accounts = state.accounts.map((a) =>
        a.id === old.accountId ? { ...a, balance: Math.round((a.balance - old.amount) * 100) / 100 } : a
      );
      return { ...state, accounts, transactions: state.transactions.filter((t) => t.id !== action.id) };
    }

    case "transfer": {
      const { fromId, toId, amount } = action;
      const from = state.accounts.find((a) => a.id === fromId);
      const to = state.accounts.find((a) => a.id === toId);
      if (!from || !to || amount <= 0 || from.balance < amount) return state;
      // Conversión si las divisas difieren
      const credited = from.currency === to.currency
        ? amount
        : (amount * state.fx[from.currency]) / state.fx[to.currency];
      const date = todayISO();
      const accounts = state.accounts.map((a) => {
        if (a.id === fromId) return { ...a, balance: Math.round((a.balance - amount) * 100) / 100 };
        if (a.id === toId) return { ...a, balance: Math.round((a.balance + credited) * 100) / 100 };
        return a;
      });
      const txs = [
        { id: uid(), date, description: `Transferencia a ${to.name}`, amount: -amount, currency: from.currency, category: "Transferencia", accountId: fromId },
        { id: uid(), date, description: `Transferencia desde ${from.name}`, amount: Math.round(credited * 100) / 100, currency: to.currency, category: "Transferencia", accountId: toId },
      ];
      return { ...state, accounts, transactions: [...txs, ...state.transactions] };
    }

    case "schedule_transfer":
      return { ...state, scheduled: [...state.scheduled, { id: uid(), ...action.item }] };

    case "set_limit":
      return { ...state, settings: { ...state.settings, spendLimit: action.amount } };

    case "set_base_currency":
      return { ...state, settings: { ...state.settings, baseCurrency: action.currency } };

    case "update_settings":
      return { ...state, settings: { ...state.settings, ...action.patch } };

    case "set_rate": {
      const accounts = state.accounts.map((a) =>
        a.id === action.accountId ? { ...a, rate: action.rate, accrual: action.accrual ?? a.accrual } : a
      );
      return { ...state, accounts };
    }

    case "accrue":
      return accrueInterest(state);

    case "add_account": {
      const account = { id: uid(), lastAccrual: todayISO(), ...action.account };
      return { ...state, accounts: [...state.accounts, account] };
    }

    case "update_account": {
      const accounts = state.accounts.map((a) => {
        if (a.id !== action.accountId) return a;
        const next = { ...a, ...action.patch };
        // Si los intereses se activan ahora, el devengo arranca hoy
        // (evita acumular retroactivamente desde un lastAccrual antiguo).
        if (a.rate === 0 && next.rate > 0) next.lastAccrual = todayISO();
        return next;
      });
      return { ...state, accounts };
    }

    case "delete_account":
      return { ...state, accounts: state.accounts.filter((a) => a.id !== action.accountId) };

    case "add_category":
      return { ...state, categories: [...state.categories, { id: uid(), ...action.category }] };

    case "update_category": {
      const old = state.categories.find((c) => c.id === action.id);
      if (!old) return state;
      const categories = state.categories.map((c) => (c.id === action.id ? { ...c, ...action.patch } : c));
      let transactions = state.transactions;
      if (action.patch.name && action.patch.name !== old.name) {
        transactions = transactions.map((t) => (t.category === old.name ? { ...t, category: action.patch.name } : t));
      }
      return { ...state, categories, transactions };
    }

    case "delete_category": {
      const old = state.categories.find((c) => c.id === action.id);
      if (!old || old.system) return state;
      const transactions = state.transactions.map((t) =>
        t.category === old.name ? { ...t, category: "Otros" } : t
      );
      return { ...state, categories: state.categories.filter((c) => c.id !== action.id), transactions };
    }

    // ---- Activos: oro, cripto, inmuebles ----
    case "update_gold":
      return { ...state, assets: { ...state.assets, gold: { ...state.assets.gold, ...action.patch } } };

    case "add_crypto": {
      const c = { id: uid(), ...action.crypto };
      return { ...state, assets: { ...state.assets, crypto: [...state.assets.crypto, c] } };
    }

    case "update_crypto": {
      const crypto = state.assets.crypto.map((c) => (c.id === action.id ? { ...c, ...action.patch } : c));
      return { ...state, assets: { ...state.assets, crypto } };
    }

    case "delete_crypto":
      return { ...state, assets: { ...state.assets, crypto: state.assets.crypto.filter((c) => c.id !== action.id) } };

    case "add_realestate": {
      const item = { id: uid(), source: "Valoración manual", ...action.item };
      let realEstate = [...state.assets.realEstate, item];
      // Si es el primero, queda destacado por defecto.
      if (!realEstate.some((r) => r.featured)) realEstate = realEstate.map((r, i) => ({ ...r, featured: i === realEstate.length - 1 }));
      return { ...state, assets: { ...state.assets, realEstate } };
    }

    case "update_realestate": {
      const realEstate = state.assets.realEstate.map((r) => (r.id === action.id ? { ...r, ...action.patch } : r));
      return { ...state, assets: { ...state.assets, realEstate } };
    }

    case "delete_realestate": {
      let realEstate = state.assets.realEstate.filter((r) => r.id !== action.id);
      // Si se borró el destacado, destacar el primero restante.
      if (realEstate.length && !realEstate.some((r) => r.featured)) {
        realEstate = realEstate.map((r, i) => ({ ...r, featured: i === 0 }));
      }
      return { ...state, assets: { ...state.assets, realEstate } };
    }

    case "set_featured_realestate": {
      const realEstate = state.assets.realEstate.map((r) => ({ ...r, featured: r.id === action.id }));
      return { ...state, assets: { ...state.assets, realEstate } };
    }

    case "add_depreciating": {
      const item = { id: uid(), kind: "auto", depRate: 0.15, ...action.item };
      return { ...state, assets: { ...state.assets, depreciating: [...(state.assets.depreciating || []), item] } };
    }
    case "update_depreciating": {
      const depreciating = (state.assets.depreciating || []).map((d) => (d.id === action.id ? { ...d, ...action.patch } : d));
      return { ...state, assets: { ...state.assets, depreciating } };
    }
    case "delete_depreciating":
      return { ...state, assets: { ...state.assets, depreciating: (state.assets.depreciating || []).filter((d) => d.id !== action.id) } };

    // ---- Tarjetas de crédito: marcar pago hecho del ciclo actual ----
    case "mark_card_paid": {
      const accounts = state.accounts.map((a) =>
        a.id === action.accountId ? { ...a, lastPaidCycle: action.cycle } : a
      );
      return { ...state, accounts };
    }

    // ---- Aprendizaje de transferencias por OCR ----
    case "learn_transfer_aliases": {
      const transferAliases = { ...state.transferAliases };
      for (const [alias, accountId] of Object.entries(action.aliases || {})) {
        const key = (alias || "").toLowerCase().trim();
        if (key && accountId) transferAliases[key] = accountId;
      }
      return { ...state, transferAliases };
    }

    case "restore": {
      const s = action.state || {};
      return accrueInterest({
        ...state,
        settings: { ...state.settings, ...(s.settings || {}) },
        accounts: Array.isArray(s.accounts) ? s.accounts : state.accounts,
        assets: s.assets || state.assets,
        transactions: Array.isArray(s.transactions) ? s.transactions : state.transactions,
        scheduled: Array.isArray(s.scheduled) ? s.scheduled : state.scheduled,
        categories: Array.isArray(s.categories) && s.categories.length ? s.categories : state.categories,
        transferAliases: s.transferAliases || state.transferAliases,
      });
    }

    case "reset":
      return accrueInterest(SEED);

    default:
      return state;
  }
}

// ---------- Contexto ----------

const StoreCtx = createContext(null);
const KEY = "mis-finazas-v1";

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return accrueInterest(SEED);
    const saved = JSON.parse(raw);
    return accrueInterest({ ...SEED, ...saved, fx: { ...BASE_FX, ...saved.fx } });
  } catch {
    return accrueInterest(SEED);
  }
}

const SYNC_KEY = "mis-finazas-sync-id";

/** Partes del estado que viajan a la nube (precios/FX en vivo se quedan fuera). */
function syncableSlice(state) {
  const { settings, accounts, assets, transactions, scheduled, categories, transferAliases } = state;
  return { settings, accounts, assets, transactions, scheduled, categories, transferAliases };
}

export function StoreProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, undefined, load);

  // ---- Sincronización en la nube (opcional, por código único) ----
  const [syncId, setSyncId] = useState(() => localStorage.getItem(SYNC_KEY));
  const [syncStatus, setSyncStatus] = useState(syncId ? "pulling" : "off");
  const pullingRef = useRef(false);
  const skipPushRef = useRef(false);
  const syncable = useMemo(() => JSON.stringify(syncableSlice(state)), [
    state.settings, state.accounts, state.assets, state.transactions, state.scheduled, state.categories, state.transferAliases,
  ]);
  const syncableRef = useRef(syncable);
  syncableRef.current = syncable;

  const pushNow = useCallback(async (id) => {
    setSyncStatus("pushing");
    const r = await fetch(`/api/sync?id=${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: `{"state":${syncableRef.current}}`,
    });
    if (!r.ok) throw new Error(`sync push ${r.status}`);
    setSyncStatus("synced");
  }, []);

  // Al activar/conectar un código: bajar el estado de la nube (o subir el local si no existe).
  useEffect(() => {
    if (!syncId) return;
    let cancelled = false;
    pullingRef.current = true;
    (async () => {
      setSyncStatus("pulling");
      try {
        const r = await fetch(`/api/sync?id=${encodeURIComponent(syncId)}`);
        if (!r.ok) throw new Error(`sync pull ${r.status}`);
        const data = await r.json();
        if (cancelled) return;
        if (data.found && data.state) {
          skipPushRef.current = true;
          dispatch({
            type: "hydrate",
            state: accrueInterest({ ...SEED, ...data.state, fx: { ...BASE_FX, ...state.fx }, priceHistory: state.priceHistory }),
          });
          setSyncStatus("synced");
        } else {
          await pushNow(syncId);
        }
      } catch {
        if (!cancelled) setSyncStatus("error");
      } finally {
        pullingRef.current = false;
      }
    })();
    return () => { cancelled = true; };
  }, [syncId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Subida automática con debounce cuando cambian datos relevantes.
  useEffect(() => {
    if (!syncId || pullingRef.current) return;
    if (skipPushRef.current) { skipPushRef.current = false; return; }
    const t = setTimeout(() => {
      if (pullingRef.current) return;
      pushNow(syncId).catch(() => setSyncStatus("error"));
    }, 1500);
    return () => clearTimeout(t);
  }, [syncable, syncId, pushNow]);

  const sync = useMemo(() => ({
    id: syncId,
    status: syncStatus,
    enable: () => {
      const id = crypto.randomUUID();
      localStorage.setItem(SYNC_KEY, id);
      setSyncId(id);
    },
    link: (code) => {
      const id = code.trim().toLowerCase();
      if (!/^[a-z0-9-]{16,64}$/.test(id)) return false;
      localStorage.setItem(SYNC_KEY, id);
      setSyncId(id);
      return true;
    },
    disable: () => {
      localStorage.removeItem(SYNC_KEY);
      setSyncId(null);
      setSyncStatus("off");
    },
  }), [syncId, syncStatus]);

  // Persistencia local
  useEffect(() => {
    const { priceHistory, ...rest } = state;
    localStorage.setItem(KEY, JSON.stringify(rest));
  }, [state]);

  // Mercado "en tiempo real"
  useEffect(() => {
    const t = setInterval(() => dispatch({ type: "tick_prices" }), 4000);
    return () => clearInterval(t);
  }, []);

  // Devengo de intereses también con la app abierta (detecta el cambio de día).
  useEffect(() => {
    const t = setInterval(() => dispatch({ type: "accrue" }), 60_000);
    return () => clearInterval(t);
  }, []);

  const value = useMemo(() => ({ state, dispatch, sync }), [state, sync]);
  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreCtx);
  if (!ctx) throw new Error("useStore debe usarse dentro de StoreProvider");
  return ctx;
}

// ---------- Selectores ----------

export function netWorthEUR(state) {
  const { accounts, assets, fx, goldPriceEUR } = state;
  // Préstamo de auto: deuda que NO resta del patrimonio neto total; se reporta aparte.
  const autoLoan = accounts
    .filter((a) => a.type === "auto_loan")
    .reduce((s, a) => s + a.balance * (fx[a.currency] ?? 1), 0); // negativo (deuda)
  const cash = accounts
    .filter((a) => a.type !== "auto_loan")
    .reduce((s, a) => s + a.balance * (fx[a.currency] ?? 1), 0);
  const crypto = assets.crypto.reduce((s, c) => s + c.qty * (fx[c.symbol] ?? 0), 0);
  const gold = assets.gold.grams * goldPriceEUR;
  const re = assets.realEstate.reduce((s, r) => s + r.valueEUR, 0);
  const depreciating = (assets.depreciating || []).reduce((s, d) => s + d.valueEUR, 0);
  return { cash, crypto, gold, realEstate: re, depreciating, autoLoan, total: cash + crypto + gold + re + depreciating };
}

export function monthSpend(state) {
  const month = todayISO().slice(0, 7);
  return state.transactions
    .filter((t) => t.date.startsWith(month) && t.amount < 0 && t.category !== "Transferencia")
    .reduce((s, t) => s + Math.abs(t.amount) * (state.fx[t.currency] ?? 1), 0);
}

// ---------- Tarjetas de crédito: ciclo y pago pendiente ----------

/** Identificador del ciclo de pago actual (AAAA-MM del mes de la fecha de pago). */
export function currentCycle(payDay, ref = new Date()) {
  const d = new Date(ref);
  // Si aún no llega el día de pago de este mes, el ciclo "vigente" es el de este mes.
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** Devuelve cuentas de crédito con pago pendiente (vencido y no marcado pagado). */
export function pendingCardPayments(state, ref = new Date()) {
  const today = new Date(ref);
  const dom = today.getDate();
  return state.accounts
    .filter((a) => a.type === "credit" && a.balance < 0 && a.payDay)
    .map((a) => {
      const cycle = currentCycle(a.payDay, today);
      const paid = a.lastPaidCycle === cycle;
      const due = dom >= a.payDay; // ya pasó (o es) el día límite este mes
      const daysToDue = a.payDay - dom;
      return { account: a, cycle, paid, due, daysToDue, debt: Math.abs(a.balance) };
    })
    .filter((p) => !p.paid && (p.due || p.daysToDue <= 5));
}
