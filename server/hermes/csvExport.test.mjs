// csvExport.test.mjs — W31-I1: toCsv (headers, escapado de comillas, mapeo de cuenta).
// Se ejecuta con: node --test server/hermes/csvExport.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { toCsv } from "../exportCsv.mjs";

test("csvExport: toCsv emite la fila de headers fecha,descripcion,monto,moneda,cuenta,categoria", () => {
  assert.equal(
    toCsv([], []),
    "fecha,descripcion,monto,moneda,cuenta,categoria\n"
  );
});

test("csvExport: toCsv descripcion y categoria van entre comillas dobles escapando comillas internas", () => {
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
  const row = csv.split("\n")[1];
  assert.equal(
    row,
    '2026-09-01,"Cena ""especial"" con Ana",-350.5,MXN,Corriente,"Restaurant ""B"""'
  );
});

test("csvExport: toCsv mapea accountId al nombre de la cuenta y cae al id si no existe", () => {
  const csv = toCsv(
    [
      { date: "2026-09-02", description: "Uber", amount: -45, currency: "EUR", accountId: "a1", category: "Transporte" },
      { date: "2026-09-03", description: "Nómina", amount: 2000, currency: "EUR", accountId: "desconocida", category: "Ingresos" },
    ],
    [{ id: "a1", name: "Banco Principal" }]
  );
  const rows = csv.trimEnd().split("\n");
  assert.equal(rows.length, 3);
  assert.match(rows[1], /,Banco Principal,/);
  assert.match(rows[2], /,desconocida,/);
});
