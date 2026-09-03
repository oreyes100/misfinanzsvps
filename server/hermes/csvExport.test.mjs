// csvExport.test.mjs — W31-I1: tests de toCsv (headers, escapado, mapeo).
import { test } from "node:test";
import assert from "node:assert/strict";
import { toCsv } from "../exportCsv.mjs";

const ACCOUNTS = [
  { id: "acc-corriente", name: "BBVA Corriente" },
  { id: "acc-ahorro", name: "Banorte Ahorro" },
];

test("csvExport: headers exactos y sin filas si no hay transacciones", () => {
  const csv = toCsv([], []);
  const lines = csv.split("\n");
  assert.equal(lines[0], "fecha,descripcion,monto,moneda,cuenta,categoria");
  assert.equal(lines.length, 1);
});

test("csvExport: descripcion y categoria entre comillas dobles, escapando comillas internas", () => {
  const csv = toCsv(
    [
      {
        id: "t1",
        date: "2026-09-01",
        description: 'Café "El Jarocho"',
        amount: -45.5,
        currency: "MXN",
        category: 'Comida "fuera"',
        accountId: "acc-corriente",
      },
    ],
    ACCOUNTS
  );
  const [header, row] = csv.split("\n");
  assert.equal(header, "fecha,descripcion,monto,moneda,cuenta,categoria");
  assert.equal(
    row,
    '2026-09-01,"Café ""El Jarocho""",-45.5,MXN,BBVA Corriente,"Comida ""fuera"""'
  );
});

test("csvExport: mapea accountId al nombre de cuenta (fallback al id si no existe)", () => {
  const csv = toCsv(
    [
      {
        id: "t1",
        date: "2026-09-02",
        description: "Sueldo",
        amount: 20000,
        currency: "MXN",
        category: "Ingresos",
        accountId: "acc-ahorro",
      },
      {
        id: "t2",
        date: "2026-09-03",
        description: "X",
        amount: 1,
        currency: "MXN",
        category: "Otros",
        accountId: "acc-desconocida",
      },
    ],
    ACCOUNTS
  );
  const rows = csv.split("\n").slice(1);
  assert.match(rows[0], /,Banorte Ahorro,/);
  assert.match(rows[1], /,acc-desconocida,/);
});
