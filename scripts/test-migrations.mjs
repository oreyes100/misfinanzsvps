// Verificación de migraciones. Ejecuta: node scripts/test-migrations.mjs
import { migrateCategories, stripSofipoISR, backfillInvestmentISR, migrate } from "../src/migrations.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log("  ❌ " + msg); } };

console.log("== 1. migrateCategories rellena subcategorías faltantes ==");
{
  const old = [{ id: "cat-comida", name: "Comida", type: "expense", color: "#fff", keywords: [] }];
  const out = migrateCategories(old);
  const comida = out.find((c) => c.name === "Comida");
  ok(comida.subcategories?.length > 0, "Comida recupera subcategorías del default");
  ok(comida.keywords?.length > 0, "Comida recupera keywords del default");
  ok(out.some((c) => c.name === "Impuestos" && c.system), "agrega categoría de sistema Impuestos");
}

console.log("== 2. migrateCategories respeta personalizaciones del usuario ==");
{
  const custom = [{ id: "cat-comida", name: "Comida", type: "expense", color: "#fff", subcategories: ["MiSub"], keywords: ["mikw"] }];
  const out = migrateCategories(custom);
  const comida = out.find((c) => c.name === "Comida");
  ok(comida.subcategories.length === 1 && comida.subcategories[0] === "MiSub", "no pisa subcategorías del usuario");
  ok(comida.keywords[0] === "mikw", "no pisa keywords del usuario");
}

console.log("== 3. stripSofipoISR borra ISR en sofipos y reembolsa ==");
{
  const state = {
    accounts: [{ id: "s1", type: "sofipo", currency: "MXN", balance: 1000 }],
    transactions: [
      { id: "i1", date: "2026-06-17", description: "Intereses MLJR (13.00 % TAE)", amount: 5, category: "Intereses", accountId: "s1" },
      { id: "x1", date: "2026-06-17", description: "Impuesto intereses MLJR (0.90 % anual)", amount: -2, category: "Impuestos", accountId: "s1" },
    ],
  };
  const out = stripSofipoISR(state);
  ok(out.transactions.length === 1, "borra la transacción de ISR del sofipo");
  ok(out.transactions[0].id === "i1", "conserva los intereses");
  ok(out.accounts[0].balance === 1002, `reembolsa el ISR al saldo (1000+2), got ${out.accounts[0].balance}`);
}

console.log("== 4. stripSofipoISR no toca ISR de inversión ==");
{
  const state = {
    accounts: [{ id: "v1", type: "investment", currency: "MXN", balance: 1000 }],
    transactions: [{ id: "x1", date: "2026-06-17", description: "Impuesto intereses UALAINV (0.90 % anual)", amount: -2, category: "Impuestos", accountId: "v1" }],
  };
  const out = stripSofipoISR(state);
  ok(out.transactions.length === 1, "ISR de inversión intacto");
  ok(out.accounts[0].balance === 1000, "saldo de inversión sin cambios");
}

console.log("== 5. backfillInvestmentISR agrega ISR faltante en inversión MXN ==");
{
  const state = {
    accounts: [{ id: "v1", type: "investment", currency: "MXN", balance: 1000 }],
    transactions: [{ id: "i1", date: "2026-06-17", description: "Intereses UALAINV (1.00 % TAE)", amount: 10, category: "Intereses", accountId: "v1" }],
  };
  const out = backfillInvestmentISR(state);
  const isr = out.transactions.find((t) => t.category === "Impuestos");
  ok(!!isr, "crea la transacción de ISR");
  // isr = interés * 0.009 / rate = 10 * 0.009 / 0.01 = 9
  ok(isr.amount === -9, `ISR = -9 (10*0.009/0.01), got ${isr.amount}`);
  ok(out.accounts[0].balance === 991, `saldo ajustado 1000-9, got ${out.accounts[0].balance}`);
}

console.log("== 6. backfillInvestmentISR es idempotente ==");
{
  const state = {
    accounts: [{ id: "v1", type: "investment", currency: "MXN", balance: 1000 }],
    transactions: [{ id: "i1", date: "2026-06-17", description: "Intereses UALAINV (1.00 % TAE)", amount: 10, category: "Intereses", accountId: "v1" }],
  };
  const once = backfillInvestmentISR(state);
  const twice = backfillInvestmentISR(once);
  ok(once.transactions.length === twice.transactions.length, "segunda corrida no duplica ISR");
  ok(twice.accounts[0].balance === once.accounts[0].balance, "saldo no se vuelve a ajustar");
}

console.log("== 7. backfillInvestmentISR NO toca sofipos ==");
{
  const state = {
    accounts: [{ id: "s1", type: "sofipo", currency: "MXN", balance: 1000 }],
    transactions: [{ id: "i1", date: "2026-06-17", description: "Intereses MLALE (13.00 % TAE)", amount: 10, category: "Intereses", accountId: "s1" }],
  };
  const out = backfillInvestmentISR(state);
  ok(!out.transactions.some((t) => t.category === "Impuestos"), "no agrega ISR a sofipo");
}

console.log("== 8. backfillInvestmentISR ignora inversión USD ==");
{
  const state = {
    accounts: [{ id: "u1", type: "investment", currency: "USD", balance: 1000 }],
    transactions: [{ id: "i1", date: "2026-06-17", description: "Intereses SCHWAB (0.50 % TAE)", amount: 10, category: "Intereses", accountId: "u1" }],
  };
  const out = backfillInvestmentISR(state);
  ok(!out.transactions.some((t) => t.category === "Impuestos"), "USD no genera ISR");
}

console.log("== 9. backfill maneja tramos (descripción con tasa principal) ==");
{
  const state = {
    accounts: [{ id: "v1", type: "investment", currency: "MXN", balance: 1000 }],
    transactions: [{ id: "i1", date: "2026-06-17", description: "Intereses REVOLUTALE · tasa principal (15.00 % TAE)", amount: 15, category: "Intereses", accountId: "v1" }],
  };
  const out = backfillInvestmentISR(state);
  const isr = out.transactions.find((t) => t.category === "Impuestos");
  ok(isr?.description === "Impuesto intereses REVOLUTALE · tasa principal (0.90 % anual)", `desc ISR de tramo correcta, got ${isr?.description}`);
  ok(isr.amount === -0.9, `ISR tramo = -0.9 (15*0.009/0.15), got ${isr.amount}`);
}

console.log("== 10. migrate combinado: sofipo limpia + inversión backfill ==");
{
  const state = {
    categories: [{ id: "cat-comida", name: "Comida", type: "expense", color: "#fff" }],
    accounts: [
      { id: "s1", type: "sofipo", currency: "MXN", balance: 1000 },
      { id: "v1", type: "investment", currency: "MXN", balance: 1000 },
    ],
    transactions: [
      { id: "is", date: "2026-06-17", description: "Intereses MLJR (13.00 % TAE)", amount: 5, category: "Intereses", accountId: "s1" },
      { id: "xs", date: "2026-06-17", description: "Impuesto intereses MLJR (0.90 % anual)", amount: -2, category: "Impuestos", accountId: "s1" },
      { id: "iv", date: "2026-06-17", description: "Intereses UALAINV (1.00 % TAE)", amount: 10, category: "Intereses", accountId: "v1" },
    ],
  };
  const out = migrate(state);
  ok(!out.transactions.some((t) => t.accountId === "s1" && t.category === "Impuestos"), "sofipo sin ISR");
  ok(out.transactions.some((t) => t.accountId === "v1" && t.category === "Impuestos"), "inversión con ISR");
  ok(out.accounts.find((a) => a.id === "s1").balance === 1002, "sofipo reembolsado");
  ok(out.accounts.find((a) => a.id === "v1").balance === 991, "inversión ajustada");
  ok(out.categories.find((c) => c.name === "Comida").subcategories?.length > 0, "categorías migradas");
}

console.log(`\n${fail === 0 ? "✅" : "❌"}  PASS ${pass}  FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
