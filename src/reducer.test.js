import { describe, it, expect, beforeEach } from "vitest";
import { reducer, SEED, netWorthEUR, monthSpend, currentCycle, pendingCardPayments } from "./reducer";
import { todayISO } from "./utils";

// Estado base sin transacciones ni accrue para tests predecibles
function cleanState(overrides = {}) {
  return {
    ...structuredClone(SEED),
    transactions: [],
    accounts: [
      { id: "acc-eur", name: "Corriente", type: "checking", currency: "EUR", balance: 1000, rate: 0, accrual: "none", lastAccrual: "2026-06-25" },
      { id: "acc-usd", name: "USD", type: "savings", currency: "USD", balance: 500, rate: 0, accrual: "none", lastAccrual: "2026-06-25" },
      { id: "acc-ahorro", name: "Ahorro", type: "savings", currency: "EUR", balance: 5000, rate: 0.03, accrual: "daily", lastAccrual: "2026-06-24" },
    ],
    fx: { EUR: 1, USD: 0.92, GBP: 1.17, MXN: 0.05, BTC: 61500, ETH: 3120 },
    goldPriceEUR: 68.4,
    priceHistory: { BTC: [61500], ETH: [3120], GOLD: [68.4] },
    ...overrides,
  };
}

// ---------- Transacciones ----------

describe("reducer · add_transaction", () => {
  let state;
  beforeEach(() => { state = cleanState(); });

  it("agrega transacción y actualiza saldo", () => {
    const next = reducer(state, {
      type: "add_transaction",
      tx: { description: "Café", amount: -2.5, currency: "EUR", accountId: "acc-eur" },
    });
    const acc = next.accounts.find((a) => a.id === "acc-eur");
    expect(acc.balance).toBe(997.5);
    expect(next.transactions).toHaveLength(1);
    expect(next.transactions[0].description).toBe("Café");
  });

  it("auto-categoriza si no se prove categoría", () => {
    const next = reducer(state, {
      type: "add_transaction",
      tx: { description: "Netflix", amount: -12.99, currency: "EUR", accountId: "acc-eur" },
    });
    expect(next.transactions[0].category).toBe("Suscripciones");
  });

  it("respeta categoría explícita", () => {
    const next = reducer(state, {
      type: "add_transaction",
      tx: { description: "algo", amount: -10, currency: "EUR", accountId: "acc-eur", category: "Ocio" },
    });
    expect(next.transactions[0].category).toBe("Ocio");
  });

  it("incrementa _syncVersion", () => {
    const next = reducer(state, {
      type: "add_transaction",
      tx: { description: "x", amount: -1, currency: "EUR", accountId: "acc-eur" },
    });
    expect(next._syncVersion).toBe(state._syncVersion + 1);
  });
});

describe("reducer · update_transaction", () => {
  let state;
  beforeEach(() => {
    state = reducer(cleanState(), {
      type: "add_transaction",
      tx: { id: "tx-1", description: "Compra", amount: -50, currency: "EUR", accountId: "acc-eur", category: "Compras", date: "2026-06-25" },
    });
  });

  it("actualiza importe y reajusta saldo", () => {
    const next = reducer(state, {
      type: "update_transaction",
      id: "tx-1",
      patch: { amount: -80 },
    });
    const acc = next.accounts.find((a) => a.id === "acc-eur");
    // 950 (after add -50) + 50 (revert) - 80 (nuevo) = 920
    expect(acc.balance).toBe(920);
  });

  it("cambia cuenta y reajusta ambos saldos", () => {
    const next = reducer(state, {
      type: "update_transaction",
      id: "tx-1",
      patch: { accountId: "acc-usd" },
    });
    const eur = next.accounts.find((a) => a.id === "acc-eur");
    const usd = next.accounts.find((a) => a.id === "acc-usd");
    expect(eur.balance).toBe(1000); // revertido
    expect(usd.balance).toBe(450);  // 500 - 50
  });

  it("no hace nada si la tx no existe", () => {
    const next = reducer(state, { type: "update_transaction", id: "nope", patch: { amount: 0 } });
    expect(next).toBe(state);
  });
});

describe("reducer · delete_transaction", () => {
  it("elimina tx y revierte saldo", () => {
    let state = cleanState();
    state = reducer(state, {
      type: "add_transaction",
      tx: { id: "tx-del", description: "Borrar", amount: -30, currency: "EUR", accountId: "acc-eur", category: "Otros", date: "2026-06-25" },
    });
    state = reducer(state, { type: "delete_transaction", id: "tx-del" });
    const acc = state.accounts.find((a) => a.id === "acc-eur");
    expect(acc.balance).toBe(1000);
    expect(state.transactions).toHaveLength(0);
  });

  it("no hace nada si la tx no existe", () => {
    const state = cleanState();
    const next = reducer(state, { type: "delete_transaction", id: "nope" });
    expect(next).toBe(state);
  });
});

// ---------- Transferencias ----------

describe("reducer · transfer", () => {
  let state;
  beforeEach(() => { state = cleanState(); });

  it("transfiere entre cuentas misma divisa", () => {
    const next = reducer(state, {
      type: "transfer",
      fromId: "acc-eur",
      toId: "acc-ahorro",
      amount: 200,
      notes: "pago mensual",
    });
    const from = next.accounts.find((a) => a.id === "acc-eur");
    const to = next.accounts.find((a) => a.id === "acc-ahorro");
    expect(from.balance).toBe(800);
    expect(to.balance).toBe(5200);
    // 2 transacciones (origen + destino)
    const txs = next.transactions.filter((t) => t.category === "Transferencia");
    expect(txs).toHaveLength(2);
    expect(txs[0].notes).toBe("pago mensual");
    expect(txs[1].notes).toBe("pago mensual");
  });

  it("convierte divisas en transferencia cruzada", () => {
    const next = reducer(state, {
      type: "transfer",
      fromId: "acc-usd",
      toId: "acc-eur",
      amount: 100,
    });
    const from = next.accounts.find((a) => a.id === "acc-usd");
    const to = next.accounts.find((a) => a.id === "acc-eur");
    expect(from.balance).toBe(400); // 500 - 100
    // 100 USD * 0.92 (USD→EUR) / 1 (EUR) = 92 EUR
    expect(to.balance).toBe(1092);
  });

  it("no transfiere con amount ≤ 0", () => {
    const next = reducer(state, { type: "transfer", fromId: "acc-eur", toId: "acc-usd", amount: 0 });
    expect(next).toBe(state);
  });

  it("no transfiere si falta una cuenta", () => {
    const next = reducer(state, { type: "transfer", fromId: "nope", toId: "acc-usd", amount: 100 });
    expect(next).toBe(state);
  });
});

// ---------- Cuentas ----------

describe("reducer · add/update/delete_account", () => {
  let state;
  beforeEach(() => { state = cleanState(); });

  it("agrega cuenta nueva", () => {
    const next = reducer(state, {
      type: "add_account",
      account: { name: "Nueva", type: "savings", currency: "EUR", balance: 0, rate: 0, accrual: "none" },
    });
    expect(next.accounts).toHaveLength(4);
    expect(next.accounts[3].name).toBe("Nueva");
  });

  it("cuenta capped inicializa campos de tramos", () => {
    const next = reducer(state, {
      type: "add_account",
      account: { name: "Sofipo", type: "investment", currency: "MXN", balance: 10000, rate: 0.13, accrual: "daily", capped: true, balanceCap1: 5000, rate1: 0.13, balanceCap2: 5000, rate2: 0.07 },
    });
    const acc = next.accounts.find((a) => a.name === "Sofipo");
    expect(acc.lastAccrual1).toBeDefined();
    expect(acc.lastAccrual2).toBeDefined();
    expect(acc.gainAccrued1).toBe(0);
    expect(acc.gainAccrued2).toBe(0);
  });

  it("actualiza cuenta existente", () => {
    const next = reducer(state, {
      type: "update_account",
      accountId: "acc-eur",
      patch: { balance: 2000 },
    });
    expect(next.accounts.find((a) => a.id === "acc-eur").balance).toBe(2000);
  });

  it("resetea lastAccrual al activar tasa desde 0", () => {
    const next = reducer(state, {
      type: "update_account",
      accountId: "acc-eur",
      patch: { rate: 0.05, accrual: "daily" },
    });
    const acc = next.accounts.find((a) => a.id === "acc-eur");
    expect(acc.rate).toBe(0.05);
    // lastAccrual debe ser hoy (no el valor original)
    expect(acc.lastAccrual).toBe(todayISO());
  });

  it("elimina cuenta", () => {
    const next = reducer(state, { type: "delete_account", accountId: "acc-usd" });
    expect(next.accounts).toHaveLength(2);
    expect(next.accounts.find((a) => a.id === "acc-usd")).toBeUndefined();
  });

  it("elimina cuenta real (no demo) y agrega tombstone", () => {
    const withReal = reducer(state, {
      type: "add_account",
      account: { id: "real-inv", name: "DIDIINV1", type: "investment", currency: "MXN", balance: 5000, rate: 0, accrual: "none" },
    });
    const next = reducer(withReal, { type: "delete_account", accountId: "real-inv" });
    expect(next.accounts.find((a) => a.id === "real-inv")).toBeUndefined();
    expect(next.deletedAccountIds).toContain("real-inv");
  });

  it("no re-agrega cuenta real borrada en restore desde nube", () => {
    const withReal = reducer(state, {
      type: "add_account",
      account: { id: "real-inv", name: "DIDIINV1", type: "investment", currency: "MXN", balance: 5000, rate: 0, accrual: "none" },
    });
    const deleted = reducer(withReal, { type: "delete_account", accountId: "real-inv" });
    expect(deleted.deletedAccountIds).toContain("real-inv");
    const cloudWithReal = { ...withReal, _syncVersion: 99 };
    const restored = reducer(deleted, { type: "restore", state: cloudWithReal });
    expect(restored.accounts.find((a) => a.id === "real-inv")).toBeUndefined();
  });

  it("no re-agrega cuentas demo borradas en restore desde nube", () => {
    // Borramos una demo
    let next = reducer(state, { type: "delete_account", accountId: "acc-ahorro" });
    expect(next.accounts.find((a) => a.id === "acc-ahorro")).toBeUndefined();

    // Simulamos pull de nube que trae la cuenta demo
    const cloudWithDemo = {
      ...state,
      accounts: [...state.accounts, { id: "acc-ahorro", name: "Ahorro", type: "savings", currency: "EUR", balance: 9300, rate: 0.031, accrual: "daily", lastAccrual: "2026-06-25" }],
      _syncVersion: 99,
    };
    next = reducer(next, { type: "restore", state: cloudWithDemo });
    expect(next.accounts.find((a) => a.id === "acc-ahorro")).toBeUndefined();
    // otras cuentas siguen
    expect(next.accounts.length).toBeGreaterThan(0);
  });
});

// ---------- Categorías ----------

describe("reducer · categorías", () => {
  let state;
  beforeEach(() => { state = cleanState(); });

  it("agrega categoría", () => {
    const next = reducer(state, {
      type: "add_category",
      category: { name: "Mascotas", type: "expense", color: "#ff0", keywords: ["vet", "comida perro"] },
    });
    expect(next.categories.some((c) => c.name === "Mascotas")).toBe(true);
  });

  it("actualiza categoría y renombra transacciones", () => {
    let s = reducer(state, {
      type: "add_category",
      category: { name: "Mascotas", type: "expense", color: "#f00", keywords: [] },
    });
    const cat = s.categories.find((c) => c.name === "Mascotas");
    s = reducer(s, {
      type: "add_transaction",
      tx: { description: "algo", amount: -5, currency: "EUR", accountId: "acc-eur", category: "Mascotas", date: "2026-06-25" },
    });
    const next = reducer(s, { type: "update_category", id: cat.id, patch: { name: "Pets" } });
    expect(next.categories.find((c) => c.id === cat.id).name).toBe("Pets");
    expect(next.transactions.find((t) => t.description === "algo").category).toBe("Pets");
  });

  it("no elimina categorías de sistema", () => {
    const sysCat = state.categories.find((c) => c.system);
    const next = reducer(state, { type: "delete_category", id: sysCat.id });
    expect(next).toBe(state);
  });

  it("elimina categoría y reasigna a Otros", () => {
    const s = reducer(state, {
      type: "add_category",
      category: { name: "Temporal", type: "expense", color: "#f00", keywords: [] },
    });
    const cat = s.categories.find((c) => c.name === "Temporal");
    const s2 = reducer(s, {
      type: "add_transaction",
      tx: { description: "x", amount: -1, currency: "EUR", accountId: "acc-eur", category: "Temporal", date: "2026-06-25" },
    });
    const next = reducer(s2, { type: "delete_category", id: cat.id });
    expect(next.categories.find((c) => c.name === "Temporal")).toBeUndefined();
    expect(next.transactions.find((t) => t.description === "x").category).toBe("Otros");
  });
});

// ---------- Activos ----------

describe("reducer · activos", () => {
  let state;
  beforeEach(() => { state = cleanState(); });

  it("actualiza oro", () => {
    const next = reducer(state, { type: "update_gold", patch: { grams: 60 } });
    expect(next.assets.gold.grams).toBe(60);
  });

  it("agrega cripto", () => {
    const next = reducer(state, {
      type: "add_crypto",
      crypto: { symbol: "SOL", name: "Solana", qty: 10, costBasisEUR: 500 },
    });
    expect(next.assets.crypto.some((c) => c.symbol === "SOL")).toBe(true);
  });

  it("actualiza cripto", () => {
    const next = reducer(state, { type: "update_crypto", id: "btc", patch: { qty: 0.1 } });
    expect(next.assets.crypto.find((c) => c.id === "btc").qty).toBe(0.1);
  });

  it("elimina cripto", () => {
    const next = reducer(state, { type: "delete_crypto", id: "btc" });
    expect(next.assets.crypto.find((c) => c.id === "btc")).toBeUndefined();
  });

  it("agrega inmueble y auto-destaca si es el primero destacable", () => {
    const stateNoRE = cleanState({ assets: { ...cleanState().assets, realEstate: [] } });
    const next = reducer(stateNoRE, {
      type: "add_realestate",
      item: { name: "Casa", valueEUR: 300000, costBasisEUR: 250000 },
    });
    expect(next.assets.realEstate).toHaveLength(1);
    expect(next.assets.realEstate[0].featured).toBe(true);
  });

  it("al eliminar el inmueble destacado, destaca el primero restante", () => {
    const s1 = reducer(cleanState(), {
      type: "add_realestate",
      item: { name: "Casa2", valueEUR: 100000, costBasisEUR: 80000 },
    });
    // marcar el original como no destacado y el nuevo como destacado
    const s2 = reducer(s1, { type: "set_featured_realestate", id: "re-1" }); // toggle off
    const s3 = reducer(s2, { type: "set_featured_realestate", id: s2.assets.realEstate[1].id }); // toggle on
    // ahora borrar el destacado
    const next = reducer(s3, { type: "delete_realestate", id: s3.assets.realEstate[1].id });
    expect(next.assets.realEstate).toHaveLength(1);
    expect(next.assets.realEstate[0].featured).toBe(true);
  });

  it("agrega activo depreciable", () => {
    const next = reducer(state, {
      type: "add_depreciating",
      item: { name: "Moto", valueEUR: 5000, costBasisEUR: 7000 },
    });
    expect(next.assets.depreciating.some((d) => d.name === "Moto")).toBe(true);
  });
});

// ---------- Settings ----------

describe("reducer · settings", () => {
  let state;
  beforeEach(() => { state = cleanState(); });

  it("set_limit", () => {
    const next = reducer(state, { type: "set_limit", amount: 2000 });
    expect(next.settings.spendLimit).toBe(2000);
  });

  it("set_base_currency", () => {
    const next = reducer(state, { type: "set_base_currency", currency: "USD" });
    expect(next.settings.baseCurrency).toBe("USD");
  });

  it("update_settings merge", () => {
    const next = reducer(state, { type: "update_settings", patch: { biometric: false, spendLimit: 999 } });
    expect(next.settings.biometric).toBe(false);
    expect(next.settings.spendLimit).toBe(999);
    expect(next.settings.baseCurrency).toBe("MXN"); // no se pierde
  });
});

// ---------- FX y oro (Top of Mind B) ----------

describe("reducer · update_fx", () => {
  it("actualiza goldPriceEUR y hace push a priceHistory.GOLD", () => {
    const state = cleanState();
    const next = reducer(state, { type: "update_fx", fx: { EUR: 1, USD: 1.1 }, goldPriceEUR: 95.4, priceHistory: { BTC: 62000, ETH: 3300, GOLD: 95.4 } });
    expect(next.goldPriceEUR).toBe(95.4);
    expect(next.priceHistory.GOLD[0]).toBe(68.4); // conserva la serie
    expect(next.priceHistory.GOLD.at(-1)).toBe(95.4); // push al final
  });

  it("mantiene goldPriceEUR si el action no lo trae (fallback)", () => {
    const state = cleanState();
    const next = reducer(state, { type: "update_fx", fx: { EUR: 1, USD: 1.1 }, priceHistory: { BTC: 62000, ETH: 3300, GOLD: null } });
    expect(next.goldPriceEUR).toBe(68.4);
    expect(next.priceHistory.GOLD.at(-1)).toBe(68.4); // GOLD null → se conserva la serie
  });

  it("no incrementa _syncVersion", () => {
    const state = cleanState();
    const next = reducer(state, { type: "update_fx", fx: state.fx, goldPriceEUR: 90 });
    expect(next._syncVersion).toBe(state._syncVersion);
  });
});

// ---------- Tarjetas de crédito ----------

describe("reducer · mark_card_paid", () => {
  it("marca ciclo de pago", () => {
    const state = cleanState({
      accounts: [
        ...cleanState().accounts,
        { id: "card-1", name: "Visa", type: "credit", currency: "EUR", balance: -500, payDay: 15, lastPaidCycle: null },
      ],
    });
    const next = reducer(state, { type: "mark_card_paid", accountId: "card-1", cycle: "2026-06" });
    expect(next.accounts.find((a) => a.id === "card-1").lastPaidCycle).toBe("2026-06");
  });
});

// ---------- Aprendizaje ----------

describe("reducer · learning", () => {
  let state;
  beforeEach(() => { state = cleanState(); });

  it("learn_transfer_aliases guarda alias normalizado", () => {
    const next = reducer(state, {
      type: "learn_transfer_aliases",
      aliases: { "BBVA Ahorro": "acc-ahorro", "  bbva  ": "acc-eur" },
    });
    expect(next.transferAliases["bbva ahorro"]).toBe("acc-ahorro");
    expect(next.transferAliases["bbva"]).toBe("acc-eur");
  });

  it("learn_category_aliases guarda alias", () => {
    const next = reducer(state, {
      type: "learn_category_aliases",
      aliases: { "OXXO": "Supermercado" },
    });
    expect(next.categoryAliases["oxxo"]).toBe("Supermercado");
  });

  it("learn_statement_pattern incrementa appliedCount", () => {
    const s1 = reducer(state, {
      type: "learn_statement_pattern",
      key: "pago-bbva",
      pattern: { description: "Pago BBVA", category: "Transferencia" },
    });
    expect(s1.statementPatterns["pago-bbva"].appliedCount).toBe(1);
    const s2 = reducer(s1, {
      type: "learn_statement_pattern",
      key: "pago-bbva",
      pattern: { description: "Pago BBVA", category: "Transferencia" },
    });
    expect(s2.statementPatterns["pago-bbva"].appliedCount).toBe(2);
  });

  it("learn_statement_pattern no hace nada sin key", () => {
    const next = reducer(state, { type: "learn_statement_pattern", key: null, pattern: {} });
    expect(next).toBe(state);
  });
});

// ---------- _syncVersion ----------

describe("reducer · _syncVersion", () => {
  it("no incrementa en accrue", () => {
    const state = cleanState();
    const next = reducer(state, { type: "accrue" });
    expect(next._syncVersion).toBe(state._syncVersion);
  });

  it("no incrementa en update_fx", () => {
    const state = cleanState();
    const next = reducer(state, { type: "update_fx", fx: state.fx });
    expect(next._syncVersion).toBe(state._syncVersion);
  });

  it("no incrementa en hydrate", () => {
    const state = cleanState();
    const next = reducer(state, { type: "hydrate", state: cleanState() });
    expect(next._syncVersion).toBe(state._syncVersion);
  });
});

// ---------- Selectores ----------

describe("selectores", () => {
  it("netWorthEUR calcula patrimonio total", () => {
    const state = cleanState();
    const nw = netWorthEUR(state);
    // cash: 1000 + 500*0.92 + 5000 = 6460
    expect(nw.cash).toBeCloseTo(6460, 2);
    // crypto: 0.082*61500 + 1.4*3120 = 5043 + 4368 = 9411
    expect(nw.crypto).toBeCloseTo(9411, 0);
    // gold: 45 * 68.4 = 3078
    expect(nw.gold).toBeCloseTo(3078, 0);
    // realEstate: 215000
    expect(nw.realEstate).toBe(215000);
  });

  it("monthSpend suma gastos del mes actual", () => {
    const today = new Date().toISOString().slice(0, 10);
    const state = cleanState({
      transactions: [
        { id: "t1", date: today, amount: -100, currency: "EUR", category: "Comida", accountId: "acc-eur" },
        { id: "t2", date: today, amount: -50, currency: "EUR", category: "Transporte", accountId: "acc-eur" },
        { id: "t3", date: today, amount: 500, currency: "EUR", category: "Ingresos", accountId: "acc-eur" },
        { id: "t4", date: today, amount: -200, currency: "EUR", category: "Transferencia", accountId: "acc-eur" },
      ],
    });
    // 100 + 50 = 150 (no cuenta ingreso ni transferencia)
    expect(monthSpend(state)).toBeCloseTo(150, 2);
  });

  it("currentCycle devuelve AAAA-MM", () => {
    const cycle = currentCycle(15, new Date("2026-06-25"));
    expect(cycle).toBe("2026-06");
  });

  it("pendingCardPayments detecta tarjeta sin pagar", () => {
    const state = cleanState({
      accounts: [
        ...cleanState().accounts,
        { id: "card-1", name: "Visa", type: "credit", currency: "EUR", balance: -800, payDay: 20, lastPaidCycle: null },
      ],
    });
    const pending = pendingCardPayments(state, new Date("2026-06-25"));
    expect(pending).toHaveLength(1);
    expect(pending[0].account.id).toBe("card-1");
    expect(pending[0].debt).toBe(800);
  });

  it("pendingCardPayments filtra tarjeta ya pagada", () => {
    const state = cleanState({
      accounts: [
        ...cleanState().accounts,
        { id: "card-1", name: "Visa", type: "credit", currency: "EUR", balance: -800, payDay: 20, lastPaidCycle: "2026-06" },
      ],
    });
    const pending = pendingCardPayments(state, new Date("2026-06-25"));
    expect(pending).toHaveLength(0);
  });
});

// ---------- restore ----------

describe("reducer · restore", () => {
  it("fusiona cuentas por ID con _updatedAt", () => {
    const state = cleanState();
    const cloudState = {
      ...cleanState(),
      accounts: [
        { id: "acc-eur", name: "Corriente Updated", type: "checking", currency: "EUR", balance: 1500, rate: 0, accrual: "none", lastAccrual: "2026-06-25", _updatedAt: Date.now() + 1000 },
      ],
    };
    const next = reducer(state, { type: "restore", state: cloudState });
    const acc = next.accounts.find((a) => a.id === "acc-eur");
    expect(acc.balance).toBe(1500);
    expect(acc.name).toBe("Corriente Updated");
  });

  it("no machaca local si cloud es más viejo", () => {
    const state = cleanState();
    state.accounts.find((a) => a.id === "acc-eur")._updatedAt = Date.now() + 5000;
    state.accounts.find((a) => a.id === "acc-eur").balance = 9999;
    const cloudState = {
      ...cleanState(),
      accounts: [
        { id: "acc-eur", name: "Viejo", type: "checking", currency: "EUR", balance: 100, rate: 0, accrual: "none", lastAccrual: "2026-06-25", _updatedAt: 1000 },
      ],
    };
    const next = reducer(state, { type: "restore", state: cloudState });
    expect(next.accounts.find((a) => a.id === "acc-eur").balance).toBe(9999);
  });
});

describe("clean_interest_duplicates · no modifica saldos", () => {
  it("elimina duplicados sin tocar balances (balance permanece igual)", () => {
    const state = cleanState();
    const BASE_BALANCE = 1000;
    state.accounts = [
      { id: "acc-clean", name: "Ahorro", type: "savings", currency: "EUR",
        balance: BASE_BALANCE, rate: 0.034, accrual: "monthly", lastAccrual: "2026-06-30" },
    ];
    // 1 tx legítima + 2 duplicadas exactas (misma descripción, monto, cuenta, fecha)
    state.transactions = [
      { id: "legit-1", date: "2026-06-01", description: "Gasto", amount: -50, currency: "EUR",
        category: "Alimentación", accountId: "acc-clean", auto: false },
      { id: "int-dup-a", date: "2026-06-30", description: "Intereses Ahorro (3.40 % TAE)", amount: 2.83,
        currency: "EUR", category: "Intereses", accountId: "acc-clean", auto: true },
      { id: "int-dup-b", date: "2026-06-30", description: "Intereses Ahorro (3.40 % TAE)", amount: 2.83,
        currency: "EUR", category: "Intereses", accountId: "acc-clean", auto: true },
      { id: "int-dup-c", date: "2026-06-30", description: "Intereses Ahorro (3.40 % TAE)", amount: 2.83,
        currency: "EUR", category: "Intereses", accountId: "acc-clean", auto: true },
    ];

    const next = reducer(state, { type: "clean_interest_duplicates" });

    // Debe quedar la tx legítima + solo la PRIMERA de las duplicadas (int-dup-a)
    expect(next.transactions.length).toBe(2);
    expect(next.transactions.map(t => t.id).sort()).toEqual(["int-dup-a", "legit-1"]);

    // deletedTransactions debe contener los dos duplicados borrados
    expect(Object.keys(next.deletedTransactions)).toHaveLength(2);
    expect(next.deletedTransactions["int-dup-b"]).toBeDefined();
    expect(next.deletedTransactions["int-dup-c"]).toBeDefined();

    // balance DEBE QUEDAR EXACTAMENTE IGUAL — los duplicados nunca acreditaron el balance
    expect(next.accounts[0].balance).toBe(BASE_BALANCE);
  });
});

// ---------- W24: Persistencia robusta — _dirty en todas las mutaciones ----------

describe("reducer · W24 _dirty flag", () => {
  let state;
  beforeEach(() => { state = { ...cleanState(), _syncVersion: 3, _dirty: false }; });

  it("add_account marca _dirty=true", () => {
    const next = reducer(state, { type: "add_account", account: { name: "Nueva", type: "checking", currency: "EUR", balance: 100 } });
    expect(next._dirty).toBe(true);
    expect(next._lastChangeAt).toBeGreaterThan(0);
  });

  it("add_transaction marca _dirty=true", () => {
    const next = reducer(state, {
      type: "add_transaction",
      tx: { description: "Café", amount: -3, currency: "EUR", accountId: "acc-eur", date: todayISO() },
    });
    expect(next._dirty).toBe(true);
  });

  it("update_settings marca _dirty=true", () => {
    const next = reducer(state, { type: "update_settings", patch: { softLimit: 999 } });
    expect(next._dirty).toBe(true);
  });

  it("delete_transaction marca _dirty=true", () => {
    const withTx = { ...state, transactions: [{ id: "tx-1", description: "X", amount: -1, currency: "EUR", accountId: "acc-eur", date: todayISO() }] };
    const next = reducer(withTx, { type: "delete_transaction", id: "tx-1" });
    expect(next._dirty).toBe(true);
  });

  it("update_fx (volátil) NO marca _dirty", () => {
    const next = reducer(state, { type: "update_fx", fx: { ...state.fx, USD: 0.93 } });
    expect(next._dirty).toBe(false);
  });

  it("accrue (volátil) NO marca _dirty", () => {
    const next = reducer(state, { type: "accrue" });
    expect(next._dirty).toBe(false);
  });

  it("hydrate (reemplazo del server) NO marca _dirty", () => {
    const next = reducer(state, { type: "hydrate", state: { ...state, _dirty: true, _syncVersion: 9 } });
    expect(next._dirty).toBeFalsy();
  });

  it("mark_clean limpia _dirty sin bump de _syncVersion", () => {
    const dirty = { ...state, _dirty: true, _lastChangeAt: Date.now() };
    const next = reducer(dirty, { type: "mark_clean" });
    expect(next._dirty).toBe(false);
    expect(next._syncVersion).toBe(dirty._syncVersion); // sin versión extra
    expect(next._lastChangeAt).toBe(dirty._lastChangeAt); // histórico intacto
  });

  it("mark_clean es idempotente (sin dirty → mismo estado)", () => {
    const next = reducer(state, { type: "mark_clean" });
    expect(next).toBe(state);
  });

  it("_dirty NO viaja en syncableSliceOf (no afecta hash ni sync)", async () => {
    const { syncableSliceOf, syncableHash } = await import("./utils");
    const base = { settings: { softLimit: 1 }, accounts: [], _syncVersion: 1 };
    const dirty = { ...base, _dirty: true, _lastChangeAt: 123 };
    expect(syncableSliceOf(dirty)).toEqual(syncableSliceOf(base));
    expect(JSON.stringify(syncableSliceOf(dirty))).not.toContain("_dirty");
    const h1 = await syncableHash(base);
    const h2 = await syncableHash(dirty);
    expect(h1).toBe(h2);
  });
});

// ---------- W35: la edición DEBE sobrevivir el merge del server ----------

describe("reducer · W35 — bump _updatedAt en ediciones (fix de ediciones que se revierten)", () => {
  it("update_transaction bump-ea _updatedAt (si no, mergeById conserva la copia vieja)", async () => {
    const state = { ...cleanState(), _syncVersion: 3, _dirty: false };
    const tx = { description: "Café", amount: -30, currency: "EUR", accountId: "acc-eur", date: todayISO() };
    const created = reducer(state, { type: "add_transaction", tx });
    const txId = created.transactions[0].id;
    await new Promise((r) => setTimeout(r, 5)); // T1 > T0
    const edited = reducer(created, { type: "update_transaction", id: txId, patch: { accountId: "acc-usd" } });
    const editedTx = edited.transactions.find((t) => t.id === txId);
    expect(editedTx.accountId).toBe("acc-usd");
    expect(editedTx._updatedAt).toBeGreaterThan(created.transactions[0]._updatedAt);
    // simulación del merge del server: existing (creación) vs incoming (edición)
    const { mergeById } = await import("../api/_merge.js");
    const existing = [{ ...created.transactions[0] }];
    const incoming = [{ ...editedTx }];
    const merged = mergeById(existing, incoming);
    expect(merged[0].accountId).toBe("acc-usd"); // la edición GANA el merge
  });

  it("update_account también bump-ea _updatedAt", () => {
    const state = { ...cleanState(), _syncVersion: 3, _dirty: false };
    const edited = reducer(state, { type: "update_account", accountId: "acc-eur", patch: { name: "Corriente Renombrada" } });
    const acc = edited.accounts.find((a) => a.id === "acc-eur");
    expect(acc.name).toBe("Corriente Renombrada");
    expect(acc._updatedAt).toBeGreaterThan(0);
  });
});

// ---------- W36: los balances movidos bump-ear _updatedAt (mergeById los conserva) ----------
import { consolidateAndBump } from "../api/_merge.js";

describe("reducer · W36 accounts movidas con _updatedAt", () => {
  function accState() {
    return cleanState();
  }
  it("update_transaction (cambio accountId) mueve balance Y bump-eara _updatedAt de ambas cuentas", () => {
    const st = accState();
    const withTx = reducer(st, { type: "add_transaction", tx: { description: "Interés", amount: 10.42, currency: "MXN", accountId: "acc-eur", date: todayISO() } });
    const tx = withTx.transactions[0];
    const upd = reducer(withTx, { type: "update_transaction", id: tx.id, patch: { accountId: "acc-usd" } });
    const from = upd.accounts.find((a) => a.id === "acc-eur");
    const to = upd.accounts.find((a) => a.id === "acc-usd");
    // el dinero SALIÓ de la vieja (vuelve al original) y APARECIÓ en la nueva
    expect(from.balance).toBe(st.accounts[0].balance);
    expect(to.balance).toBe(st.accounts[1].balance + 10.42);
    expect(from._updatedAt).toBeGreaterThan(0);
    expect(to._updatedAt).toBeGreaterThan(0);
  });
  it("el merge del server conserva el balance movido (el account con _updatedAt NOW gana)", async () => {
    const { consolidateAndBump } = await import("../api/_merge.js");
    const st = accState();
    const withTx = reducer(st, { type: "add_transaction", tx: { description: "Interés", amount: 10.42, currency: "MXN", accountId: "acc-eur", date: todayISO() } });
    const tx = withTx.transactions[0];
    const upd = reducer(withTx, { type: "update_transaction", id: tx.id, patch: { accountId: "acc-usd" } });
    // El competidor empuja la copia VIEJA de las accounts (sin el movimiento, sin _updatedAt)
    const existing = { accounts: st.accounts, _syncVersion: 1 };
    const merged = consolidateAndBump(existing, { accounts: upd.accounts, _syncVersion: 2 });
    const eur = merged.accounts.find((a) => a.id === "acc-eur");
    const usd = merged.accounts.find((a) => a.id === "acc-usd");
    // el merge conserva: el dinero salió de la vieja y apareció en la nueva
    expect(eur.balance).toBe(st.accounts[0].balance);
    expect(usd.balance).toBe(st.accounts[1].balance + 10.42);
  });
  it("transfer bump-eara _updatedAt de ambas cuentas", () => {
    const st = accState();
    const tr = reducer(st, { type: "transfer", fromId: "acc-eur", toId: "acc-usd", amount: 100 });
    const from = tr.accounts.find((a) => a.id === "acc-eur");
    const to = tr.accounts.find((a) => a.id === "acc-usd");
    expect(from._updatedAt).toBeGreaterThan(0);
    expect(to._updatedAt).toBeGreaterThan(0);
  });
  it("delete_transaction bump-eara _updatedAt del account de-acreditado", () => {
    const st = accState();
    const withTx = reducer(st, { type: "add_transaction", tx: { description: "X", amount: -5, currency: "EUR", accountId: "acc-eur", date: todayISO() } });
    const del = reducer(withTx, { type: "delete_transaction", id: withTx.transactions[0].id });
    const from = del.accounts.find((a) => a.id === "acc-eur");
    expect(from._updatedAt).toBeGreaterThan(0);
  });
});
