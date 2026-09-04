import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { API_BASE, BASE_FX, DAY_MS, DEFAULT_CATEGORIES, categorize, cleanOrphanTransactions, stripDemoAccounts, syncableHash, todayISO, uid } from "./utils.js";
import { accrueInterest } from "./interest.js";
import { migrate } from "./migrations.js";
import useFX from "./useFX.js";
import { createPersistenceOrchestrator } from "./mcp/persistence-integration.js";
import { enqueueItem, acceptItem, dismissItem, acceptAllReviewable, dismissAll, cleanupReviewQueue, buildUnreviewedItems } from "./review.js";
import { pushPipelineEvents } from "./utils/pipelineDiagnostics.js";
import { editTransferPair, convertToTransfer, convertFromTransfer, buildTransferPair } from "./transfers.js";
import { diagnoseDivergence, shouldAutoReplace, recordResync, recordPush, pushWithRetry, getLastPush } from "./syncHealth.ts";

export { accrueInterest };

// ---------- Estado semilla ----------

const seedDate = (off) => new Date(Date.now() - off * DAY_MS).toISOString().slice(0, 10);

// Histórico sintético inicial: paseo aleatorio hacia atrás desde el precio actual,
// para que las gráficas salgan completas al abrir en lugar de construirse tick a tick.
function seedHistory(current, n = 48, vol = 0.008) {
  const arr = [current];
  for (let i = 1; i < n; i++) arr.unshift(arr[0] * (1 + (Math.random() - 0.5) * vol));
  return arr;
}

const DEFAULT_GOOGLE_PHOTOS = {
  connected: false,
  email: null,
  connectedAt: null,
  lastScanAt: null,
  lastImportCount: 0,
};

/** Metadatos de Google Photos (los TOKENS nunca viajan a la nube, viven cifrados en localStorage). */
const defaultSettings = (over = {}) => ({
  baseCurrency: "MXN",
  spendLimit: 1200,
  biometric: true,
  googlePhotos: { ...DEFAULT_GOOGLE_PHOTOS, ...(over.googlePhotos || {}) },
  ...over,
});

const SEED = {
  settings: defaultSettings(),
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
  categoryAliases: {}, // texto de ítem normalizado → category (aprendizaje OCR recibos)
  statementPatterns: {}, // texto OCR normalizado → { description, category, direction, accountId, appliedCount } (aprendizaje EDCs)
  fx: { ...BASE_FX },
  priceHistory: {
    BTC: seedHistory(BASE_FX.BTC, 48, 0.012),
    ETH: seedHistory(BASE_FX.ETH, 48, 0.014),
    GOLD: seedHistory(68.4, 48, 0.005),
  },
  goldPriceEUR: 68.4, // €/gramo
  _syncVersion: 0,
  _isDemo: true,
  _demoSeededAt: Date.now(),
  deletedAccountIds: [],
  reviewQueue: { pending: [], resolved: [], dismissed: [] },
  pipelineEvents: [],
};

// ---------- Reducer ----------
const REAL_ACTIONS = new Set([
  "add_transaction", "update_transaction", "delete_transaction", "transfer", "schedule_transfer",
  "add_account", "update_account", "delete_account", "add_category", "update_category", "delete_category",
  "add_crypto", "update_crypto", "delete_crypto", "add_realestate", "update_realestate", "delete_realestate",
  "add_depreciating", "update_depreciating", "delete_depreciating", "set_limit", "set_base_currency", "update_settings",
]);

function reducer(state, action) {
  const skipVersion = ["hydrate", "update_fx", "accrue"];
  const result = innerReducer(state, action);
  let finalResult = result;
  if (result !== state && result._isDemo && REAL_ACTIONS.has(action.type)) {
    const { _isDemo, _demoSeededAt, ...rest } = result;
    finalResult = { ...rest, _isDemo: false, _demoSeededAt: undefined };
  }
  if (finalResult !== state && !skipVersion.includes(action.type)) {
    return { ...finalResult, _syncVersion: (finalResult._syncVersion || 0) + 1 };
  }
  return finalResult;
}

function innerReducer(state, action) {
  switch (action.type) {
    case "hydrate": {
      const h = action.state || state;
      const strippedAccounts = h && Array.isArray(h.accounts) ? stripDemoAccounts(h.accounts, h.deletedAccountIds || []) : (h ? h.accounts : []);
      let cleaned = h && Array.isArray(h.accounts) && Array.isArray(h.transactions)
        ? { ...h, accounts: strippedAccounts, transactions: cleanOrphanTransactions(strippedAccounts, h.transactions) }
        : h;
      if (cleaned && cleaned.deletedTransactions && Array.isArray(cleaned.transactions)) {
        cleaned = { ...cleaned, transactions: cleaned.transactions.filter((t) => !cleaned.deletedTransactions[t.id]) };
      }
      // reviewQueue es un slice nuevo: si el estado remoto aún no lo trae, se rellena.
      if (cleaned && !cleaned.reviewQueue) cleaned = { ...cleaned, reviewQueue: SEED.reviewQueue };
      // pipelineEvents (GHOST PIPELINE): slice volátil de telemetría, siempre se rellena.
      if (cleaned && !cleaned.pipelineEvents) cleaned = { ...cleaned, pipelineEvents: [] };
      // settings.googlePhotos es nuevo: merge con defaults si el estado viejo no lo trae.
      if (cleaned && cleaned.settings) cleaned = { ...cleaned, settings: defaultSettings(cleaned.settings) };
      return cleaned;
    }

    case "update_fx": {
      const { fx, priceHistory, goldPriceEUR } = action;
      const push = (arr, v) => [...arr.slice(-59), v];
      const nextGold = typeof goldPriceEUR === "number" ? goldPriceEUR : state.goldPriceEUR;
      const goldValue = priceHistory && typeof priceHistory.GOLD === "number" ? priceHistory.GOLD : null;
      return {
        ...state,
        fx,
        goldPriceEUR: nextGold,
        priceHistory: priceHistory ? {
          BTC: push(state.priceHistory.BTC, priceHistory.BTC ?? state.fx.BTC),
          ETH: push(state.priceHistory.ETH, priceHistory.ETH ?? state.fx.ETH),
          GOLD: goldValue != null ? push(state.priceHistory.GOLD, goldValue) : state.priceHistory.GOLD,
        } : state.priceHistory,
      };
    }

    case "add_transaction": {
      const t = action.tx;
      const cat = t.category || categorize(t.description, state.categories).category;
      const tx = { id: uid(), date: t.date || todayISO(), _updatedAt: Date.now(), ...t, category: cat };
      const accounts = state.accounts.map((a) =>
        a.id === tx.accountId ? { ...a, balance: Math.round((a.balance + tx.amount) * 100) / 100 } : a
      );
      const unreviewed = buildUnreviewedItems([tx], { accounts });
      const reviewQueue = unreviewed.reduce((q, item) => enqueueItem(q, item), state.reviewQueue || SEED.reviewQueue);
      return {
        ...state,
        transactions: [tx, ...state.transactions],
        accounts,
        reviewQueue,
        pipelineEvents: unreviewed.length
          ? pushPipelineEvents(state.pipelineEvents, unreviewed.map((i) => ({
              ts: Date.now(),
              source: "sync",
              kind: "auto_capture",
              detail: `${i.preview.description}`,
            })))
          : state.pipelineEvents,
      };
    }

    case "update_transaction": {
      const old = state.transactions.find((t) => t.id === action.id);
      if (!old) return state;
      // RECEIPT VISION: si la transacción es parte de un par de transferencias,
      // la edición es ATÓMICA (se propaga al par y reajusta ambos saldos).
      if (old.counterpartId) {
        const res = editTransferPair(state, {
          originalId: old.id,
          newToAccountId: action.patch.accountId,
          newAmount: action.patch.amount,
          newDate: action.patch.date,
          newDescription: action.patch.description,
          metadata: {
            receiptId: action.patch.receiptId ?? old.receiptId,
            tags: action.patch.tags ?? old.tags,
          },
        });
        if (res) return { ...state, accounts: res.accounts, transactions: res.transactions };
      }
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

    // RECEIPT VISION RV-05: edición atómica de transferencia (cambio de destino/monto/fecha).
    case "edit_transfer": {
      const res = editTransferPair(state, {
        originalId: action.originalId,
        newToAccountId: action.newToAccountId,
        newAmount: action.newAmount,
        newDate: action.newDate,
        newDescription: action.newDescription,
        metadata: action.metadata || {},
      });
      if (!res) return state;
      return {
        ...state,
        accounts: res.accounts,
        transactions: res.transactions,
        pipelineEvents: pushPipelineEvents(state.pipelineEvents, {
          ts: Date.now(),
          source: "manual",
          kind: "transfer_edited",
          detail: `${res.out.description} → ${res.newIn.currency} ${Math.abs(res.newOut.amount)}`,
        }),
      };
    }

    // RECEIPT VISION RV-04: convertir gasto/ingreso en transferencia (par atómico).
    case "convert_to_transfer": {
      const res = convertToTransfer(state, {
        transactionId: action.transactionId,
        toAccountId: action.toAccountId,
        metadata: action.metadata || {},
      });
      if (!res) return state;
      return { ...state, accounts: res.accounts, transactions: res.transactions };
    }

    // RECEIPT VISION RV-04: convertir una PROPUESTA de revisión (aún no asentada)
    // en par de transferencias. No hay saldo que revertir (la tx nunca se creó).
    case "convert_item_to_transfer": {
      const { itemId, toAccountId, fromAccountId, amount, description, date, currency, receiptId } = action;
      const fromAcc = state.accounts.find((a) => a.id === fromAccountId);
      const toAcc = state.accounts.find((a) => a.id === toAccountId);
      if (!fromAcc || !toAcc || fromAccountId === toAccountId || !(amount > 0)) return state;
      const [out, inTx] = buildTransferPair({
        fromAccountId,
        toAccountId,
        amount,
        date: date || todayISO(),
        description: description || "Transferencia",
        fx: state.fx,
        fromCurrency: fromAcc.currency,
        toCurrency: toAcc.currency,
        metadata: { receiptId: receiptId || null },
      });
      const accounts = state.accounts.map((a) => {
        if (a.id === fromAccountId) return { ...a, balance: Math.round((a.balance - amount) * 100) / 100 };
        if (a.id === toAccountId) return { ...a, balance: Math.round((a.balance + inTx.amount) * 100) / 100 };
        return a;
      });
      const reviewQueue = state.reviewQueue || SEED.reviewQueue;
      const pendingItem = reviewQueue.pending.find((i) => i.id === itemId);
      const nextQueue = pendingItem
        ? {
            ...reviewQueue,
            pending: reviewQueue.pending.filter((i) => i.id !== itemId),
            resolved: [{ ...pendingItem, resolvedAt: Date.now() }, ...reviewQueue.resolved],
          }
        : reviewQueue;
      return {
        ...state,
        accounts,
        transactions: [out, inTx, ...state.transactions],
        reviewQueue: nextQueue,
        pipelineEvents: pushPipelineEvents(state.pipelineEvents, {
          ts: Date.now(),
          source: "manual",
          kind: "converted_transfer",
          detail: `${description || "item"} → ${fromAcc.name} → ${toAcc.name}`,
        }),
      };
    }

    // RECEIPT VISION RV-04: convertir transferencia (par) en gasto/ingreso simple.
    case "convert_from_transfer": {
      const res = convertFromTransfer(state, {
        transactionId: action.transactionId,
        newType: action.newType,
        newCategoryId: action.newCategoryId,
        keepAccountId: action.keepAccountId,
      });
      if (!res) return state;
      return { ...state, accounts: res.accounts, transactions: res.transactions };
    }

    case "delete_transaction": {
      const old = state.transactions.find((t) => t.id === action.id);
      if (!old) return state;
      const accounts = state.accounts.map((a) =>
        a.id === old.accountId ? { ...a, balance: Math.round((a.balance - old.amount) * 100) / 100 } : a
      );
      const txs = state.transactions.filter((t) => t.id !== action.id);
      const dels = { ...(state.deletedTransactions || {}), [action.id]: Date.now() };
      return { ...state, accounts, transactions: txs, deletedTransactions: dels };
    }

    case "transfer": {
      const { fromId, toId, amount, notes } = action;
      const from = state.accounts.find((a) => a.id === fromId);
      const to = state.accounts.find((a) => a.id === toId);
      if (!from || !to || amount <= 0) return state;
      // Conversión si las divisas difieren
      const credited = from.currency === to.currency
        ? amount
        : (amount * state.fx[from.currency]) / state.fx[to.currency];
      const date = action.date || todayISO();
      const n = notes ? String(notes).trim() : undefined;
      const accounts = state.accounts.map((a) => {
        if (a.id === fromId) return { ...a, balance: Math.round((a.balance - amount) * 100) / 100 };
        if (a.id === toId) return { ...a, balance: Math.round((a.balance + credited) * 100) / 100 };
        return a;
      });
      const txs = [
        { id: uid(), date, description: `Transferencia a ${to.name}`, amount: -amount, currency: from.currency, category: "Transferencia", accountId: fromId, counterpartId: toId, ...(n ? { notes: n } : {}) },
        { id: uid(), date, description: `Transferencia desde ${from.name}`, amount: Math.round(credited * 100) / 100, currency: to.currency, category: "Transferencia", accountId: toId, counterpartId: fromId, ...(n ? { notes: n } : {}) },
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
      const account = { id: uid(), lastAccrual: today, _updatedAt: Date.now(), ...action.account };
      // Cuenta con tope: arrancar relojes y contadores de cada tramo.
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
        // Si los intereses se activan ahora, el devengo arranca hoy
        // (evita acumular retroactivamente desde un lastAccrual antiguo).
        if (a.rate === 0 && next.rate > 0) next.lastAccrual = today;
        // Tope recién activado: arrancar relojes/contadores de los tramos hoy.
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

    case "delete_account": {
      const aid = action.accountId;
      const deletedAccountIds = [...new Set([...(state.deletedAccountIds || []), aid])];
      return {
        ...state,
        accounts: state.accounts.filter((a) => a.id !== aid),
        transactions: state.transactions.filter((t) => t.accountId !== aid),
        deletedAccountIds,
      };
    }

    case "add_category":
      return { ...state, categories: [...state.categories, { id: uid(), _updatedAt: Date.now(), ...action.category }] };

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
      const c = { id: uid(), _updatedAt: Date.now(), ...action.crypto };
      return { ...state, assets: { ...state.assets, crypto: [...state.assets.crypto, c] } };
    }

    case "update_crypto": {
      const crypto = state.assets.crypto.map((c) => (c.id === action.id ? { ...c, ...action.patch } : c));
      return { ...state, assets: { ...state.assets, crypto } };
    }

    case "delete_crypto": {
      const deletedAssetIds = [...new Set([...(state.deletedAssetIds || []), action.id])];
      return { ...state, assets: { ...state.assets, crypto: state.assets.crypto.filter((c) => c.id !== action.id) }, deletedAssetIds };
    }

    case "add_realestate": {
      const item = { id: uid(), source: "Valoración manual", _updatedAt: Date.now(), ...action.item };
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
      const deletedAssetIdsRE = [...new Set([...(state.deletedAssetIds || []), action.id])];
      return { ...state, assets: { ...state.assets, realEstate }, deletedAssetIds: deletedAssetIdsRE };
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
    case "delete_depreciating": {
      const deletedAssetIdsD = [...new Set([...(state.deletedAssetIds || []), action.id])];
      return { ...state, assets: { ...state.assets, depreciating: (state.assets.depreciating || []).filter((d) => d.id !== action.id) }, deletedAssetIds: deletedAssetIdsD };
    }

    // ---- Tarjetas de crédito: marcar pago hecho del ciclo actual ----
    case "mark_card_paid": {
      const accounts = state.accounts.map((a) =>
        a.id === action.accountId ? { ...a, lastPaidCycle: action.cycle, _updatedAt: Date.now() } : a
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
      function mergeByID(local, cloud, key = "id") {
        if (!Array.isArray(cloud) || !cloud.length) return local;
        if (!Array.isArray(local)) return cloud;
        const map = new Map(local.map((x) => [x[key], x]));
        let changed = false;

        // Demo accounts from SEED (base model). Once deleted locally by user, don't bring them back from cloud.
        const DEMO_ACCOUNT_IDS = ["acc-corriente", "acc-ahorro", "acc-deposito", "acc-usd"];

        for (const item of cloud) {
          const existing = map.get(item[key]);
          // Skip re-adding deleted demo accounts
          const itemId = item[key];
          if (key === "id" && DEMO_ACCOUNT_IDS.includes(itemId) && !existing) {
            continue;
          }
          if (!existing || (item._updatedAt || 0) > (existing._updatedAt || 0)) {
            map.set(item[key], item);
            changed = true;
          }
        }
        return changed ? [...map.values()] : local;
      }
      const mergedDeletedAccountIds = [...new Set([...(state.deletedAccountIds || []), ...(s.deletedAccountIds || [])])];
      let mergedAccounts = mergeByID(state.accounts, s.accounts);
      mergedAccounts = stripDemoAccounts(mergedAccounts, mergedDeletedAccountIds);
      let mergedTxs = mergeByID(state.transactions, s.transactions);
      mergedTxs = cleanOrphanTransactions(mergedAccounts, mergedTxs);
      const mergedDeleted = { ...(state.deletedTransactions || {}), ...(s.deletedTransactions || {}) };
      mergedTxs = mergedTxs.filter((t) => {
        const dts = mergedDeleted[t.id];
        return !dts || dts <= ((t._updatedAt || 0));
      });
      const mergedScheduled = mergeByID(state.scheduled, s.scheduled);
      const resolvedQueue = state.reviewQueue || SEED.reviewQueue;
      const resolvedIds = new Set([
        ...(resolvedQueue.resolved || []).map((i) => i.id),
        ...(resolvedQueue.dismissed || []).map((i) => i.id),
      ]);
      const unreviewedItems = buildUnreviewedItems(mergedTxs, { accounts: mergedAccounts, resolvedIds });
      const mergedQueue = unreviewedItems.reduce((q, item) => enqueueItem(q, item), resolvedQueue);
      return accrueInterest({
        ...state,
        _syncVersion: Math.max(state._syncVersion, s._syncVersion || 0),
        settings: defaultSettings({ ...state.settings, ...(s.settings || {}) }),
        accounts: mergedAccounts,
        transactions: mergedTxs,
        scheduled: mergedScheduled,
        deletedTransactions: mergedDeleted,
        deletedAccountIds: mergedDeletedAccountIds,
        reviewQueue: mergedQueue,
        pipelineEvents: unreviewedItems.length
          ? pushPipelineEvents(state.pipelineEvents, unreviewedItems.map((i) => ({
              ts: Date.now(),
              source: "sync",
              kind: "auto_capture",
              detail: `${i.preview.description}`,
            })))
          : state.pipelineEvents,
        categories: mergeByID(state.categories, s.categories, "id"),
        assets: (() => {
          const mergedAssets = s.assets ? { ...state.assets, ...s.assets, crypto: mergeByID(state.assets.crypto, s.assets.crypto, "id"), realEstate: mergeByID(state.assets.realEstate, s.assets.realEstate, "id"), depreciating: mergeByID(state.assets.depreciating || [], s.assets.depreciating || [], "id") } : state.assets;
          const delAsset = [...new Set([...(state.deletedAssetIds || []), ...(s.deletedAssetIds || [])])];
          if (!delAsset.length) return mergedAssets;
          return { ...mergedAssets, crypto: mergedAssets.crypto.filter((c) => !delAsset.includes(c.id)), realEstate: mergedAssets.realEstate.filter((r) => !delAsset.includes(r.id)), depreciating: (mergedAssets.depreciating || []).filter((d) => !delAsset.includes(d.id)) };
        })(),
        deletedAssetIds: [...new Set([...(state.deletedAssetIds || []), ...(s.deletedAssetIds || [])])],
        transferAliases: { ...state.transferAliases, ...(s.transferAliases || {}) },
        categoryAliases: { ...state.categoryAliases, ...(s.categoryAliases || {}) },
        statementPatterns: { ...state.statementPatterns, ...(s.statementPatterns || {}) },
      });
    }

    case "reset":
      return accrueInterest(SEED);

    case "approve_interest_anomaly": {
      const { accountId, date } = action;
      const anomaly = (state.pendingInterestAnomalies || []).find(a => a.accountId === accountId && a.date === date);
      if (!anomaly) return state;
      const acc = state.accounts.find(a => a.id === accountId);
      if (!acc) return state;
      const id = `int-${accountId}-approved-${date}`;
      const tx = {
        id, date, description: `Intereses ${acc.name} (aprobado manualmente)`,
        amount: anomaly.gain, currency: acc.currency, category: "Intereses", accountId, auto: true,
        _updatedAt: Date.now(),
      };
      const accounts = state.accounts.map(a =>
        a.id === accountId ? { ...a, balance: Math.round((a.balance + anomaly.gain) * 100) / 100, lastAccrual: date, _updatedAt: Date.now() } : a
      );
      return {
        ...state,
        accounts,
        transactions: [tx, ...state.transactions],
        pendingInterestAnomalies: (state.pendingInterestAnomalies || []).filter(a => !(a.accountId === accountId && a.date === date)),
      };
    }

    case "discard_interest_anomaly":
      return {
        ...state,
        pendingInterestAnomalies: (state.pendingInterestAnomalies || []).filter(
          a => !(a.accountId === action.accountId && a.date === action.date)
        ),
      };

    case "clean_interest_duplicates": {
      const autoInterestCats = new Set(["Intereses", "Impuestos"]);
      const keep = new Set();
      const dedupMap = new Map();
      const toDelete = {};
      for (const tx of state.transactions) {
        if (!tx.auto || !autoInterestCats.has(tx.category)) { keep.add(tx.id); continue; }
        const key = `${tx.accountId}|${tx.date}|${tx.description}|${tx.amount}`;
        const existing = dedupMap.get(key);
        if (!existing) { dedupMap.set(key, tx.id); keep.add(tx.id); }
        else { toDelete[tx.id] = Date.now(); }
      }
      if (Object.keys(toDelete).length === 0) return state;
      // NOTA: No ajustar saldos — los duplicados nunca acreditaron el balance
      // (el merge conservaba la versión vieja del saldo; solo la primera tx acreditó).
      // Restar el monto de los duplicados corrompería las cuentas.
      const mergedDeleted = { ...(state.deletedTransactions || {}), ...toDelete };
      const transactions = state.transactions.filter(t => !toDelete[t.id]);
      return { ...state, transactions, deletedTransactions: mergedDeleted };
    }

    // ---- Cola de revisión MCP (Command Center) ----
    case "review_enqueue":
      return { ...state, reviewQueue: enqueueItem(state.reviewQueue, action.item) };

    case "review_accept":
      return { ...state, reviewQueue: acceptItem(state.reviewQueue, action.itemId) };

    case "review_dismiss":
      return { ...state, reviewQueue: dismissItem(state.reviewQueue, action.itemId) };

    case "review_accept_all":
      return { ...state, reviewQueue: acceptAllReviewable(state.reviewQueue) };

    case "review_dismiss_all":
      return { ...state, reviewQueue: dismissAll(state.reviewQueue) };

    case "review_cleanup":
      return { ...state, reviewQueue: cleanupReviewQueue(state.reviewQueue) };

    // ---- Telemetría del pipeline (GHOST PIPELINE) ----
    case "mcp_record":
      return { ...state, pipelineEvents: pushPipelineEvents(state.pipelineEvents, action.event) };

    case "mcp_batch":
      return { ...state, pipelineEvents: pushPipelineEvents(state.pipelineEvents, action.events) };

    // Re-ejecuta la auto-captura sobre las transacciones actuales (reparación manual).
    case "pipeline_recheck": {
      const resolvedQueue = state.reviewQueue || SEED.reviewQueue;
      const resolvedIds = new Set([
        ...(resolvedQueue.resolved || []).map((i) => i.id),
        ...(resolvedQueue.dismissed || []).map((i) => i.id),
      ]);
      const unreviewed = buildUnreviewedItems(state.transactions, { accounts: state.accounts, resolvedIds });
      const reviewQueue = unreviewed.reduce((q, item) => enqueueItem(q, item), resolvedQueue);
      if (!unreviewed.length && reviewQueue === (state.reviewQueue || SEED.reviewQueue)) return state;
      return {
        ...state,
        reviewQueue,
        pipelineEvents: unreviewed.length
          ? pushPipelineEvents(state.pipelineEvents, unreviewed.map((i) => ({
              ts: Date.now(),
              source: "manual",
              kind: "recheck",
              detail: `${i.preview.description}`,
            })))
          : state.pipelineEvents,
      };
    }

    // Demo de onboarding: encola un item de ejemplo marcado demo (no destructivo).
    case "pipeline_demo": {
      const demoItem = {
        id: `demo-${Date.now()}`,
        source: "demo",
        classification: "needs_review",
        confidence: 0.7,
        createdAt: Date.now(),
        demo: true,
        preview: {
          description: "Demo — el pipeline funciona (pe. Dominos Pizza)",
          amount: -18.4,
          currency: "EUR",
          category: "Comida",
          categoryId: null,
          accountId: state.accounts[0]?.id ?? null,
          accountName: state.accounts[0]?.name ?? "Corriente",
          date: todayISO(),
        },
        action: null,
      };
      return {
        ...state,
        reviewQueue: enqueueItem(state.reviewQueue || SEED.reviewQueue, demoItem),
        pipelineEvents: pushPipelineEvents(state.pipelineEvents, {
          ts: Date.now(),
          source: "demo",
          kind: "onboarding",
          detail: "Demo de pipeline",
        }),
      };
    }

    default:
      return state;
  }
}

// ---------- Contexto ----------

const StoreCtx = createContext(null);
const KEY = "mis-finazas-v1";

// MCP-05: orquestador de persistencia (WAL + checkpoints + recovery + export).
// Instancia única por StoreProvider; guarda en `mis-finazas-persistence:*`.
const persistence = createPersistenceOrchestrator();

/** Normaliza el estado leído: merge con SEED, saneamiento y migraciones. */
function finalize(saved) {
  const merged = { ...SEED, ...saved, settings: defaultSettings(saved.settings || {}), fx: { ...BASE_FX, ...saved.fx } };
  merged.accounts = stripDemoAccounts(merged.accounts, merged.deletedAccountIds || []);
  merged.transactions = cleanOrphanTransactions(merged.accounts, merged.transactions);
  if (merged.deletedTransactions) {
    merged.transactions = (merged.transactions || []).filter((t) => !merged.deletedTransactions[t.id]);
  }
  const delAssets = merged.deletedAssetIds || [];
  if (delAssets.length && merged.assets) {
    merged.assets = {
      ...merged.assets,
      crypto: (merged.assets.crypto || []).filter((c) => !delAssets.includes(c.id)),
      realEstate: (merged.assets.realEstate || []).filter((r) => !delAssets.includes(r.id)),
      depreciating: (merged.assets.depreciating || []).filter((d) => !delAssets.includes(d.id)),
    };
  }
  return migrate(accrueInterest(merged));
}

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return accrueInterest(SEED);
    return finalize(JSON.parse(raw));
  } catch {
    // localStorage corrupto/ilegible → recovery desde WAL/checkpoints (MCP-05).
    const rec = persistence.recoverStateOnLoad(accrueInterest(SEED));
    console.warn("[store] estado local corrupto → recovery:", rec.status, rec.reasons);
    if (rec.status !== "reset") return finalize(rec.state);
    return accrueInterest(SEED);
  }
}

/** Parte durable para WAL/checkpoints (sin precios/FX en vivo). Conserva _syncVersion. */
function durableSnapshot(state) {
  const { priceHistory, fx, goldPriceEUR, ...rest } = state;
  return rest;
}

const SYNC_KEY = "mis-finazas-sync-id";

/** Partes del estado que viajan a la nube (precios/FX en vivo se quedan fuera). */
function syncableSlice(state) {
  const { settings, accounts, assets, transactions, scheduled, categories, transferAliases, categoryAliases, statementPatterns, reviewQueue, _syncVersion, deletedTransactions, deletedAccountIds, deletedAssetIds } = state;
  return { settings, accounts, assets, transactions, scheduled, categories, transferAliases, categoryAliases, statementPatterns, reviewQueue, _syncVersion, deletedTransactions, deletedAccountIds, deletedAssetIds };
}

export function StoreProvider({ children }) {
  const [state, dispatch] = useReducer(reducer, undefined, load);

  // Estado fresco siempre disponible en callbacks asíncronos (evita stale closure).
  const stateRef = useRef(state);
  stateRef.current = state;

  // ---- Sincronización en la nube (opcional, por código único) ----
  const [syncId, setSyncId] = useState(() => localStorage.getItem(SYNC_KEY));
  const [syncStatus, setSyncStatus] = useState(syncId ? "pulling" : "off");
  const [syncRetry, setSyncRetry] = useState(0);
  const pullingRef = useRef(false);
  const skipPushRef = useRef(false);

  const saveLocal = () => {
    try {
      const { priceHistory, fx, goldPriceEUR, ...rest } = state;
      localStorage.setItem(KEY, JSON.stringify(rest));
    } catch {}
  };
  // Bloquea CUALQUIER push hasta que el primer pull se resuelva con éxito. Sin
  // esto, abrir la app con un localStorage viejo (p. ej. la APK del día anterior)
  // podía subir datos rancios y machacar la config buena de la nube — por eso
  // "ayer guardé la tasa escalonada y hoy no estaba".
  const cloudReadyRef = useRef(!syncId);
  const syncable = useMemo(() => JSON.stringify(syncableSlice(state)), [
    state.settings, state.accounts, state.assets, state.transactions, state.scheduled, state.categories, state.transferAliases, state.categoryAliases, state.statementPatterns, state._syncVersion, state.deletedTransactions, state.deletedAccountIds, state.deletedAssetIds,
  ]);
  const syncableRef = useRef(syncable);
  syncableRef.current = syncable;

  const lastPushedRef = useRef(null);

  // W23: push→consolidar→reemplazar. El cliente envía su DELTA CRUDO a
  // /api/push SIN merge por entidad en el cliente (era la fuente de divergencia:
  // dos merges client-side independientes = dos estados distintos). El server
  // consolida de forma determinista (consolidateAndBump) y avanza _syncVersion.
  // W24 Fase 4: 3 reintentos con backoff lineal + telemetría de éxito/fallo.
  const pushNow = useCallback(async (id) => {
    setSyncStatus("pushing");
    const snapshot = syncableRef.current;
    const res = await pushWithRetry(fetch, `${API_BASE}/api/push?id=${encodeURIComponent(id)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: JSON.parse(snapshot) }),
    });
    if (res.ok) {
      lastPushedRef.current = snapshot;
      setSyncStatus("synced");
      recordPush({ success: true, syncVersion: stateRef.current._syncVersion ?? null, error: null, attempts: res.attempts });
      console.info(`[sync] ✅ push OK (intento ${res.attempts}) v${stateRef.current._syncVersion} txs=${JSON.parse(snapshot).transactions?.length ?? "?"}`);
      // W37f: ADOPTAR el estado/versión consolidado del server. El protocolo W23
      // lo manda, pero pushNow nunca lo hizo: la versión local quedaba stale →
      // el heartbeat veía mismatch → resync/hydrate → versión cambia → syncable
      // cambia → push → LOOP INFINITO (v853→v862 observado). Además el hydrate
      // de ese loop podía traer un snapshot pre-edición (el revert).
      if (res.body?.state) {
        const cur = stateRef.current;
        const volatile = { fx: cur.fx, priceHistory: cur.priceHistory, goldPriceEUR: cur.goldPriceEUR };
        skipPushRef.current = true;
        dispatch({ type: "hydrate", state: { ...migrate(res.body.state), ...volatile } });
        console.info(`[sync] ✅ push: adoptada versión del server v${res.body.state._syncVersion} (loop roto)`);
        return;
      }
      dispatch({ type: "mark_clean" });
      return;
    }
    recordPush({ success: false, syncVersion: stateRef.current._syncVersion ?? null, error: res.error, attempts: res.attempts });
    console.warn(`[sync] ❌ push FALLO tras ${res.attempts} intentos: ${res.error} — datos locales preservados (dirty)`);
    setSyncStatus("error");
    throw new Error(`sync push: ${res.error} (tras ${res.attempts} intentos)`);
  }, []);

  // W18: convergencia autoritativa. El server es la única fuente de verdad.
  // 1) GET /api/snapshot (hash canónico + estado completo).
  // 2) Si el hash difiere del local → push de cambios locales pendientes (si
  //    los hay), re-fetch del snapshot, y REEMPLAZO del estado local.
  // 3) Si el hash coincide → convergido.
  // Conserva slices volátiles locales (fx/priceHistory/goldPriceEUR).
  const resyncNow = useCallback(async (syncIdArg) => {
    const id = syncIdArg || syncId;
    if (!id) return { ok: false };
    let snap = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const url = `${API_BASE}/api/snapshot?id=${encodeURIComponent(id)}&t=${Date.now()}`;
      const r = await fetch(url, { signal: controller.signal, cache: "no-store" });
      clearTimeout(timer);
      if (!r.ok) return { ok: false, status: r.status };
      snap = await r.json();
    } catch {
      return { ok: false };
    }
    if (!snap || !snap.found) return { ok: false, missing: true };

    const localHash = await syncableHash(stateRef.current);
    const motivos = diagnoseDivergence(stateRef.current, snap);
    const isDemoReplace = shouldAutoReplace(stateRef.current, snap.state);
    if (snap.hash === localHash && !isDemoReplace) {
      console.info(`[sync] ✅ resync: convergido v${snap.syncVersion} hash=${String(snap.hash).slice(0, 12)}`);
      recordResync({ reason: "converged", fromVersion: stateRef.current._syncVersion, toVersion: snap.syncVersion, hash: snap.hash, motivos });
      return { ok: true, converged: true };
    }
    console.info(`[sync] 🔀 resync: divergencia detectada local(v${stateRef.current._syncVersion}) vs server(v${snap.syncVersion})`, { motivos, isDemoReplace });

    // W21: si es demo local y snapshot real, NO subir demo al server — reemplazo directo
    if (!isDemoReplace) {
      // Divergido con datos reales: subir cambios locales pendientes antes de reemplazar
      // W37e-fix del race: el pending NO es solo la empate de refs — el `_dirty` del
      // stateRef (render-confirmado) también cuenta. Sin esto, el resync del focus
      // RACABA la edición: el syncableRef seguía pre-edit (el ref se actualiza en el
      // render), la empate decía "sin pendientes" → el hydrate aplicaba el snapshot
      // PRE-EDICIÓN y la edición se revertía en <1.5s.
      const dirty = stateRef.current._dirty || syncableRef.current !== lastPushedRef.current;
      if (dirty) {
        // W24 Fase 3: si el push falla, ABORTAR — reemplazar aquí BORRARÍA los
        // cambios locales con un snapshot viejo del server (pérdida de datos).
        try {
          await pushNow(id);
        } catch (pushErr) {
          console.error(`[sync] 🛑 resync ABORTADO: push previo falló (${pushErr?.message}) — estado local preservado, server v${snap.syncVersion} NO aplicado`);
          recordResync({ reason: "push_failed_abort", fromVersion: stateRef.current._syncVersion, toVersion: snap.syncVersion, hash: snap.hash, motivos: [`push_failed: ${pushErr?.message}`] });
          return { ok: false, aborted: true, reason: "push_failed" };
        }
        try {
          const r2 = await fetch(`${API_BASE}/api/snapshot?id=${encodeURIComponent(id)}&t=${Date.now()}`, { cache: "no-store" });
          if (r2.ok) {
            const s2 = await r2.json();
            if (s2.found) snap = s2;
          }
        } catch { /* usar snapshot original */ }
      }
    }

    const cur = stateRef.current;
    const volatile = { fx: cur.fx, priceHistory: cur.priceHistory, goldPriceEUR: cur.goldPriceEUR };
    skipPushRef.current = true;
    dispatch({ type: "hydrate", state: { ...migrate(snap.state), ...volatile } });
    console.info(`[sync] ⬇️ resync: estado local REEMPLAZADO con server v${snap.syncVersion} (cuentas=${(snap.state.accounts || []).length}, txs=${(snap.state.transactions || []).length})`);
    recordResync({ reason: isDemoReplace ? "local_is_demo" : "hash_mismatch", fromVersion: cur._syncVersion, toVersion: snap.syncVersion, hash: snap.hash, motivos: isDemoReplace ? ["local_is_demo"] : motivos });
    return { ok: true, replaced: true, hash: snap.hash, autoRepaired: isDemoReplace };
  }, [syncId, pushNow]); // eslint-disable-line react-hooks/exhaustive-deps

  // Flush al salir/ocultar la pestaña: si hay cambios sin subir (p. ej. una
  // cuenta recién creada y el debounce de 1.5s aún no disparó), enviarlos ya
  // con keepalive para que la petición sobreviva a la recarga/cierre. Sin esto,
  // recargar justo después de crear una cuenta perdía el cambio en la nube.
  // W24 Fase 2 (fix Bug #1 del forense): lastPushedRef SOLO se marca si el push
  // realmente llegó (r.ok). Antes se marcaba sin esperar → el cliente creía
  // "ya pusheado" y el resync del día siguiente reemplazaba el estado local con
  // un snapshot viejo = PÉRDIDA DE DATOS.
  useEffect(() => {
    if (!syncId) return;
    const flush = () => {
      if (pullingRef.current) return;
      if (syncableRef.current === lastPushedRef.current) return;
      try {
        fetch(`${API_BASE}/api/push?id=${encodeURIComponent(syncId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ state: JSON.parse(syncableRef.current) }),
          keepalive: true,
        })
          .then((r) => {
            if (r.ok) {
              lastPushedRef.current = syncableRef.current;
              recordPush({ success: true, syncVersion: stateRef.current._syncVersion ?? null, error: null, attempts: 1 });
              dispatch({ type: "mark_clean" });
            } else {
              // Fallo visible en telemetría; el estado queda pendiente → el
              // próximo resyncNow reintentará el push ANTES de reemplazar (W24 Fase 3).
              recordPush({ success: false, syncVersion: stateRef.current._syncVersion ?? null, error: `HTTP ${r.status}`, attempts: 1 });
            }
          })
          .catch((e) => {
            recordPush({ success: false, syncVersion: stateRef.current._syncVersion ?? null, error: e?.message || "network error", attempts: 1 });
          });
        saveLocal();
      } catch { /* best-effort */ }
    };
    const onHide = () => { if (document.visibilityState === "hidden") flush(); };
    // W24 Fase 2: advertencia si se cierra con cambios sin pushear.
    const onBeforeUnload = (e) => {
      flush();
      if (syncableRef.current !== lastPushedRef.current) {
        e.preventDefault();
        e.returnValue = "Tienes cambios sin sincronizar. Si sales ahora, se reintentará el envío al reabrir. ¿Salir de todos modos?";
        return e.returnValue;
      }
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("beforeunload", onBeforeUnload);
    };
  }, [syncId]);

  // Al activar/conectar un código: bajar el estado de la nube (o subir el local si no existe).
    useEffect(() => {
      if (!syncId) return;
      let cancelled = false;
      cloudReadyRef.current = false; // toda (re)conexión baja antes de subir.
      pullingRef.current = true;
      (async () => {
        setSyncStatus("pulling");
        try {
          // W18: primero convergencia autoritativa vía snapshot (server = verdad).
          const res = await resyncNow(syncId);
          if (cancelled) return;
          if (res && res.ok) {
            cloudReadyRef.current = true; // pull OK → ya es seguro subir cambios.
            setSyncStatus("synced");
            return;
          }
          // Snapshot no disponible (server viejo) o sin estado → fallback legacy.
          const controller = new AbortController();
          const id = setTimeout(() => controller.abort(), 15000); // timeout más generoso
          const url = `${API_BASE}/api/sync?id=${encodeURIComponent(syncId)}&t=${Date.now()}`;
          const r = await fetch(url, {
            signal: controller.signal,
            cache: 'no-store',
          });
          clearTimeout(id);
          if (!r.ok) throw new Error(`sync pull ${r.status}`);
          const data = await r.json();
          if (cancelled) return;
          if (data.found && data.state) {
            skipPushRef.current = true;
            cloudReadyRef.current = true; // pull OK → ya es seguro subir cambios.
            dispatch({
              type: "restore",
              state: migrate(data.state),
            });
            setSyncStatus("synced");
          } else {
            // No existe estado en la nube: el local es la fuente, subirlo.
            cloudReadyRef.current = true;
            await pushNow(syncId);
          }
        } catch (err) {
          // Pull falló o timeout. Marcamos error pero habilitamos push de todos modos
          // para que los datos locales nuevos se puedan subir (el pull puede reintentarse después).
          if (!cancelled) setSyncStatus("error");
          cloudReadyRef.current = true;
          console.warn("Sync pull failed:", err);
        } finally {
          pullingRef.current = false;
        }
      })();
      return () => { cancelled = true; };
    }, [syncRetry, syncId, resyncNow]); // eslint-disable-line react-hooks/exhaustive-deps

      // Subida automática con debounce cuando cambian datos relevantes.
  useEffect(() => {
    if (!syncId || pullingRef.current || !cloudReadyRef.current) return;
    if (skipPushRef.current) { skipPushRef.current = false; return; }
    const t = setTimeout(() => {
      if (pullingRef.current || !cloudReadyRef.current) return;
      pushNow(syncId).catch(() => setSyncStatus("error"));
    }, 1500);
    return () => clearTimeout(t);
  }, [syncable, syncId, pushNow]);

  // Auto-pull: al volver a la app (visibilidad/foco/online/pageshow) fuerza pull fresco (W21 Fase 2).
  useEffect(() => {
    if (!syncId) return;
    const doPull = () => {
      if (!pullingRef.current) setSyncRetry(n => n + 1);
    };
    const onVis = () => { if (document.visibilityState === 'visible') doPull(); };
    const onFocus = () => doPull();
    const onOnline = () => doPull();
    const onPageShow = () => doPull();
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onOnline);
    window.addEventListener('pageshow', onPageShow);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('pageshow', onPageShow);
    };
  }, [syncId]);

  // Heartbeat ligero cada 60s (W21 Fase 3): GET /api/sync-version → si diverge, resync.
  useEffect(() => {
    if (!syncId) return;
    let cancelled = false;
    const check = async () => {
      if (document.visibilityState !== 'visible' || pullingRef.current) return;
      try {
        const r = await fetch(`${API_BASE}/api/sync-version?id=${encodeURIComponent(syncId)}&t=${Date.now()}`, { cache: "no-store" });
        if (!r.ok) return;
        const data = await r.json();
        if (cancelled) return;
        const localVer = stateRef.current._syncVersion || 0;
        if (data.syncVersion != null && data.syncVersion !== localVer) {
          if (!pullingRef.current) setSyncRetry((n) => n + 1);
          return;
        }
        if (data.hash) {
          const localHash = await syncableHash(stateRef.current);
          if (data.hash !== localHash && !pullingRef.current) setSyncRetry((n) => n + 1);
        }
      } catch {}
    };
    const t = setInterval(check, 60_000);
    return () => { cancelled = true; clearInterval(t); };
  }, [syncId]);

  const sync = useMemo(() => ({
    id: syncId,
    status: syncStatus,
    // W24: telemetría del último push (éxito/fallo) visible en Ajustes→Sync (chip).
    lastPush: getLastPush(),
    enable: () => {
      const id = crypto.randomUUID();
      localStorage.setItem(SYNC_KEY, id);
      setSyncId(id);
      setSyncRetry(n => n + 1);
    },
    link: (code) => {
      const id = code.trim().toLowerCase();
      if (!/^[a-z0-9-]{16,64}$/.test(id)) return false;
      localStorage.setItem(SYNC_KEY, id);
      setSyncId(id);
      setSyncRetry(n => n + 1);
      return true;
    },
    disable: () => {
      localStorage.removeItem(SYNC_KEY);
      setSyncId(null);
      setSyncStatus("off");
    },
    // Forzar subida + bajada completa: push local→nube, luego pull nube→local.
    // Garantiza convergencia bidireccional en un solo clic.
    forcePush: async () => {
      if (!syncId) return;
      cloudReadyRef.current = true;
      skipPushRef.current = false;
      lastPushedRef.current = null; // forzar incluso si parece igual
      await pushNow(syncId).catch(() => setSyncStatus("error"));
      // Pull posterior para traer cambios de otros dispositivos al estado local
      if (!pullingRef.current) setSyncRetry((n) => n + 1);
    },
    // Bajar estado cloud y REEMPLAZAR local (hydrate, no merge).
    // Usa este botón cuando Mac muestra datos viejos/duplicados que el celular ya limpió.
    // hydrate aplica tombstones pero no hace accrueInterest (evita re-introducir duplicados).
    forcePull: async () => {
      if (!syncId) return;
      setSyncStatus("pulling");
      pullingRef.current = true;
      try {
        let found = false;
        let state = null;
        const sUrl = `${API_BASE}/api/snapshot?id=${encodeURIComponent(syncId)}&t=${Date.now()}`;
        const sr = await fetch(sUrl, { cache: "no-store" });
        if (sr.ok) {
          const snap = await sr.json();
          if (snap.found) { found = true; state = snap.state; }
        }
        if (!found) {
          const url = `${API_BASE}/api/sync?id=${encodeURIComponent(syncId)}&t=${Date.now()}`;
          const r = await fetch(url, { cache: "no-store" });
          if (!r.ok) { setSyncStatus("error"); return; }
          const data = await r.json();
          if (data.found) { found = true; state = data.state; }
        }
        if (found && state) {
          const cur = stateRef.current;
          const volatile = { fx: cur.fx, priceHistory: cur.priceHistory, goldPriceEUR: cur.goldPriceEUR };
          dispatch({ type: "hydrate", state: { ...migrate(state), ...volatile } });
          dispatch({ type: "clean_interest_duplicates" });
          setSyncStatus("synced");
          // Subir estado ya limpio para que la nube también tenga esta versión
          setTimeout(() => {
            cloudReadyRef.current = true;
            lastPushedRef.current = null;
            pushNow(syncId).catch(() => {});
          }, 600);
        } else {
          setSyncStatus("synced");
        }
      } catch {
        setSyncStatus("error");
      } finally {
        pullingRef.current = false;
        cloudReadyRef.current = true;
      }
    },
    // Re-sincronizar desde el servidor (W18): dispara la convergencia autoritativa.
    resync: () => {
      if (syncId && !pullingRef.current) setSyncRetry((n) => n + 1);
    },
    retry: () => setSyncRetry(n => n + 1),
  }), [syncId, syncStatus, pushNow, resyncNow]);

  // Persistencia local más inmediata (100ms debounce + inmediato en unload)
  const stableSave = useMemo(() => {
    const { priceHistory, fx, goldPriceEUR, ...rest } = state;
    return JSON.stringify(rest);
  }, [state.settings, state.accounts, state.assets, state.transactions, state.scheduled, state.categories, state.transferAliases, state.categoryAliases, state.statementPatterns, state._syncVersion]);
  const saveTimerRef = useRef(null);
  // Ref siempre actualizado con el JSON más reciente — evita el stale closure en beforeunload.
  const stableSaveRef = useRef(stableSave);
  stableSaveRef.current = stableSave;
  useEffect(() => {
    clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(saveLocal, 100);
    return () => clearTimeout(saveTimerRef.current);
  }, [stableSave]);
  useEffect(() => {
    const handler = () => {
      try { localStorage.setItem(KEY, stableSaveRef.current); } catch {}
      persistence.flush(); // MCP-05: escribir WAL pendiente antes de cerrar.
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  // MCP-05: registrar cada mutación en el WAL + checkpointing periódico.
  // Keyed por _syncVersion (solo cambia en mutaciones reales): update_fx,
  // accrue y hydrate no incrementan la versión, así que no ensucian el WAL.
  // El ref de la última versión hace esto StrictMode-safe (la versión solo
  // avanza en el estado confirmado por el reducer, nunca en un doble-invoke).
  const lastRecordedVersionRef = useRef(state._syncVersion);
  useEffect(() => {
    const version = state._syncVersion;
    if (version === lastRecordedVersionRef.current) return;
    lastRecordedVersionRef.current = version;
    const durable = durableSnapshot(state);
    persistence.recordStateMutation(durable);
    persistence.maybeCheckpoint(durable, version);
  }, [state._syncVersion]); // eslint-disable-line react-hooks/exhaustive-deps

  // Devengo de intereses también con la app abierta (detecta el cambio de día).
  useEffect(() => {
    const t = setInterval(() => dispatch({ type: "accrue" }), 60_000);
    return () => clearInterval(t);
  }, []);

  // Cola de revisión MCP: poda historial antiguo al montar y cada hora.
  useEffect(() => {
    dispatch({ type: "review_cleanup" });
    const t = setInterval(() => dispatch({ type: "review_cleanup" }), 60 * 60 * 1000);
    return () => clearInterval(t);
  }, []);

  // Tasas de cambio reales (cada 30 min) — reemplaza la simulación tick_prices
  const fxRef = useRef(state.fx);
  fxRef.current = state.fx;
  useFX(dispatch, fxRef);

  const value = useMemo(() => ({ state, dispatch, sync }), [state, sync]);
  return <StoreCtx.Provider value={value}>{children}</StoreCtx.Provider>;
}

export function useStore() {
  const ctx = useContext(StoreCtx);
  if (!ctx) throw new Error("useStore debe usarse dentro de StoreProvider");
  return ctx;
}


