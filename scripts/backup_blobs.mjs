// backup_blobs.mjs — Descarga TODOS los blobs de Vercel a ./backup/ (read-only, binario crudo)
import { list, get } from "@vercel/blob";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const token = env.match(/BLOB_READ_WRITE_TOKEN="?([^"\n]+)"?/)?.[1];
if (!token) { console.error("Sin BLOB_READ_WRITE_TOKEN en .env.local"); process.exit(1); }

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "backup");
mkdirSync(outDir, { recursive: true });

const all = [];
const listRes = await list({ token, limit: 1000 });
all.push(...listRes.blobs);
async function keepListing(cursor) {
  if (!cursor) return;
  const r = await list({ token, limit: 1000, cursor });
  all.push(...r.blobs);
  await keepListing(r.cursor);
}
await keepListing(listRes.cursor);

console.log(`Total blobs: ${all.length}`);
let ok = 0, fail = 0;
for (const b of all) {
  try {
    const r = await get(b.pathname, { access: "private", token, useCache: false });
    let buf;
    if (r && r.stream) {
      const reader = r.stream.getReader();
      const chunks = [];
      for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(Buffer.from(value)); }
      buf = Buffer.concat(chunks);
    } else {
      buf = Buffer.from("null");
    }
    const dest = path.join(outDir, b.pathname);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, buf);
    console.log(`  ✓ ${b.pathname}  (${b.size} B)`);
    ok++;
  } catch (e) {
    console.log(`  ✗ ${b.pathname}: ${e.message}`);
    fail++;
  }
}
console.log(`\nBackup completado: ${ok} OK, ${fail} fallidos -> ${outDir}`);