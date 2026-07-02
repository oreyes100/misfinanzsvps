import { get, put } from "@vercel/blob";
import crypto from "node:crypto";

const KEY = "users/global.json";
const MAX_BYTES = 500_000;
const PBKDF2_ITER = 100_000;

function allowedOrigin(req) {
  let origin = req.headers.origin;
  const allowed = (process.env.ALLOWED_ORIGINS || "https://mis-finazas-gold.vercel.app").split(",").map((s) => s.trim());

  if (!origin) {
    const host = req.headers.host || req.headers["x-forwarded-host"];
    if (host) {
      const constructed = `https://${host}`;
      if (allowed.includes(constructed) || host.includes("vercel.app") || host.includes("localhost")) {
        return constructed;
      }
    }
    return "same-origin";
  }

  if (allowed.includes(origin)) return origin;
  if (origin.startsWith("http://localhost:") || origin.startsWith("capacitor://localhost")) return origin;
  return "";
}

function cors(res, origin) {
  if (origin && origin !== "same-origin") {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Vary", "Origin");
  }
}

// Nunca exponemos hash. Salt sí se devuelve tras verificar (permite cachear la
// credencial localmente sin volver a pedir al servidor en cada arranque).
function sanitizeUsers(users) {
  return (users || []).map(({ hash, salt, ...safe }) => safe);
}

// PBKDF2 idéntico al cliente (auth.js hashPassword): salt = bytes UTF-8 del
// string base64, 100k iteraciones, SHA-256, 256 bits, hex.
function pbkdf2(password, salt) {
  return crypto.pbkdf2Sync(String(password), String(salt), PBKDF2_ITER, 32, "sha256").toString("hex");
}
function sha256(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex");
}
function eq(a, b) {
  const ba = Buffer.from(String(a || "")), bb = Buffer.from(String(b || ""));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
// Verifica la contraseña contra el usuario almacenado (soporta legado sin salt).
function verifyCredential(user, password) {
  if (!user || !user.hash) return false;
  const candidate = user.salt ? pbkdf2(password, user.salt) : sha256(password);
  return eq(candidate, user.hash);
}

async function readUsers() {
  const result = await get(KEY, { access: "private", useCache: false });
  if (!result) return [];
  const data = JSON.parse(await new Response(result.stream).text());
  return Array.isArray(data.users) ? data.users : [];
}
async function writeUsers(users) {
  const payload = JSON.stringify({ users, updatedAt: Date.now() });
  if (Buffer.byteLength(payload) > MAX_BYTES) throw new Error("payload too large");
  await put(KEY, payload, { access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: "application/json" });
}
// Autoriza una escritura: el actor debe demostrar poseer el hash de un admin
// existente (que solo tiene un dispositivo que inició sesión; el GET lo sanea).
function authorizeWrite(existing, actor) {
  if (!existing.length) return true; // bootstrap sin usuarios
  const admin = existing.find(
    (u) => u.username.toLowerCase() === String(actor?.username || "").toLowerCase().trim() && (u.role === "admin" || u.sections === "all")
  );
  return !!admin && eq(actor?.hash, admin.hash);
}

export default async function handler(req, res) {
  const origin = allowedOrigin(req);
  cors(res, origin);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (!origin || origin === "") return res.status(403).json({ error: "Origen no autorizado." });

  if (req.method === "GET") {
    try {
      return res.status(200).json({ users: sanitizeUsers(await readUsers()) });
    } catch {
      return res.status(500).json({ error: "Error leyendo usuarios." });
    }
  }

  if (req.method === "POST") {
    const body = req.body || {};

    // Verificación server-side: el hash nunca sale del servidor.
    if (body.action === "verify") {
      try {
        const users = await readUsers();
        const user = users.find((u) => u.username.toLowerCase() === String(body.username || "").toLowerCase().trim());
        if (verifyCredential(user, body.password)) {
          const { hash, ...safe } = user; // devolvemos salt (no hash) para cachear en cliente
          return res.status(200).json({ ok: true, user: safe });
        }
        return res.status(200).json({ ok: false });
      } catch {
        return res.status(500).json({ error: "Error verificando." });
      }
    }

    // Setup inicial: solo permitido si la nube NO tiene usuarios (evita que
    // cualquiera cree un admin paralelo cuando ya hay cuentas).
    if (body.action === "setup") {
      try {
        const existing = await readUsers();
        if (existing.length > 0) return res.status(409).json({ error: "Ya existe configuración en la nube." });
        const u = body.user;
        if (!u || !u.username || !u.hash || !u.salt) return res.status(400).json({ error: "Usuario inválido." });
        await writeUsers([u]);
        return res.status(200).json({ ok: true });
      } catch {
        return res.status(500).json({ error: "Error en setup." });
      }
    }

    // Guardado de la lista (createUser/changePassword/deleteUser tras login).
    // Requiere prueba de admin cuando ya hay usuarios.
    if (Array.isArray(body.users)) {
      try {
        const existing = await readUsers();
        if (!authorizeWrite(existing, body.actor)) {
          return res.status(403).json({ error: "No autorizado para modificar usuarios." });
        }
        const payload = JSON.stringify({ users: body.users, updatedAt: Date.now() });
        if (Buffer.byteLength(payload) > MAX_BYTES) return res.status(413).json({ error: "Lista demasiado grande." });
        await writeUsers(body.users);
        return res.status(200).json({ ok: true });
      } catch {
        return res.status(500).json({ error: "Error guardando usuarios." });
      }
    }

    return res.status(400).json({ error: "Petición inválida." });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Método no permitido." });
}
