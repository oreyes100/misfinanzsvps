import { describe, it, expect } from "vitest";
import { accrueInterest, accrueCapped, isCappedAccount, addDaysISO, payoutDatesBetween } from "./interest";

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
    // Mock today (2026-06-25) para que hayan exactamente 3 periodos de 30 días.
    const realDate = Date;
    global.Date = class extends realDate {
      constructor(...args) { if (args.length === 0) super("2026-06-25T12:00:00"); else super(...args); }
      static now() { return new realDate("2026-06-25T12:00:00").getTime(); }
    };
    try {
      const result = accrueInterest(state);
      const updated = result.accounts[0];
      // 6000 * ((1 + 0.041/12)^3 - 1)
      const expected = 6000 * (Math.pow(1 + 0.041 / 12, 3) - 1);
      expect(updated.balance).toBeCloseTo(6000 + Math.round(expected * 100) / 100, 0);
    } finally {
      global.Date = realDate;
    }
  });

  it("no devenga si no hay periodos completos", () => {
    const acc = {
      id: "acc-1", name: "Depósito", type: "deposit", currency: "EUR",
      balance: 6000, rate: 0.041, accrual: "monthly",
      lastAccrual: "2026-06-20", // 5 días → 0 periodos
    };
    // Mock today (2026-06-25) para que solo pasen 5 días desde el último abono.
    const realDate = Date;
    global.Date = class extends realDate {
      constructor(...args) { if (args.length === 0) super("2026-06-25T12:00:00"); else super(...args); }
      static now() { return new realDate("2026-06-25T12:00:00").getTime(); }
    };
    try {
      const result = accrueInterest(stateWith(acc));
      expect(result.accounts[0].balance).toBe(6000);
    } finally {
      global.Date = realDate;
    }
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
    const realDate = Date;
    global.Date = class extends realDate {
      constructor(...args) { if (args.length === 0) super("2026-06-25T12:00:00"); else super(...args); }
      static now() { return new realDate("2026-06-25T12:00:00").getTime(); }
    };
    try {
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
    } finally {
      global.Date = realDate;
    }
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
    const realDate = Date;
    global.Date = class extends realDate {
      constructor(...args) { if (args.length === 0) super("2026-06-25T12:00:00"); else super(...args); }
      static now() { return new realDate("2026-06-25T12:00:00").getTime(); }
    };
    try {
      const result = accrueInterest(stateWith(acc));    const updated = result.accounts[0];
    // Tramo 1: base 10000, tramo 2: base 5000 → ambos deben generar interés
    const txs1 = result.transactions.filter((t) => t.description.includes("tasa principal"));
    const txs2 = result.transactions.filter((t) => t.description.includes("tasa secundaria"));
    expect(txs1.length).toBeGreaterThan(0);
    expect(txs2.length).toBeGreaterThan(0);
    // El interés del tramo 1 debe ser mayor (tasa más alta, base igual o mayor)
    expect(txs1[0].amount).toBeGreaterThan(txs2[0].amount);
    } finally {
      global.Date = realDate;
    }
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
    const realDate = Date;
    global.Date = class extends realDate {
      constructor(...args) { if (args.length === 0) super("2026-06-25T12:00:00"); else super(...args); }
      static now() { return new realDate("2026-06-25T12:00:00").getTime(); }
    };
    try {
      const result = accrueInterest(stateWith(acc));
      const tx = result.transactions.find((t) => t.description.includes("tasa principal"));
      expect(tx).toBeDefined();
      // El interés no puede superar el gainCap restante (10)
      expect(tx.amount).toBeLessThanOrEqual(10);
    } finally {
      global.Date = realDate;
    }
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

// ---------- Idempotencia y determinismo (Move 3) ----------

describe("accrueInterest · idempotencia y determinismo", () => {
  const mockDate = (isoDate) => {
    const realDate = Date;
    global.Date = class extends realDate {
      constructor(...args) { if (args.length === 0) super(isoDate + "T12:00:00"); else super(...args); }
      static now() { return new realDate(isoDate + "T12:00:00").getTime(); }
    };
    return realDate;
  };

  it("segunda llamada en mismo día no genera transacciones nuevas", () => {
    const realDate = mockDate("2026-07-20");
    try {
      const acc = {
        id: "acc-idem", name: "Ahorro", type: "savings", currency: "EUR",
        balance: 10000, rate: 0.0365, accrual: "daily",
        lastAccrual: "2026-07-15",
      };
      const state1 = accrueInterest(stateWith(acc));
      expect(state1.transactions.length).toBeGreaterThan(0);
      const count1 = state1.transactions.length;
      const state2 = accrueInterest(state1);
      expect(state2.transactions.length).toBe(count1);
    } finally {
      global.Date = realDate;
    }
  });

  it("IDs de transacciones de interés son deterministas", () => {
    const realDate = mockDate("2026-07-20");
    try {
      const acc = {
        id: "acc-det", name: "Ahorro", type: "savings", currency: "EUR",
        balance: 10000, rate: 0.0365, accrual: "daily",
        lastAccrual: "2026-07-15",
      };
      const state = stateWith(acc);
      const result1 = accrueInterest(state);
      const result2 = accrueInterest(state);
      const ids1 = result1.transactions.map(t => t.id).sort();
      const ids2 = result2.transactions.map(t => t.id).sort();
      expect(ids1).toEqual(ids2);
    } finally {
      global.Date = realDate;
    }
  });

  it("balance no se duplica en segunda llamada con IDs ya existentes", () => {
    const realDate = mockDate("2026-07-20");
    try {
      const acc = {
        id: "acc-bal", name: "Ahorro", type: "savings", currency: "EUR",
        balance: 10000, rate: 0.0365, accrual: "daily",
        lastAccrual: "2026-07-15",
      };
      const state1 = accrueInterest(stateWith(acc));
      const balance1 = state1.accounts[0].balance;
      const state2 = accrueInterest(state1);
      const balance2 = state2.accounts[0].balance;
      expect(balance2).toBe(balance1);
    } finally {
      global.Date = realDate;
    }
  });

  it("IDs siguen formato determinista int-/isr-", () => {
    const realDate = mockDate("2026-07-20");
    try {
      const acc = {
        id: "acc-fmt", name: "Ahorro", type: "savings", currency: "EUR",
        balance: 10000, rate: 0.0365, accrual: "daily",
        lastAccrual: "2026-07-15",
      };
      const result = accrueInterest(stateWith(acc));
      const intTx = result.transactions.find(t => t.category === "Intereses");
      expect(intTx).toBeDefined();
      expect(intTx.id).toMatch(/^int-acc-fmt-t1-\d{4}-\d{2}-\d{2}-k1$/);
    } finally {
      global.Date = realDate;
    }
  });
});

// ---------- payoutDatesBetween ----------

describe("payoutDatesBetween · mensual con payoutDayOfMonth", () => {
  it("devuelve [] cuando hoy es antes del día de pago del primer mes", () => {
    // lastAccrual=2026-06-30, ahora=2026-07-15, payoutDayOfMonth=31 (último día)
    // El próximo pago sería 2026-07-31, que es > 2026-07-15 → no hay fechas.
    const acc = { id: "a", accrual: "monthly", payoutDayOfMonth: 31 };
    expect(payoutDatesBetween("2026-06-30", "2026-07-15", acc)).toEqual([]);
  });

  it("devuelve [2026-07-31] cuando hoy es el último día de julio", () => {
    // lastAccrual=2026-06-30, ahora=2026-07-31, pago el 31
    const acc = { id: "a", accrual: "monthly", payoutDayOfMonth: 31 };
    const dates = payoutDatesBetween("2026-06-30", "2026-07-31", acc);
    expect(dates).toEqual(["2026-07-31"]);
  });

  it("catch-up: 2 pagos si lastAccrual lleva 2 meses de retraso", () => {
    // lastAccrual=2026-05-31, ahora=2026-07-31, pago el 31 → debe haber 06-30 y 07-31
    const acc = { id: "a", accrual: "monthly", payoutDayOfMonth: 31 };
    const dates = payoutDatesBetween("2026-05-31", "2026-07-31", acc);
    expect(dates).toEqual(["2026-06-30", "2026-07-31"]);
  });

  it("día de pago > días del mes → usa último día del mes (febrero)", () => {
    // payoutDayOfMonth=31, febrero 2026 solo tiene 28 días → 2026-02-28
    const acc = { id: "a", accrual: "monthly", payoutDayOfMonth: 31 };
    const dates = payoutDatesBetween("2026-01-31", "2026-02-28", acc);
    expect(dates).toEqual(["2026-02-28"]);
  });

  it("no incluye lastAccrual mismo día (intervalo abierto en izquierda)", () => {
    // Si lastAccrual ya es el día de pago exacto, no debe re-emitir
    const acc = { id: "a", accrual: "monthly", payoutDayOfMonth: 31 };
    const dates = payoutDatesBetween("2026-07-31", "2026-07-31", acc);
    expect(dates).toEqual([]);
  });
});

describe("payoutDatesBetween · semanal con payoutWeekday", () => {
  it("devuelve viernes (5) cuando hoy es viernes", () => {
    // 2026-07-24 es viernes; lastAccrual=2026-07-20 (lunes)
    const acc = { id: "a", accrual: "weekly", payoutWeekday: 5 };
    const dates = payoutDatesBetween("2026-07-20", "2026-07-24", acc);
    expect(dates).toEqual(["2026-07-24"]);
  });

  it("devuelve [] cuando hoy es jueves (antes del viernes)", () => {
    // 2026-07-23 es jueves
    const acc = { id: "a", accrual: "weekly", payoutWeekday: 5 };
    const dates = payoutDatesBetween("2026-07-20", "2026-07-23", acc);
    expect(dates).toEqual([]);
  });

  it("catch-up: 2 viernes si hay 2 semanas pendientes", () => {
    const acc = { id: "a", accrual: "weekly", payoutWeekday: 5 };
    // 2026-07-24 y 2026-07-31 son ambos viernes
    const dates = payoutDatesBetween("2026-07-20", "2026-07-31", acc);
    expect(dates).toEqual(["2026-07-24", "2026-07-31"]);
  });
});

describe("accrueInterest · mensual con payoutDayOfMonth (seguro anti-Apple)", () => {
  const mockDate = (isoDate) => {
    const realDate = Date;
    global.Date = class extends realDate {
      constructor(...args) { if (args.length === 0) super(isoDate + "T12:00:00"); else super(...args); }
      static now() { return new realDate(isoDate + "T12:00:00").getTime(); }
    };
    return realDate;
  };

  it("no emite tx si no ha llegado el día de pago", () => {
    const realDate = mockDate("2026-07-15");
    try {
      const acc = {
        id: "apple-test", name: "Apple", type: "investment", currency: "USD",
        balance: 42000, rate: 0.034, accrual: "monthly", payoutDayOfMonth: 31,
        lastAccrual: "2026-06-30",
      };
      const result = accrueInterest(stateWith(acc));
      expect(result.transactions.length).toBe(0);
      // lastAccrual debe quedar igual (sin avanzar hasta que llegue el día)
      expect(result.accounts[0].lastAccrual).toBe("2026-06-30");
    } finally { global.Date = realDate; }
  });

  it("emite exactamente 1 tx el día de pago (2026-07-31)", () => {
    const realDate = mockDate("2026-07-31");
    try {
      const acc = {
        id: "apple-test", name: "Apple", type: "investment", currency: "USD",
        balance: 42000, rate: 0.034, accrual: "monthly", payoutDayOfMonth: 31,
        lastAccrual: "2026-06-30",
      };
      const result = accrueInterest(stateWith(acc));
      const intTxs = result.transactions.filter(t => t.category === "Intereses");
      expect(intTxs.length).toBe(1);
      expect(intTxs[0].id).toBe("int-apple-test-t1-2026-07-31-k1");
      expect(intTxs[0].date).toBe("2026-07-31");
      // monto ≈ 42000 × 0.034/12 = 119.00
      expect(intTxs[0].amount).toBeGreaterThan(110);
      expect(intTxs[0].amount).toBeLessThan(130);
    } finally { global.Date = realDate; }
  });

  it("catch-up idempotente: 2 meses → 2 tx, segunda ejecución no agrega más", () => {
    const realDate = mockDate("2026-07-31");
    try {
      const acc = {
        id: "apple-catch", name: "Apple", type: "investment", currency: "USD",
        balance: 42000, rate: 0.034, accrual: "monthly", payoutDayOfMonth: 31,
        lastAccrual: "2026-05-31",
      };
      const state1 = accrueInterest(stateWith(acc));
      const intTxs1 = state1.transactions.filter(t => t.category === "Intereses");
      expect(intTxs1.length).toBe(2); // 2026-06-30 y 2026-07-31
      expect(intTxs1.map(t => t.date).sort()).toEqual(["2026-06-30", "2026-07-31"]);
      // Segunda ejecución: 0 tx nuevas (idempotente)
      const state2 = accrueInterest(state1);
      expect(state2.transactions.length).toBe(state1.transactions.length);
    } finally { global.Date = realDate; }
  });

  it("regresión daily weekendDepositDay intacto (byte-idéntico)", () => {
    // Verifica que la rama daily no fue tocada
    const realDate = mockDate("2026-07-20");
    try {
      const acc = {
        id: "acc-regr", name: "Ahorro", type: "savings", currency: "EUR",
        balance: 10000, rate: 0.0365, accrual: "daily",
        lastAccrual: "2026-07-15",
      };
      const result = accrueInterest(stateWith(acc));
      expect(result.transactions.length).toBeGreaterThan(0);
      const tx = result.transactions[0];
      expect(tx.id).toMatch(/^int-acc-regr-t1-\d{4}-\d{2}-\d{2}-k1$/);
      expect(tx.category).toBe("Intereses");
      expect(tx.auto).toBe(true);
    } finally { global.Date = realDate; }
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
    const realDate = Date;
    global.Date = class extends realDate {
      constructor(...args) { if (args.length === 0) super("2026-06-25T12:00:00"); else super(...args); }
      static now() { return new realDate("2026-06-25T12:00:00").getTime(); }
    };
    try {
      const result = accrueInterest(state);
      expect(result.accounts.find((a) => a.id === "acc-1").balance).toBe(1000);
      expect(result.accounts.find((a) => a.id === "acc-2").balance).toBeGreaterThan(8000);
    } finally {
      global.Date = realDate;
    }
  });
});
