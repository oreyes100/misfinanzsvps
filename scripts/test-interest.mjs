// Verificación del devengo de intereses. Ejecuta: node scripts/test-interest.mjs
import { accrueInterest } from "../src/interest.js";

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log("  ❌ " + msg); } };

const baseAcc = (over) => ({
  id: "a1", name: "TEST", currency: "MXN", balance: 25000,
  rate: 0, accrual: "none", lastAccrual: "2026-06-16", ...over,
});
const run = (acc, now) => {
  // monkeypatch todayISO via Date — interest.js usa todayISO() internamente.
  // Simulamos fijando la fecha del sistema.
  const RealDate = Date;
  const fixed = new RealDate(now + "T12:00:00");
  globalThis.Date = class extends RealDate {
    constructor(...a) { if (a.length === 0) { super(fixed.getTime()); } else { super(...a); } }
    static now() { return fixed.getTime(); }
  };
  try { return accrueInterest({ accounts: [acc], transactions: [] }); }
  finally { globalThis.Date = RealDate; }
};
const txs = (st) => st.transactions;
const find = (st, frag) => st.transactions.filter((t) => t.description.includes(frag));

console.log("== 1. Inversión MXN simple → interés + ISR ==");
{
  const st = run(baseAcc({ type: "investment", rate: 0.13, accrual: "daily" }), "2026-06-17");
  const int = find(st, "Intereses");
  const isr = find(st, "Impuesto");
  ok(int.length === 1, "debe haber 1 transacción de intereses");
  ok(isr.length === 1, "inversión MXN DEBE generar ISR");
  ok(int[0]?.amount > 0, "interés positivo");
  ok(isr[0]?.amount < 0, "ISR negativo");
  ok(int[0]?.date === "2026-06-17", `fecha hoy=17 (mié), got ${int[0]?.date}`);
  ok(isr[0]?.date === "2026-06-17", `ISR fecha hoy=17, got ${isr[0]?.date}`);
}

console.log("== 2. SOFIPO MXN capped → SOLO interés, SIN ISR ==");
{
  const st = run(baseAcc({
    type: "sofipo", capped: true, balance: 25000,
    rate1: 0.13, accrual1: "daily", balanceCap1: 30000,
    lastAccrual1: "2026-06-16", lastAccrual: "2026-06-16",
  }), "2026-06-17");
  ok(find(st, "Intereses").length === 1, "sofipo debe tener interés");
  ok(find(st, "Impuesto").length === 0, "SOFIPO NO debe tener ISR");
}

console.log("== 3. Inversión MXN capped → interés + ISR ==");
{
  const st = run(baseAcc({
    type: "investment", capped: true, balance: 25000,
    rate1: 0.13, accrual1: "daily", balanceCap1: 30000,
    lastAccrual1: "2026-06-16", lastAccrual: "2026-06-16",
  }), "2026-06-17");
  ok(find(st, "Intereses").length === 1, "inversión capped debe tener interés");
  ok(find(st, "Impuesto").length === 1, "inversión capped DEBE tener ISR");
}

console.log("== 4. Fecha en día hábil = hoy (no +1) ==");
{
  const st = run(baseAcc({ type: "investment", rate: 0.13, accrual: "daily" }), "2026-06-17");
  ok(txs(st).every((t) => t.date === "2026-06-17"), "miércoles 17 → fecha 17");
}

console.log("== 5. Fin de semana difiere a lunes ==");
{
  // sábado 2026-06-20 → lunes 2026-06-22
  const sat = run(baseAcc({ type: "investment", rate: 0.13, accrual: "daily", lastAccrual: "2026-06-19" }), "2026-06-20");
  ok(txs(sat).every((t) => t.date === "2026-06-22"), `sábado 20 → lunes 22, got ${txs(sat)[0]?.date}`);
  // domingo 2026-06-21 → lunes 2026-06-22
  const sun = run(baseAcc({ type: "investment", rate: 0.13, accrual: "daily", lastAccrual: "2026-06-20" }), "2026-06-21");
  ok(txs(sun).every((t) => t.date === "2026-06-22"), `domingo 21 → lunes 22, got ${txs(sun)[0]?.date}`);
  // viernes 2026-06-19 → mismo viernes (día hábil)
  const fri = run(baseAcc({ type: "investment", rate: 0.13, accrual: "daily", lastAccrual: "2026-06-18" }), "2026-06-19");
  ok(txs(fri).every((t) => t.date === "2026-06-19"), `viernes 19 → 19, got ${txs(fri)[0]?.date}`);
}

console.log("== 6. SOFIPO USD / ahorro MXN → sin ISR ==");
{
  const ahorro = run(baseAcc({ type: "savings", rate: 0.04, accrual: "daily" }), "2026-06-17");
  ok(find(ahorro, "Impuesto").length === 0, "ahorro no paga ISR");
  const usd = run(baseAcc({ type: "investment", currency: "USD", rate: 0.05, accrual: "daily" }), "2026-06-17");
  ok(find(usd, "Impuesto").length === 0, "inversión USD no paga ISR (solo MXN)");
}

console.log("== 7. SOFIPO capped 2 tramos → 2 intereses, 0 ISR ==");
{
  const st = run(baseAcc({
    type: "sofipo", capped: true, balance: 50000,
    rate1: 0.15, accrual1: "daily", balanceCap1: 25000, lastAccrual1: "2026-06-16",
    rate2: 0.10, accrual2: "daily", balanceCap2: 25000, lastAccrual2: "2026-06-16",
    lastAccrual: "2026-06-16",
  }), "2026-06-17");
  ok(find(st, "Intereses").length === 2, `2 tramos → 2 intereses, got ${find(st, "Intereses").length}`);
  ok(find(st, "Impuesto").length === 0, "SOFIPO 2 tramos sin ISR");
}

console.log(`\n${fail === 0 ? "✅" : "❌"}  PASS ${pass}  FAIL ${fail}`);
process.exit(fail === 0 ? 0 : 1);
