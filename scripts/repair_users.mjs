/**
 * Repara la contraseña del admin en la nube sin pasar por la API web.
 * Uso: node scripts/repair_users.mjs <nueva-contraseña> [usuario=jr]
 *
 * Úsalo cuando el hash en users/global.json no coincide con la contraseña actual
 * (síntoma: ⚠ Credenciales incorrectas al cambiar contraseña desde la app).
 */
import { get, put } from "@vercel/blob";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";

const [,, newPassword, username = "jr"] = process.argv;
if (!newPassword || newPassword.length < 6) {
  console.error("Uso: node scripts/repair_users.mjs <nueva-contraseña> [usuario=jr]");
  console.error("Ejemplo: node scripts/repair_users.mjs MiNuevaPass2026");
  process.exit(1);
}

const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const token = env.match(/BLOB_READ_WRITE_TOKEN="?([^"\n]+)"?/)?.[1];
if (!token) { console.error("❌ Sin BLOB_READ_WRITE_TOKEN en .env.local"); process.exit(1); }

const KEY = "users/global.json";
const PBKDF2_ITER = 100_000;

function pbkdf2(password, salt) {
  return crypto.pbkdf2Sync(String(password), String(salt), PBKDF2_ITER, 32, "sha256").toString("hex");
}

console.log(`Leyendo ${KEY}...`);
const r = await get(KEY, { access: "private", token, useCache: false });
if (!r) { console.error("❌ users/global.json no existe en Vercel Blob"); process.exit(1); }
const data = JSON.parse(await new Response(r.stream).text());
const users = Array.isArray(data.users) ? data.users : [];

console.log(`Usuarios en la nube: ${users.map(u => `${u.username}(${u.role})`).join(", ")}`);

const uname = String(username).toLowerCase().trim();
const target = users.find(u => String(u.username).toLowerCase().trim() === uname);
if (!target) {
  console.error(`❌ Usuario '${username}' no encontrado. Disponibles: ${users.map(u => u.username).join(", ")}`);
  process.exit(1);
}

const oldHash = target.hash?.slice(0, 16) ?? "N/A";
const salt = crypto.randomBytes(16).toString("base64");
const hash = pbkdf2(newPassword, salt);
target.salt = salt;
target.hash = hash;

const payload = JSON.stringify({ users, updatedAt: Date.now() });
console.log(`Escribiendo nuevo hash para '${target.username}'...`);
await put(KEY, payload, {
  access: "private",
  addRandomSuffix: false,
  allowOverwrite: true,
  contentType: "application/json",
  token,
});

console.log(`✓ Contraseña de '${target.username}' actualizada en la nube.`);
console.log(`  Hash anterior: ${oldHash}…`);
console.log(`  Hash nuevo:    ${hash.slice(0, 16)}…`);
console.log(`\nPróximos pasos:`);
console.log(`  1. Abre la app en la Mac (Cmd+Shift+R para refrescar)`);
console.log(`  2. Cierra sesión (si tienes sesión activa)`);
console.log(`  3. Login con usuario '${target.username}' y la contraseña que acabas de usar`);
console.log(`  4. Verifica en Opera/otro navegador que el login funciona`);
console.log(`  5. En Ajustes → Usuarios → 🔑 cambia la contraseña por la permanente que quieras`);
