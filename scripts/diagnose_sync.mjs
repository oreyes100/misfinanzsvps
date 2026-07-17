// Diagnóstico read-only: lista blobs sync/* y estado de users/global.json
import { get, list } from "@vercel/blob";
import { readFileSync } from "node:fs";

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const token = env.match(/BLOB_READ_WRITE_TOKEN="?([^"\n]+)"?/)?.[1];
if (!token) { console.error("Sin token"); process.exit(1); }

// 1) Todos los blobs bajo sync/
const syncBlobs = await list({ prefix: "sync/", token });
console.log("=== BLOBS sync/* ===");
for (const b of syncBlobs.blobs) {
  console.log(`${b.pathname}  size=${b.size}  uploaded=${b.uploadedAt}`);
}

// Detalle de cada blob sync: cuenta tx, última fecha manual
for (const b of syncBlobs.blobs) {
  try {
    const r = await get(b.pathname, { access: "private", token, useCache: false });
    const data = JSON.parse(await new Response(r.stream).text());
    const txs = data.state?.transactions || [];
    const manual = txs.filter(t => !t.auto);
    const lastManual = manual.map(t => t.date).sort().at(-1);
    const lastTx = txs.map(t => t.date).sort().at(-1);
    console.log(`\n--- ${b.pathname} ---`);
    console.log(`updatedAt: ${new Date(data.updatedAt).toISOString()}`);
    console.log(`cuentas: ${(data.state?.accounts || []).length} | tx total: ${txs.length} | tx manuales: ${manual.length}`);
    console.log(`última tx manual: ${lastManual} | última tx cualquiera: ${lastTx}`);
    const apple = (data.state?.accounts || []).find(a => /apple/i.test(a.name || ""));
    if (apple) console.log(`Apple: balance=${apple.balance} lastAccrual=${apple.lastAccrual} payoutDayOfMonth=${apple.payoutDayOfMonth}`);
  } catch (e) {
    console.log(`${b.pathname}: ERROR ${e.message}`);
  }
}

// 2) users/global.json
console.log("\n=== users/global.json ===");
try {
  const r = await get("users/global.json", { access: "private", token, useCache: false });
  if (!r) { console.log("NO EXISTE"); process.exit(0); }
  const data = JSON.parse(await new Response(r.stream).text());
  console.log(`updatedAt: ${data.updatedAt ? new Date(data.updatedAt).toISOString() : "?"}`);
  for (const u of data.users || []) {
    console.log(`- ${u.username}  role=${u.role}  hash=${u.hash ? "SÍ (" + u.hash.slice(0, 8) + "…)" : "❌ FALTA"}  salt=${u.salt ? "SÍ" : "❌ FALTA"}  sections=${JSON.stringify(u.sections)?.slice(0, 40)}  created=${u.created}`);
  }
} catch (e) {
  console.log(`ERROR: ${e.message}`);
}
