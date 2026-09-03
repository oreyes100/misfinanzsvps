import { describe, expect, it } from "vitest";
import { toCsv } from "./exportCsv.js";
import { toCsv as toCsvServer } from "../server/exportCsv.mjs";

describe("exportCsv · toCsv", () => {
  it("emite la fila de headers para entrada vacía", () => {
    expect(toCsv([], [])).toBe("fecha,descripcion,monto,moneda,cuenta,categoria\n");
  });

  it("descripcion y categoria van entre comillas dobles escapando comillas internas", () => {
    const csv = toCsv(
      [
        {
          date: "2026-09-01",
          description: 'Cena "especial" con Ana',
          amount: -350.5,
          currency: "MXN",
          accountId: "acc-1",
          category: 'Restaurant "B"',
        },
      ],
      [{ id: "acc-1", name: "Corriente" }]
    );
    expect(csv.split("\n")[1]).toBe(
      '2026-09-01,"Cena ""especial"" con Ana",-350.5,MXN,Corriente,"Restaurant ""B"""'
    );
  });

  it("mapea accountId al nombre de la cuenta y cae al id si no existe", () => {
    const csv = toCsv(
      [
        { date: "2026-09-02", description: "Uber", amount: -45, currency: "EUR", accountId: "a1", category: "Transporte" },
        { date: "2026-09-03", description: "Nómina", amount: 2000, currency: "EUR", accountId: "desconocida", category: "Ingresos" },
      ],
      [{ id: "a1", name: "Banco Principal" }]
    );
    const rows = csv.trimEnd().split("\n");
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatch(/,Banco Principal,/);
    expect(rows[2]).toMatch(/,desconocida,/);
  });

  it("tolera transacciones o cuentas nulas / no-array", () => {
    expect(toCsv(null, undefined)).toBe("fecha,descripcion,monto,moneda,cuenta,categoria\n");
  });

  it("termina con salto de línea final (RFC 4180)", () => {
    const csv = toCsv(
      [{ date: "2026-09-04", description: "Café", amount: 30, currency: "EUR", accountId: "a", category: "c" }],
      []
    );
    expect(csv.endsWith("\n")).toBe(true);
  });

  it("produce salida idéntica a la del server (server/exportCsv.mjs)", () => {
    const transactions = [
      { date: "2026-09-01", description: 'Cena "con" comillas', amount: -350.5, currency: "MXN", accountId: "acc-1", category: 'Restaurant "B"' },
      { date: "2026-09-02", description: "Uber", amount: -45, currency: "EUR", accountId: "ghost", category: "Transporte" },
    ];
    const accounts = [{ id: "acc-1", name: "Corriente" }];
    expect(toCsv(transactions, accounts)).toBe(toCsvServer(transactions, accounts));
  });
});
