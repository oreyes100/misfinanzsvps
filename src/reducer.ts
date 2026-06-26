// reducer.ts — Reductor puro con tipos completos
import type { AppState, Action, NetWorth, PendingCardPayment, Account, Transaction } from "./types.ts";
import { BASE_FX, DEFAULT_CATEGORIES, DAY_MS, categorize, todayISO, uid } from "./utils.ts";
import type { Currency, Category } from "./types.ts";
import { accrueInterest } from "./interest.ts";
import { migrate } from "./migrations.ts";

// ---------- Estado semilla ----------

const seedDate = (off: number): string =>
  new Date(Date.now() - off * DAY_MS).toISOString().slice(0, 10);

function seedHistory(current: number, n: number = 48, vol: number = 0.008): number[] {
  const arr = [current];
  for (let i = 1; i < n; i++) arr.unshift(arr[0] * (1 + (Math.random() - 0.5) * vol));
  return arr;
}

export const SEED: AppState = {
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
    { id: "tx-1", date: seedDate(1), description: "Dominos Pizza", amount: -18.4, currency: "EUR", category: "Comida", accountId: "acc-corriente", auto: true },
    { id: "tx-2", date: seedDate(2), description: "Mercadona", amount: -64.2, currency: "EUR", category: "Supermercado", accountId: "acc-corriente", auto: true },
    { id: "tx-3", date: seedDate(3), description: "Nómina", amount: 2100, currency: "EUR", category: "Ingresos", accountId: "acc-corriente", auto: true },
    { id: "tx-4", date: seedDate(4), description: "Netflix", amount: -12.99, currency: "EUR", category: "Suscripciones", accountId: "acc-corriente", auto: true },
    { id: "tx-5", date: seedDate(5), description: "Uber", amount: -14.3, currency: "EUR", category: "Transporte", accountId: "acc-corriente", auto: true },
    { id: "tx-6", date: seedDate(6), description: "Iberdrola", amount: -78.6, currency: "EUR", category: "Hogar", accountId: "acc-corriente", auto: true },
    { id: "tx-7", date: seedDate(8), description: "Cine", amount: -21.0, currency: "EUR", category: "Ocio", accountId: "acc-corriente", auto: true },
  ],
  scheduled: [],
  categories: DEFAULT_CATEGORIES,
  transferAliases: {},
  categoryAliases: {},
  statementPatterns: {},
  fx: { ...BASE_FX },
  priceHistory: {
    BTC: seedHistory(BASE_FX.BTC, 48, 0.012),
    ETH: seedHistory(BASE_FX.ETH, 48, 0.014),
    GOLD: seedHistory(68.4, 48, 0.005),
  },
  goldPriceEUR: 68.4,
  _syncVersion: 0,
};

// ---------- Reducer ----------

function mergeByID<T extends { id: string; _updatedAt?: number }>(local: T[], cloud: T[] | undefined, key: keyof T = "id"): T[] {
  if (!Array.isArray(cloud) || !cloud.length) return local;
  if (!Array.isArray(local)) return cloud;
  const map = new Map(local.map((x) => [x[key] as string, x]));
  let changed = false;
  for (const item of cloud) {
    const existing = map.get(item[key] as string);
    if (!existing || (item._updatedAt || 0) > (existing._updatedAt || 0)) {
      map.set(item[key] as string, item);
      changed = true;
    }
  }
  return changed ? [...map.values()] : local;
}

function innerReducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "hydrate":
      return action.state;

    case "update_fx": {
      const { fx, priceHistory } = action;
      const push = (arr: number[], v: number) => [...arr.slice(-59), v];
      const goldPriceEUR = state.goldPriceEUR;
      return {
        ...state,
        fx,
        goldPriceEUR,
        priceHistory: priceHistory ? {
          BTC: push(state.priceHistory.BTC, priceHistory.BTC ?? state.fx.BTC),
          ETH: push(state.priceHistory.ETH, priceHistory.ETH ?? state.fx.ETH),
          GOLD: "GOLD" in priceHistory ? push(state.priceHistory.GOLD, priceHistory.GOLD) : state.priceHistory.GOLD,
        } : state.priceHistory,
      };
    }

    case "add_transaction": {
      const t = action.tx;
      const cat = t.category || categorize(t.description, state.categories).category;
      const tx: Transaction = { id: uid(), date: t.date || todayISO(), _updatedAt: Date.now(), ...t, category: cat } as Transaction;
      const accounts = state.accounts.map((a) =>
        a.id === tx.accountId ? { ...a, balance: Math.round((a.balance + tx.amount) * 100) / 100 } : a
      );
      return { ...state, transactions: [tx, ...state.transactions], accounts };
    }

    case "update_transaction": {
      const old = state.transactions.find((t) => t.id === action.id);
      if (!old) return state;
      const next = { ...old, ...action.patch };
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
      if (!from || !to || amount <= 0) return state;
      const credited = from.currency === to.currency
        ? amount
        : (amount * state.fx[from.currency]) / state.fx[to.currency];
      const date = action.date || todayISO();
      const accounts = state.accounts.map((a) => {
        if (a.id === fromId) return { ...a, balance: Math.round((a.balance - amount) * 100) / 100 };
        if (a.id === toId) return { ...a, balance: Math.round((a.balance + credited) * 100) / 100 };
        return a;
      });
      const txs: Transaction[] = [
        { id: uid(), date, description: `Transferencia a ${to.name}`, amount: -amount, currency: from.currency, category: "Transferencia", accountId: fromId, counterpartId: toId },
        { id: uid(), date, description: `Transferencia desde ${from.name}`, amount: Math.round(credited * 100) / 100, currency: to.currency, category: "Transferencia", accountId: toId, counterpartId: fromId },
      ];
      return { ...state, accounts, transactions: [...txs, ...state.transactions] };
    }

    case "schedule_transfer":
      return { ...state, scheduled: [...state.scheduled, { id: uid(), _updatedAt: Date.now(), ...action.item }] };

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
      const today = todayISO();
      const account: Account = { id: uid(), lastAccrual: today, ...action.account } as Account;
      if (account.capped) {
        account.lastAccrual1 = account.lastAccrual1 || today;
        account.lastAccrual2 = account.lastAccrual2 || today;
        account.gainAccrued1 = account.gainAccrued1 || 0;
        account.gainAccrued2 = account.gainAccrued2 || 0;
      }
      return { ...state, accounts: [...state.accounts, account] };
    }

    case "update_account": {
      const today = todayISO();
      const accounts = state.accounts.map((a) => {
        if (a.id !== action.accountId) return a;
        const next = { ...a, ...action.patch };
        if (a.rate === 0 && next.rate > 0) next.lastAccrual = today;
        if (!a.capped && next.capped) {
          next.lastAccrual1 = today;
          next.lastAccrual2 = today;
          next.gainAccrued1 = a.gainAccrued1 || 0;
          next.gainAccrued2 = a.gainAccrued2 || 0;
        }
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
        transactions = transactions.map((t) => (t.category === old.name ? { ...t, category: action.patch.name! } : t));
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
      const item = { id: uid(), source: "Valoración manual", _updatedAt: Date.now(), ...action.item };
      let realEstate = [...state.assets.realEstate, item];
      if (!realEstate.some((r) => r.featured)) realEstate = realEstate.map((r, i) => ({ ...r, featured: i === realEstate.length - 1 }));
      return { ...state, assets: { ...state.assets, realEstate } };
    }

    case "update_realestate": {
      const realEstate = state.assets.realEstate.map((r) => (r.id === action.id ? { ...r, ...action.patch } : r));
      return { ...state, assets: { ...state.assets, realEstate } };
    }

    case "delete_realestate": {
      let realEstate = state.assets.realEstate.filter((r) => r.id !== action.id);
      if (realEstate.length && !realEstate.some((r) => r.featured)) {
        realEstate = realEstate.map((r, i) => ({ ...r, featured: i === 0 }));
      }
      return { ...state, assets: { ...state.assets, realEstate } };
    }

    case "set_featured_realestate": {
      const realEstate = state.assets.realEstate.map((r) =>
        r.id === action.id ? { ...r, featured: !r.featured } : r
      );
      return { ...state, assets: { ...state.assets, realEstate } };
    }

    case "add_depreciating": {
      const item = { id: uid(), kind: "auto", _updatedAt: Date.now(), depRate: 0.15, ...action.item };
      return { ...state, assets: { ...state.assets, depreciating: [...(state.assets.depreciating || []), item] } };
    }
    case "update_depreciating": {
      const depreciating = (state.assets.depreciating || []).map((d) => (d.id === action.id ? { ...d, ...action.patch } : d));
      return { ...state, assets: { ...state.assets, depreciating } };
    }
    case "delete_depreciating":
      return { ...state, assets: { ...state.assets, depreciating: (state.assets.depreciating || []).filter((d) => d.id !== action.id) } };

    case "mark_card_paid": {
      const accounts = state.accounts.map((a) =>
        a.id === action.accountId ? { ...a, lastPaidCycle: action.cycle } : a
      );
      return { ...state, accounts };
    }

    case "learn_transfer_aliases": {
      const transferAliases = { ...state.transferAliases };
      for (const [alias, accountId] of Object.entries(action.aliases || {})) {
        const key = (alias || "").toLowerCase().trim();
        if (key && accountId) transferAliases[key] = accountId;
      }
      return { ...state, transferAliases };
    }

    case "learn_category_aliases": {
      const categoryAliases = { ...state.categoryAliases };
      for (const [alias, category] of Object.entries(action.aliases || {})) {
        const key = (alias || "").toLowerCase().trim();
        if (key && category) categoryAliases[key] = category;
      }
      return { ...state, categoryAliases };
    }

    case "learn_statement_pattern": {
      const { key, pattern } = action;
      if (!key || !pattern) return state;
      const existing = state.statementPatterns[key];
      const statementPatterns = {
        ...state.statementPatterns,
        [key]: existing
          ? { ...existing, ...pattern, appliedCount: (existing.appliedCount || 0) + 1 }
          : { ...pattern, appliedCount: 1, learnedAt: new Date().toISOString() },
      };
      return { ...state, statementPatterns };
    }

    case "restore": {
      const s = action.state || {};
      return accrueInterest({
        ...state,
        _syncVersion: Math.max(state._syncVersion, s._syncVersion || 0),
        settings: { ...state.settings, ...(s.settings || {}) },
        accounts: mergeByID(state.accounts, s.accounts),
        transactions: mergeByID(state.transactions, s.transactions),
        scheduled: mergeByID(state.scheduled, s.scheduled),
        categories: mergeByID(state.categories, s.categories),
        assets: s.assets ? {
          ...state.assets, ...s.assets,
          crypto: mergeByID(state.assets.crypto, s.assets.crypto),
          realEstate: mergeByID(state.assets.realEstate, s.assets.realEstate),
          depreciating: mergeByID(state.assets.depreciating || [], s.assets.depreciating || []),
        } : state.assets,
        transferAliases: { ...state.transferAliases, ...(s.transferAliases || {}) },
        categoryAliases: { ...state.categoryAliases, ...(s.categoryAliases || {}) },
        statementPatterns: { ...state.statementPatterns, ...(s.statementPatterns || {}) },
      });
    }

    case "reset":
      return accrueInterest(SEED);

    default:
      return state;
  }
}

export function reducer(state: AppState, action: Action): AppState {
  const skipVersion: Action["type"][] = ["hydrate", "update_fx", "accrue"];
  const result = innerReducer(state, action);
  if (result !== state && !skipVersion.includes(action.type)) {
    return { ...result, _syncVersion: (result._syncVersion || 0) + 1 };
  }
  return result;
}

// ---------- Selectores ----------

export function netWorthEUR(state: AppState): NetWorth {
  const { accounts, assets, fx, goldPriceEUR } = state;
  const autoLoan = accounts
    .filter((a) => a.type === "auto_loan")
    .reduce((s, a) => s + a.balance * (fx[a.currency] ?? 1), 0);
  const cash = accounts
    .filter((a) => a.type !== "auto_loan")
    .reduce((s, a) => s + a.balance * (fx[a.currency] ?? 1), 0);
  const crypto = assets.crypto.reduce((s, c) => s + c.qty * (fx[c.symbol as Currency] ?? 0), 0);
  const gold = assets.gold.grams * goldPriceEUR;
  const re = assets.realEstate.reduce((s, r) => s + r.valueEUR, 0);
  const depreciating = (assets.depreciating || []).reduce((s, d) => s + d.valueEUR, 0);
  return { cash, crypto, gold, realEstate: re, depreciating, autoLoan, total: cash + crypto + gold + re + depreciating };
}

export function monthSpend(state: AppState): number {
  const month = todayISO().slice(0, 7);
  return state.transactions
    .filter((t) => t.date.startsWith(month) && t.amount < 0 && t.category !== "Transferencia")
    .reduce((s, t) => s + Math.abs(t.amount) * (state.fx[t.currency] ?? 1), 0);
}

export function currentCycle(payDay: number, ref: Date = new Date()): string {
  const d = new Date(ref);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function pendingCardPayments(state: AppState, ref: Date = new Date()): PendingCardPayment[] {
  const today = new Date(ref);
  const dom = today.getDate();
  return state.accounts
    .filter((a) => a.type === "credit" && a.balance < 0 && a.payDay)
    .map((a) => {
      const cycle = currentCycle(a.payDay!, today);
      const paid = a.lastPaidCycle === cycle;
      const due = dom >= a.payDay!;
      const daysToDue = a.payDay! - dom;
      return { account: a, cycle, paid, due, daysToDue, debt: Math.abs(a.balance) };
    })
    .filter((p) => !p.paid && (p.due || p.daysToDue <= 5));
}
