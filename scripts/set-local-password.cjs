/**
 * set-local-password.cjs
 *
 * ADMIN tool — solo posible localmente (posees el archivo .db).
 * Actualiza directamente el hash/salt de un usuario en la BD SQLite local,
 * sin necesidad de la contraseña anterior. Útil para resetear el acceso
 * "admin" (ej. jr) después de migrar los datos desde Vercel.
 *
 * Uso: node scripts/set-local-password.cjs <usuario> <nueva-contraseña>
 *   node scripts/set-local-password.cjs jr 'Jr9988875-Temp899'
 *   node scripts/set-local-password.cjs jr 'NuevaPass2026'
 */
const path = require("node:path");
const crypto = require("node:crypto");
const Database = require("better-sqlite3");

const [, , username, newPassword] = process.argv;
if (!username || !newPassword || newPassword.length < 6) {
  console.error("Uso: node scripts/set-local-password.cjs <usuario> <nueva-contraseña>");
  process.exit(1);
}

const ITER = 100_000;
const dbPath = path.resolve(__dirname, "..", "server", "data", "misfinanzas.db");
const db = new Database(dbPath);

const exists = db.prepare("SELECT username FROM users WHERE username = ?").get(username);
if (!exists) {
  console.error(`Usuario '${username}' no existe en la BD local.`);
  console.error("Usuarios disponibles: " + db.prepare("SELECT username FROM users").all().map(r => r.username).join(", "));
  process.exit(1);
}

const salt = crypto.randomBytes(16).toString("base64");
const hash = crypto.pbkdf2Sync(newPassword, salt, ITER, 32, "sha256").toString("hex");

db.prepare("UPDATE users SET hash = ?, salt = ?, updated = ? WHERE username = ?").run(hash, salt, Date.now(), username);
db.close();

console.log(`✓ Contraseña local de '${username}' actualizada.`);
console.log(`  hash: ${hash.slice(0, 16)}…  salt: ${salt.slice(0, 12)}…`);
console.log("  Login desde la app: usuario '" + username + "' + esta contraseña.");
console.log("  Luego cámbiala en Ajustes → Usuarios → 🔑 para poner la permanente.");
