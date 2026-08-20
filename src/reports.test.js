import { describe, expect, it } from "vitest";
import {
  allocationByType,
  cashflowByMonth,
  detectSubscriptions,
  isTransferTx,
  normalizeMerchant,
  spendingLine,
  toBase,
} from "./reports.ts";
import { rolloverBudget, nextMonthBudget } from "./budgets.ts";

const FX = { EUR: 1, USD: 0.92, MXN: 0.05, GBP: 1.17, BTC: 61500, ETH: 3120 };

const tx = (over = {}) => ({
  id: "t1",
  date: "2026-08-15",
  description: "Compra de prueba",
  amount: -10,
  currency: "EUR",
  category: "Otros",
  accountId: "a1",
  ...over,
});

describe("toBase", () => {
  it("devuelve el mismo monto en base EUR", () => {
    expect(toBase(100, "EUR", FX, "EUR")).toBe(100);
  });
  it("convierte MXN a EUR con fx real", () => {
    expect(toBase(1000, "MXN", FX, "EUR")).toBeCloseTo(50, 6);
  });
  it("convierte a divisa base distinta de EUR", () => {
    expect(toBase(100, "EUR", FX, "USD")).toBeCloseTo(100 / 0.92, 6);
  });
});

describe("isTransferTx", () => {
  it("detecta categoría Transferencia", () => {
    expect(isTransferTx(tx({ category: "Transferencia" }))).toBe(true);
  });
  it("rechaza el resto", () => {
    expect(isTransferTx(tx({ category: "Comida" }))).toBe(false);
  });
});

describe("normalizeMerchant", () => {
  it("normaliza mayúsculas, acentos y prefijos", () => {
    expect(normalizeMerchant("Pago a Netflix")).toBe("netflix");
    expect(normalizeMerchant("  Cargo  Spotify PREMIUM ")).toBe("spotify premium");
  });
  it("mantiene nombres compuestos de comercios", () => {
    expect(normalizeMerchant("Transferencia a Restaurant")).toBe("restaurant");
  });
});

describe("cashflowByMonth", () => {
  it("agrupa ingresos y gastos por mes excluyendo transferencias", () => {
    const rows = cashflowByMonth(
      [
        tx({ id: "a", date: "2026-08-10", amount: 2000, category: "Ingresos" }),
        tx({ id: "b", date: "2026-08-11", amount: -300, category: "Comida" }),
        tx({ id: "c", date: "2026-08-12", amount: -500, category: "Transferencia" }),
      ],
      FX,
      "EUR",
      6
    );
    const aug = rows.find((r) => r.key === "2026-08");
    expect(aug).toBeDefined();
    expect(aug.income).toBeCloseTo(2000, 6);
    expect(aug.expense).toBeCloseTo(300, 6); // la transferencia no cuenta
    expect(aug.net).toBeCloseTo(1700, 6);
  });
  it("genera el esqueleto de N meses desde hoy", () => {
    const rows = cashflowByMonth([], FX, "EUR", 3);
    expect(rows).toHaveLength(3);
    const now = new Date();
    const lastKey = rows[rows.length - 1].key;
    expect(lastKey).toBe(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`);
  });
  it("convierte monedas a divisa base", () => {
    const rows = cashflowByMonth([tx({ id: "m", amount: -1000, currency: "MXN", category: "Comida" })], FX, "EUR", 1);
    expect(rows[0].expense).toBeCloseTo(50, 6);
  });
});

describe("allocationByType", () => {
  const accounts = [
    { id: "ch", type: "checking", currency: "EUR", balance: 1000 },
    { id: "mx", type: "sofipo", currency: "MXN", balance: 20000 },
    { id: "cc", type: "credit", currency: "MXN", balance: -5000 },
    { id: "car", type: "auto_loan", currency: "USD", balance: -2000 },
  ];
  it("agrupa por tipo excluyendo pasivos", () => {
    const slices = allocationByType(accounts, FX, "EUR");
    const types = slices.map((s) => s.type).sort();
    expect(types).toEqual(["checking", "sofipo"]);
  });
  it("convierte a base y calcula porcentajes", () => {
    const slices = allocationByType(accounts, FX, "EUR");
    const total = 1000 + 20000 * 0.05;
    expect(slices.find((s) => s.type === "sofipo").value).toBeCloseTo(1000, 6);
    expect(slices.find((s) => s.type === "checking").pct).toBeCloseTo(0.5, 6);
    expect(slices.reduce((s, x) => s + x.pct, 0)).toBeCloseTo(1, 6);
    expect(slices.find((s) => s.type === "sofipo").label).toBe("Sofipo");
  });
  it("ordena de mayor a menor", () => {
    const slices = allocationByType(accounts, FX, "EUR");
    expect(slices[0].value).toBeGreaterThanOrEqual(slices[1].value);
  });
});

describe("detectSubscriptions", () => {
  it("detecta recurrente mensual", () => {
    const subs = detectSubscriptions(
      [
        tx({ id: "a", date: "2026-06-01", amount: -15.99, description: "Netflix" }),
        tx({ id: "b", date: "2026-07-01", amount: -15.99, description: "Pago a Netflix" }),
        tx({ id: "c", date: "2026-08-01", amount: -15.99, description: "netflix" }),
      ],
      FX,
      "EUR"
    );
    expect(subs).toHaveLength(1);
    expect(subs[0].merchant).toBe("netflix");
    expect(subs[0].freq).toBe("mensual");
    expect(subs[0].count).toBe(3);
    expect(subs[0].amount).toBeCloseTo(15.99, 6);
  });
  it("ignora una sola ocurrencia", () => {
    const subs = detectSubscriptions([tx({ id: "a", description: "Spotify" })], FX, "EUR");
    expect(subs).toHaveLength(0);
  });
  it("ignora transferencias internas", () => {
    const subs = detectSubscriptions(
      [
        tx({ id: "a", date: "2026-07-01", description: "Transferencia a ahorro", category: "Transferencia" }),
        tx({ id: "b", date: "2026-08-01", description: "Transferencia a ahorro", category: "Transferencia" }),
      ],
      FX,
      "EUR"
    );
    expect(subs).toHaveLength(0);
  });
  it("detecta semanal por intervalos cortos", () => {
    const subs = detectSubscriptions(
      [
        tx({ id: "a", date: "2026-08-01", description: "Gym", amount: -50 }),
        tx({ id: "b", date: "2026-08-08", description: "Gym", amount: -50 }),
        tx({ id: "c", date: "2026-08-15", description: "Gym", amount: -50 }),
      ],
      FX,
      "EUR"
    );
    expect(subs[0].freq).toBe("semanal");
  });
  it("convierte el último monto a base", () => {
    const subs = detectSubscriptions(
      [
        tx({ id: "a", date: "2026-07-05", description: "Gimnasio", amount: -500, currency: "MXN" }),
        tx({ id: "b", date: "2026-08-05", description: "Gimnasio", amount: -500, currency: "MXN" }),
      ],
      FX,
      "EUR"
    );
    expect(subs[0].amount).toBeCloseTo(25, 6);
  });
});

describe("spendingLine", () => {
  it("devuelve todos los días del mes en base", () => {
    const days = spendingLine(
      [
        tx({ id: "a", date: "2026-08-05", amount: -100 }),
        tx({ id: "b", date: "2026-08-05", amount: -200 }),
        tx({ id: "c", date: "2026-08-05", amount: -999, category: "Transferencia" }),
        tx({ id: "d", date: "2026-09-01", amount: -50 }),
      ],
      FX,
      "EUR",
      2026,
      8
    );
    expect(days).toHaveLength(31);
    expect(days[4].value).toBeCloseTo(300, 6); // día 5 suma los dos gastos
    expect(days[4].day).toBe(5);
    expect(days[30].value).toBe(0);
  });
});

describe("rolloverBudget", () => {
  it("carry positivo cuando se gasta menos de lo presupuestado", () => {
    expect(rolloverBudget("2026-08", 300, 500).carry).toBe(200);
  });
  it("clampa a 0 cuando se excede el presupuesto", () => {
    expect(rolloverBudget("2026-08", 700, 500).carry).toBe(0);
  });
  it("siguiente mes = asignación + carry", () => {
    expect(nextMonthBudget("2026-09", 500, 200)).toBe(700);
  });
});