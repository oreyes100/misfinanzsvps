// Análisis forense: ¿de dónde salen los MX$38,493.65 del 2026-07-13?
// Lee todos los blobs sync/*.json y desglosa las transacciones de esa fecha.
import { list, get } from "@vercel/blob";
import { readFileSync } from "node:fs";

// Cargar token desde .env.local sin dependencias
const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const token = env.match(/BLOB_READ_WRITE_TOKEN="?([^"\n]+)"?/)?.[1];
if (!token) { console.error("Sin token"); process.exit(1); }

const TARGET = "2026-07-13";

const { blobs } = await list({ prefix: "sync/", token });
console.log(`Blobs encontrados: ${blobs.length}`);

for (const b of blobs) {
  const result = await get(b.pathname, { access: "private", token, useCache: false });
  if (!result) { console.log(`\n=== ${b.pathname} — no accesible`); continue; }
  const data = JSON.parse(await new Response(result.stream).text());
  const state = data.state || data;
  const txs = state.transactions || [];
  const day = txs.filter(t => t.date === TARGET);
  if (!day.length) { console.log(`\n=== ${b.pathname} — sin tx el ${TARGET} (total tx: ${txs.length})`); continue; }

  console.log(`\n=== ${b.pathname} (updatedAt: ${new Date(data.updatedAt).toISOString()}) ===`);
  console.log(`Total tx en estado: ${txs.length} | Tx el ${TARGET}: ${day.length}`);

  const income = day.filter(t => t.amount > 0);
  const expense = day.filter(t => t.amount < 0);
  const sumInc = income.reduce((s, t) => s + t.amount, 0);
  const sumExp = expense.reduce((s, t) => s + Math.abs(t.amount), 0);
  console.log(`Ingresos: ${income.length} tx = ${sumInc.toFixed(2)} | Gastos: ${expense.length} tx = ${sumExp.toFixed(2)}`);

  // Por divisa
  const byCur = {};
  for (const t of income) { byCur[t.currency] = (byCur[t.currency] || 0) + t.amount; }
  console.log("Ingresos por divisa:", JSON.stringify(byCur));

  // Por categoría
  const byCat = {};
  for (const t of income) { byCat[t.category] = byCat[t.category] || { n: 0, sum: 0 }; byCat[t.category].n++; byCat[t.category].sum += t.amount; }
  console.log("Ingresos por categoría:");
  for (const [c, v] of Object.entries(byCat).sort((a, b) => b[1].sum - a[1].sum)) {
    console.log(`  ${c}: ${v.n} tx = ${v.sum.toFixed(2)}`);
  }

  // Por patrón de ID
  const byPattern = {};
  for (const t of income) {
    const p = /^int-/.test(t.id) ? "int-*(determinista)" : /^isr-/.test(t.id) ? "isr-*(determinista)" : /^[a-z0-9]{8,}$/i.test(t.id) ? "uid-aleatorio" : "otro";
    byPattern[p] = byPattern[p] || { n: 0, sum: 0 }; byPattern[p].n++; byPattern[p].sum += t.amount;
  }
  console.log("Ingresos por patrón de ID:", JSON.stringify(byPattern));

  // Duplicados por llave (accountId|date|description|amount)
  const groupsK = {};
  for (const t of income) {
    const k = `${t.accountId}|${t.date}|${t.description}|${t.amount}`;
    (groupsK[k] = groupsK[k] || []).push(t);
  }
  const dupGroups = Object.entries(groupsK).filter(([, arr]) => arr.length > 1);
  const dupCount = dupGroups.reduce((s, [, arr]) => s + arr.length - 1, 0);
  const dupSum = dupGroups.reduce((s, [, arr]) => s + arr.slice(1).reduce((x, t) => x + t.amount, 0), 0);
  console.log(`Grupos duplicados: ${dupGroups.length} | tx duplicadas (excedentes): ${dupCount} | monto duplicado: ${dupSum.toFixed(2)}`);

  // Top 5 grupos duplicados
  for (const [k, arr] of dupGroups.sort((a, b) => b[1].length - a[1].length).slice(0, 5)) {
    console.log(`  x${arr.length}  ${k}`);
  }

  // Muestra de 5 tx de ingreso
  console.log("Muestra (5):");
  for (const t of income.slice(0, 5)) {
    console.log(`  ${t.id} | ${t.accountId} | ${t.description} | ${t.amount} ${t.currency} | auto:${t.auto ?? "?"}`);
  }

  // deletedTransactions relevantes
  const del = state.deletedTransactions || {};
  console.log(`deletedTransactions total: ${Object.keys(del).length}`);
}
