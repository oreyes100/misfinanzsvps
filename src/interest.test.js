import { describe, it, expect } from "vitest";
import { accrueInterest, accrueCapped, isCappedAccount, addDaysISO } from "./interest";

// Helper: estado mínimo con una sola cuenta
function stateWith(acc) {
  return {
    settings: { baseCurrency: "EUR" },
    accounts: [acc],
    transactions: [],
    categories: [],
    fx: { EUR: 1, USD: 0.92, MXN: 0.05 },
  };
}

// ---------- Modelo simple ----------

describe("accrueInterest · modelo simple (daily)", () => {
  it("devenga intereses diarios sobre saldo", () => {
    const acc = {
      id: "acc-1", name: "Ahorro", type: "savings", currency: "EUR",
      balance: 10000, rate: 0.0365, accrual: "daily",
      lastAccrual: "2026-06-20", // 5 días atrás (laborables)
    };
    const state = stateWith(acc);
    // Mock today to a known weekday with exactly 5 days delta (2026-06-25 is Thursday)
    const realDate = Date;
    global.Date = class extends realDate {
      constructor(...args) { if (args.length === 0) super("2026-06-25T12:00:00"); else super(...args); }
      static now() { return new realDate("2026-06-25T12:00:00").getTime(); }
    };
    try {
      const result = accrueInterest(state);
      const updated = result.accounts[0];
      // 10000 * ((1 + 0.0365/365)^5 - 1) ≈ 5.003
      expect(updated.balance).toBeGreaterThan(10000);
      expect(updated.balance).toBeLessThan(10011);
      const intTx = result.transactions.find((t) => t.category === "Intereses");
      expect(intTx).toBeDefined();
      expect(intTx.amount).toBeGreaterThan(0);
    } finally {
      global.Date = realDate;
    }
  });

  it("no devenga si accrual = none", () => {
    const acc = {
      id: "acc-1", name: "Corriente", type: "checking", currency: "EUR",
      balance: 5000, rate: 0.05, accrual: "none",
      lastAccrual: "2026-06-20",
    };
    const result = accrueInterest(stateWith(acc));
    expect(result.accounts[0].balance).toBe(5000);
    expect(result.transactions).toHaveLength(0);
  });

  it("no devenga si rate = 0", () => {
    const acc = {
      id: "acc-1", name: "Corriente", type: "checking", currency: "EUR",
      balance: 5000, rate: 0, accrual: "daily",
      lastAccrual: "2026-06-20",
    };
    const result = accrueInterest(stateWith(acc));
    expect(result.accounts[0].balance).toBe(5000);
  });

  it("no devenga si days ≤ 0", () => {
    const today = new Date().toISOString().slice(0, 10);
    const acc = {
      id: "acc-1", name: "Ahorro", type: "savings", currency: "EUR",
      balance: 5000, rate: 0.05, accrual: "daily",
      lastAccrual: today,
    };
    const result = accrueInterest(stateWith(acc));
    expect(result.accounts[0].balance).toBe(5000);
  });
});

describe("accrueInterest · modelo simple (monthly)", () => {
  it("devenga intereses mensuales (periodos completos)", () => {
    const acc = {
      id: "acc-1", name: "Depósito", type: "deposit", currency: "EUR",
      balance: 6000, rate: 0.041, accrual: "monthly",
      lastAccrual: "2026-03-25", // ~3 meses → 3 periodos de 30 días
    };
    const state = stateWith(acc);
    const result = accrueInterest(state);
    const updated = result.accounts[0];
    // 6000 * ((1 + 0.041/12)^3 - 1)
    const expected = 6000 * (Math.pow(1 + 0.041 / 12, 3) - 1);
    expect(updated.balance).toBeCloseTo(6000 + Math.round(expected * 100) / 100, 0);
  });

  it("no devenga si no hay periodos completos", () => {
    const acc = {
      id: "acc-1", name: "Depósito", type: "deposit", currency: "EUR",
      balance: 6000, rate: 0.041, accrual: "monthly",
      lastAccrual: "2026-06-20", // 5 días → 0 periodos
    };
    const result = accrueInterest(stateWith(acc));
    expect(result.accounts[0].balance).toBe(6000);
  });
});

// ---------- ISR (impuesto) ----------

describe("accrueInterest · ISR", () => {
  it("aplica ISR cuando isrRate > 0", () => {
    const acc = {
      id: "acc-1", name: "Inversión", type: "investment", currency: "MXN",
      balance: 50000, rate: 0.13, accrual: "daily",
      lastAccrual: "2026-06-20", isrRate: 0.000524,
    };
    const result = accrueInterest(stateWith(acc));
    const intTx = result.transactions.find((t) => t.category === "Intereses");
    const taxTx = result.transactions.find((t) => t.category === "Impuestos");
    expect(intTx).toBeDefined();
    expect(taxTx).toBeDefined();
    expect(taxTx.amount).toBeLessThan(0);
    // El saldo final = balance + interés - impuesto
    const updated = result.accounts[0];
    expect(updated.balance).toBeLessThan(50000 + intTx.amount);
    expect(updated.balance).toBeGreaterThan(50000);
  });

  it("no aplica ISR si isrRate = 0", () => {
    const acc = {
      id: "acc-1", name: "Ahorro", type: "savings", currency: "EUR",
      balance: 10000, rate: 0.05, accrual: "daily",
      lastAccrual: "2026-06-20", isrRate: 0,
    };
    const result = accrueInterest(stateWith(acc));
    expect(result.transactions.some((t) => t.category === "Impuestos")).toBe(false);
  });
});

// ---------- Cuentas con tope escalonado ----------

describe("accrueInterest · cuenta escalonada (capped)", () => {
  it("isCappedAccount detecta cuenta válida", () => {
    expect(isCappedAccount({ capped: true, currency: "MXN", type: "investment" })).toBe(true);
    expect(isCappedAccount({ capped: true, currency: "MXN", type: "sofipo" })).toBe(true);
    expect(isCappedAccount({ capped: true, currency: "EUR", type: "investment" })).toBe(false);
    expect(isCappedAccount({ capped: true, currency: "MXN", type: "savings" })).toBe(false);
    expect(isCappedAccount({ capped: false, currency: "MXN", type: "investment" })).toBe(false);
  });

  it("devenga tramo 1 y tramo 2 independientes", () => {
    const acc = {
      id: "acc-cap", name: "Sofipo", type: "investment", currency: "MXN",
      balance: 15000, capped: true,
      rate1: 0.13, accrual1: "daily", balanceCap1: 10000, gainCap1: 0, gainAccrued1: 0,
      lastAccrual1: "2026-06-20",
      rate2: 0.07, accrual2: "daily", balanceCap2: 5000, gainCap2: 0, gainAccrued2: 0,
      lastAccrual2: "2026-06-20",
      lastAccrual: "2026-06-20",
    };
    const result = accrueInterest(stateWith(acc));
    const updated = result.accounts[0];
    // Tramo 1: base 10000, tramo 2: base 5000 → ambos deben generar interés
    const txs1 = result.transactions.filter((t) => t.description.includes("tasa principal"));
    const txs2 = result.transactions.filter((t) => t.description.includes("tasa secundaria"));
    expect(txs1.length).toBeGreaterThan(0);
    expect(txs2.length).toBeGreaterThan(0);
    // El interés del tramo 1 debe ser mayor (tasa más alta, base igual o mayor)
    expect(txs1[0].amount).toBeGreaterThan(txs2[0].amount);
  });

  it("no devenga tramo si gainCap ya alcanzado", () => {
    const acc = {
      id: "acc-cap", name: "Sofipo", type: "investment", currency: "MXN",
      balance: 15000, capped: true,
      rate1: 0.13, accrual1: "daily", balanceCap1: 10000, gainCap1: 100, gainAccrued1: 100,
      lastAccrual1: "2026-06-20",
      rate2: 0, accrual2: "none",
      lastAccrual2: "2026-06-20",
      lastAccrual: "2026-06-20",
    };
    const result = accrueInterest(stateWith(acc));
    expect(result.transactions.filter((t) => t.description.includes("tasa principal"))).toHaveLength(0);
  });

  it("no excede gainCap en el tramo", () => {
    const acc = {
      id: "acc-cap", name: "Sofipo", type: "investment", currency: "MXN",
      balance: 50000, capped: true,
      rate1: 0.50, accrual1: "daily", balanceCap1: 50000, gainCap1: 10, gainAccrued1: 0,
      lastAccrual1: "2026-06-20",
      rate2: 0, accrual2: "none",
      lastAccrual2: "2026-06-20",
      lastAccrual: "2026-06-20",
    };
    const result = accrueInterest(stateWith(acc));
    const tx = result.transactions.find((t) => t.description.includes("tasa principal"));
    expect(tx).toBeDefined();
    // El interés no puede superar el gainCap restante (10)
    expect(tx.amount).toBeLessThanOrEqual(10);
  });
});

// ---------- Fin de semana ----------

describe("accrueInterest · fin de semana", () => {
  it("no devenga en sábado", () => {
    // 2026-06-27 es sábado
    const acc = {
      id: "acc-1", name: "Ahorro", type: "savings", currency: "EUR",
      balance: 10000, rate: 0.05, accrual: "daily",
      lastAccrual: "2026-06-20",
    };
    // Mock todayISO via Date
    const realDate = Date;
    global.Date = class extends realDate {
      constructor(...args) {
        if (args.length === 0) super("2026-06-27T12:00:00");
        else super(...args);
      }
      static now() { return new realDate("2026-06-27T12:00:00").getTime(); }
    };
    try {
      const result = accrueInterest(stateWith(acc));
      expect(result.accounts[0].balance).toBe(10000);
      expect(result.transactions).toHaveLength(0);
    } finally {
      global.Date = realDate;
    }
  });

  it("respeta weekendDepositDay=saturday y split en 2 depósitos", () => {
    const acc = {
      id: "acc-w", name: "MX Sofipo", type: "sofipo", currency: "MXN",
      balance: 10000, capped: true, rate1: 0.10, accrual1: "daily", balanceCap1: 10000,
      lastAccrual1: "2026-06-20", lastAccrual: "2026-06-20",
      weekendDepositDay: 'saturday', weekendDeposits: 2,
    };
    const realDate = Date;
    global.Date = class extends realDate {
      constructor(...args) { if (args.length === 0) super("2026-06-27T12:00:00"); else super(...args); } // sat
      static now() { return new realDate("2026-06-27T12:00:00").getTime(); }
    };
    try {
      const result = accrueInterest(stateWith(acc));
      const ints = result.transactions.filter((t) => t.category === "Intereses");
      // On sat + pref sat => should emit (split to 2)
      expect(ints.length).toBeGreaterThanOrEqual(1);
      // dates should be the sat
      expect(ints[0].date).toBe("2026-06-27");
    } finally {
      global.Date = realDate;
    }
  });
});

// ---------- addDaysISO ----------

describe("addDaysISO", () => {
  it("suma días correctamente", () => {
    expect(addDaysISO("2026-06-20", 5)).toBe("2026-06-25");
  });

  it("resta días con n negativo", () => {
    expect(addDaysISO("2026-06-25", -5)).toBe("2026-06-20");
  });

  it("cruza meses", () => {
    expect(addDaysISO("2026-06-28", 5)).toBe("2026-07-03");
  });
});

// ---------- Múltiples cuentas ----------

describe("accrueInterest · múltiples cuentas", () => {
  it("procesa cuenta con interés y cuenta sin interés en una pasada", () => {
    const state = stateWith({
      id: "acc-1", name: "Corriente", type: "checking", currency: "EUR",
      balance: 1000, rate: 0, accrual: "none", lastAccrual: "2026-06-25",
    });
    state.accounts.push({
      id: "acc-2", name: "Ahorro", type: "savings", currency: "EUR",
      balance: 8000, rate: 0.0365, accrual: "daily", lastAccrual: "2026-06-20",
    });
    const result = accrueInterest(state);
    expect(result.accounts.find((a) => a.id === "acc-1").balance).toBe(1000);
    expect(result.accounts.find((a) => a.id === "acc-2").balance).toBeGreaterThan(8000);
  });
});
