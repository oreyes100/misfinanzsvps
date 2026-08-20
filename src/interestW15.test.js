import { describe, it, expect } from "vitest";
import { accrueInterest, accrueCapped, isCappedAccount } from "./interest";
import { auditInterestHistory, dailyExpected, dailyTierExpected, totalInterest } from "./interestAudit";

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

// Mock de fecha
const mockDate = (isoDate) => {
  const realDate = Date;
  global.Date = class extends realDate {
    constructor(...args) { if (args.length === 0) super(isoDate + "T12:00:00"); else super(...args); }
    static now() { return new realDate(isoDate + "T12:00:00").getTime(); }
  };
  return realDate;
};

describe("W15 · especificación matemática (base 360, tramos MLALE)", () => {
  const mlale = {
    id: "mlale", name: "MLALE", type: "sofipo", currency: "MXN",
    balance: 25647.61, capped: true,
    rate1: 0.12, accrual1: "daily", balanceCap1: 25000, gainCap1: 0, gainAccrued1: 0,
    lastAccrual1: "2026-08-19",
    rate2: 0.053, accrual2: "daily", balanceCap2: 999999, gainCap2: 0, gainAccrued2: 0,
    lastAccrual2: "2026-08-19",
    lastAccrual: "2026-08-19",
  };

  it("diario genera ~8.33 con 25,000 al 12% (base 360)", () => {
    const realDate = mockDate("2026-08-20");
    try {
      const result = accrueInterest(stateWith(mlale));
      const t1 = result.transactions.find((t) => t.description.includes("tasa principal"));
      expect(t1).toBeDefined();
      expect(t1.amount).toBeGreaterThan(8.2);
      expect(t1.amount).toBeLessThan(8.4);
    } finally { global.Date = realDate; }
  });

  it("excedente genera ~0.09 al 5.3% (647.61 × 0.053/360 = 0.095)", () => {
    const realDate = mockDate("2026-08-20");
    try {
      const result = accrueInterest(stateWith(mlale));
      const t2 = result.transactions.find((t) => t.description.includes("tasa secundaria"));
      expect(t2).toBeDefined();
      expect(t2.amount).toBeGreaterThan(0.08);
      expect(t2.amount).toBeLessThan(0.11);
    } finally { global.Date = realDate; }
  });

  it("fin de semana (3 días) genera ~25.00 en el tramo principal", () => {
    // 2026-08-21 vie → 2026-08-24 lun = 3 días
    const realDate = mockDate("2026-08-24");
    try {
      const acc = { ...mlale, lastAccrual1: "2026-08-21", lastAccrual2: "2026-08-21", lastAccrual: "2026-08-21" };
      const result = accrueInterest(stateWith(acc));
      const t1 = result.transactions.find((t) => t.description.includes("tasa principal"));
      expect(t1).toBeDefined();
      expect(t1.amount).toBeGreaterThan(24.5);
      expect(t1.amount).toBeLessThan(25.5);
    } finally { global.Date = realDate; }
  });

  it("dailyExpected coincide con la suma de tramos teóricos", () => {
    expect(dailyTierExpected(mlale, 1)).toBeCloseTo(8.333, 2);
    expect(dailyTierExpected(mlale, 2)).toBeCloseTo(0.095, 3);
    expect(dailyExpected(mlale)).toBeCloseTo(8.429, 2);
  });
});

describe("W15 · idempotencia / doble devengo", () => {
  it("devengar 2 veces el mismo día NO duplica (idempotente)", () => {
    const realDate = mockDate("2026-08-20");
    try {
      const acc = {
        id: "idem", name: "Sofipo", type: "sofipo", currency: "MXN",
        balance: 25000, capped: true,
        rate1: 0.12, accrual1: "daily", balanceCap1: 25000,
        lastAccrual1: "2026-08-19",
        rate2: 0, accrual2: "none",
        lastAccrual2: "2026-08-19",
        lastAccrual: "2026-08-19",
      };
      const s1 = accrueInterest(stateWith(acc));
      const n1 = s1.transactions.length;
      expect(n1).toBeGreaterThan(0);
      const s2 = accrueInterest(s1);
      expect(s2.transactions.length).toBe(n1);
      expect(s2.accounts[0].balance).toBe(s1.accounts[0].balance);
    } finally { global.Date = realDate; }
  });

  it("gap de 8 días abona UNA sola vez (catch-up sin duplicar)", () => {
    const realDate = mockDate("2026-08-20");
    try {
      const acc = {
        id: "gap", name: "Sofipo", type: "sofipo", currency: "MXN",
        balance: 25000, capped: true,
        rate1: 0.12, accrual1: "daily", balanceCap1: 25000,
        lastAccrual1: "2026-08-12", // 8 días atrás
        rate2: 0, accrual2: "none",
        lastAccrual2: "2026-08-12",
        lastAccrual: "2026-08-12",
      };
      const s1 = accrueInterest(stateWith(acc));
      const t1 = s1.transactions.find((t) => t.description.includes("tasa principal"));
      expect(t1).toBeDefined();
      // 8 días × 8.33 = 66.67
      expect(t1.amount).toBeGreaterThan(65);
      expect(t1.amount).toBeLessThan(68);
      const s2 = accrueInterest(s1);
      expect(s2.transactions.length).toBe(s1.transactions.length);
    } finally { global.Date = realDate; }
  });

  it("sanity guard: config corrupta (tasa absurda + gap enorme) se cuarentena en anomalía", () => {
    const realDate = mockDate("2026-08-20");
    try {
      const acc = {
        id: "corrupt", name: "Sofipo", type: "sofipo", currency: "MXN",
        balance: 25000, capped: true,
        rate1: 0.99, accrual1: "daily", balanceCap1: 25000,
        lastAccrual1: "2020-01-01", // años atrás con tasa absurda → compuesto disparado
        rate2: 0, accrual2: "none",
        lastAccrual2: "2020-01-01",
        lastAccrual: "2020-01-01",
      };
      const result = accrueInterest(stateWith(acc));
      // La ganancia absurda debe quedar en anomalías, NO abonarse
      expect(result.pendingInterestAnomalies.length).toBeGreaterThan(0);
      const anom = result.pendingInterestAnomalies.find((a) => a.accountId === "corrupt");
      expect(anom).toBeDefined();
      expect(anom.cap).toBeLessThan(anom.gain);
      // Y el balance no se infla con la ganancia absurda
      expect(result.accounts[0].balance).toBeLessThan(25000 * 2);
    } finally { global.Date = realDate; }
  });

  it("cambio de tasa no aplica la vieja después de vigenteDesde (no re-procesa pasados)", () => {
    const realDate = mockDate("2026-08-20");
    try {
      // La cuenta ya tiene lastAccrual1 al día → correr de nuevo no re-devenga
      const acc = {
        id: "rate-change", name: "Sofipo", type: "sofipo", currency: "MXN",
        balance: 25000, capped: true,
        rate1: 0.12, accrual1: "daily", balanceCap1: 25000,
        lastAccrual1: "2026-08-20",
        rate2: 0, accrual2: "none",
        lastAccrual2: "2026-08-20",
        lastAccrual: "2026-08-20",
      };
      const s1 = accrueInterest(stateWith(acc));
      expect(s1.transactions.length).toBe(0);
    } finally { global.Date = realDate; }
  });
});

describe("W15 · auditoría de historial", () => {
  const acc = {
    id: "mlale", name: "MLALE", type: "sofipo", currency: "MXN",
    balance: 25647.61, capped: true,
    rate1: 0.12, accrual1: "daily", balanceCap1: 25000,
    rate2: 0.053, accrual2: "daily", balanceCap2: 999999,
  };
  const mkTx = (date, amount, desc) => ({
    id: `x-${date}-${amount}`, date, amount, description: desc, category: "Intereses", accountId: "mlale",
  });

  it("detecta abono bulk > 4 días", () => {
    const txs = [mkTx("2026-08-12", 217.57, "Intereses MLALE · tasa principal (12.00 % TAE)")];
    const rows = auditInterestHistory(acc, txs);
    expect(rows.some((r) => r.kind === "bulk_accrual")).toBe(true);
  });

  it("detecta doble devengo (simple + capped el mismo día)", () => {
    const txs = [
      mkTx("2026-08-04", 181.17, "Intereses MLALE (13.00 % TAE)"),
      mkTx("2026-08-04", 66.74, "Intereses MLALE · tasa principal (12.00 % TAE)"),
    ];
    const rows = auditInterestHistory(acc, txs);
    expect(rows.some((r) => r.kind === "double_count")).toBe(true);
  });

  it("detecta tasa stale (descripción cita 13% pero config es 12%)", () => {
    const txs = [mkTx("2026-08-04", 181.17, "Intereses MLALE (13.00 % TAE)")];
    const rows = auditInterestHistory(acc, txs);
    expect(rows.some((r) => r.kind === "stale_rate")).toBe(true);
  });

  it("no genera anomalías para un abono diario normal", () => {
    const txs = [mkTx("2026-08-20", 8.33, "Intereses MLALE · tasa principal (12.00 % TAE)")];
    expect(auditInterestHistory(acc, txs)).toHaveLength(0);
  });

  it("totalInterest suma solo intereses de la cuenta", () => {
    const txs = [
      mkTx("2026-08-20", 8.33, "x"),
      mkTx("2026-08-20", 0.09, "x"),
      { ...mkTx("2026-08-20", 5, "x"), accountId: "otra" },
    ];
    expect(totalInterest(txs, "mlale")).toBeCloseTo(8.42, 2);
  });
});