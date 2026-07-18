import { get, put } from "@vercel/blob";
import crypto from "node:crypto";

const PENDING_KEY = "signup/pending.json";
const USERS_KEY = "users/global.json";
const PBKDF2_ITER = 100_000;
const CODE_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const DEMO_SECTIONS = ["inicio", "movimientos", "reportes"];
const DEMO_ACCOUNTS = ["acc-corriente", "acc-ahorro", "acc-deposito", "acc-usd"];

function allowedOrigin(req) {
  let origin = req.headers.origin;
  const allowed = (process.env.ALLOWED_ORIGINS || "https://mis-finazas-gold.vercel.app").split(",").map((s) => s.trim());
  if (!origin) {
    const host = req.headers.host || req.headers["x-forwarded-host"];
    if (host) {
      const constructed = `https://${host}`;
      if (allowed.includes(constructed) || host.includes("vercel.app") || host.includes("localhost")) return constructed;
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
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Vary", "Origin");
  }
}

function pbkdf2(password, salt) {
  return crypto.pbkdf2Sync(String(password), String(salt), PBKDF2_ITER, 32, "sha256").toString("hex");
}

async function readJSON(key) {
  const r = await get(key, { access: "private", useCache: false });
  if (!r) return null;
  return JSON.parse(await new Response(r.stream).text());
}

async function writeJSON(key, data) {
  await put(key, JSON.stringify(data), { access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: "application/json" });
}

async function sendVerificationEmail(to, code) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("EMAIL_NOT_CONFIGURED");
  const from = process.env.RESEND_FROM || "Mis Finanzas <noreply@mis-finazas-gold.vercel.app>";
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      from,
      to,
      subject: "Código de verificación — Mis Finanzas",
      html: `<p style="font-family:sans-serif">Tu código de verificación es:</p><p style="font-size:32px;font-weight:bold;letter-spacing:6px">${code}</p><p style="font-family:sans-serif;color:#888">Válido por 15 minutos. Si no solicitaste este código, ignora este mensaje.</p>`,
    }),
  });
  if (!r.ok) throw new Error(`Resend error ${r.status}`);
}

export default async function handler(req, res) {
  const origin = allowedOrigin(req);
  cors(res, origin);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!origin || origin === "") return res.status(403).json({ error: "Origen no autorizado." });
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Método no permitido." });
  }

  const body = req.body || {};

  // Step 1: request verification code
  if (body.action === "request") {
    const email = String(body.email || "").trim().toLowerCase();
    const password = String(body.password || "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Correo inválido." });
    if (password.length < 6) return res.status(400).json({ error: "Contraseña muy corta (mínimo 6 caracteres)." });

    try {
      const usersData = await readJSON(USERS_KEY);
      const users = Array.isArray(usersData?.users) ? usersData.users : [];
      if (users.some((u) => String(u.email || "").toLowerCase() === email)) {
        return res.status(409).json({ error: "Ese correo ya tiene una cuenta." });
      }

      const code = String(Math.floor(100000 + Math.random() * 900000));
      const salt = crypto.randomBytes(16).toString("base64");
      const hash = pbkdf2(password, salt);

      const pendingData = await readJSON(PENDING_KEY);
      let pendings = Array.isArray(pendingData?.pendings) ? pendingData.pendings : [];
      pendings = pendings.filter((p) => p.email !== email && Date.now() < p.expiresAt);
      pendings.push({ email, hash, salt, code, expiresAt: Date.now() + CODE_TTL_MS, attempts: 0 });
      await writeJSON(PENDING_KEY, { pendings });

      await sendVerificationEmail(email, code);
      return res.status(200).json({ ok: true });
    } catch (err) {
      if (err.message === "EMAIL_NOT_CONFIGURED") return res.status(503).json({ error: "Registro por correo no disponible en este momento." });
      return res.status(500).json({ error: "Error al procesar la solicitud." });
    }
  }

  // Step 2: verify code and create account
  if (body.action === "verify") {
    const email = String(body.email || "").trim().toLowerCase();
    const code = String(body.code || "").trim();

    try {
      const pendingData = await readJSON(PENDING_KEY);
      let pendings = Array.isArray(pendingData?.pendings) ? pendingData.pendings : [];
      const idx = pendings.findIndex((p) => p.email === email);
      if (idx < 0) return res.status(400).json({ error: "No hay verificación pendiente para ese correo." });

      const pending = pendings[idx];
      if (Date.now() > pending.expiresAt) {
        pendings.splice(idx, 1);
        await writeJSON(PENDING_KEY, { pendings });
        return res.status(400).json({ error: "El código expiró. Solicita uno nuevo." });
      }

      pending.attempts = (pending.attempts || 0) + 1;
      if (pending.attempts > MAX_ATTEMPTS) {
        pendings.splice(idx, 1);
        await writeJSON(PENDING_KEY, { pendings });
        return res.status(429).json({ error: "Demasiados intentos. Solicita un nuevo código." });
      }

      if (pending.code !== code) {
        await writeJSON(PENDING_KEY, { pendings });
        const left = MAX_ATTEMPTS - pending.attempts;
        return res.status(400).json({ error: `Código incorrecto. ${left} intento${left !== 1 ? "s" : ""} restante${left !== 1 ? "s" : ""}.` });
      }

      // Code OK — create user
      const usersData = await readJSON(USERS_KEY);
      const users = Array.isArray(usersData?.users) ? usersData.users : [];
      if (users.some((u) => String(u.email || "").toLowerCase() === email)) {
        pendings.splice(idx, 1);
        await writeJSON(PENDING_KEY, { pendings });
        return res.status(409).json({ error: "Ese correo ya tiene una cuenta." });
      }

      const base = email.split("@")[0].replace(/[^a-z0-9_]/gi, "").toLowerCase().slice(0, 20) || "guest";
      let username = base;
      let n = 1;
      while (users.some((u) => u.username.toLowerCase() === username.toLowerCase())) username = `${base}${n++}`;

      users.push({ username, hash: pending.hash, salt: pending.salt, email, role: "guest", sections: DEMO_SECTIONS, accounts: DEMO_ACCOUNTS, created: new Date().toISOString() });
      await writeJSON(USERS_KEY, { users, updatedAt: Date.now() });

      pendings.splice(idx, 1);
      await writeJSON(PENDING_KEY, { pendings });
      return res.status(200).json({ ok: true, username });
    } catch {
      return res.status(500).json({ error: "Error al verificar el código." });
    }
  }

  return res.status(400).json({ error: "Acción no reconocida." });
}
