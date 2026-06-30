import { get, put } from "@vercel/blob";

const KEY = "users/global.json";
const MAX_BYTES = 500_000;

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

function sanitizeUsers(users) {
  return (users || []).map(({ hash, salt, ...safe }) => safe);
}

export default async function handler(req, res) {
  const origin = allowedOrigin(req);
  cors(res, origin);

  if (req.method === "OPTIONS") return res.status(204).end();

  if (!origin || origin === "") {
    return res.status(403).json({ error: "Origen no autorizado." });
  }

  if (req.method === "GET") {
    try {
      const result = await get(KEY, { access: "private", useCache: false });
      if (!result) return res.status(200).json({ users: [] });
      const data = JSON.parse(await new Response(result.stream).text());
      return res.status(200).json({ users: sanitizeUsers(data.users) });
    } catch {
      return res.status(500).json({ error: "Error leyendo usuarios." });
    }
  }

  if (req.method === "POST") {
    const body = req.body;
    if (!body || !Array.isArray(body.users)) {
      return res.status(400).json({ error: "Lista de usuarios inválida." });
    }
    const payload = JSON.stringify({ users: body.users, updatedAt: Date.now() });
    if (Buffer.byteLength(payload) > MAX_BYTES) {
      return res.status(413).json({ error: "Lista demasiado grande." });
    }
    try {
      await put(KEY, payload, {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/json",
      });
      return res.status(200).json({ ok: true });
    } catch {
      return res.status(500).json({ error: "Error guardando usuarios." });
    }
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Método no permitido." });
}
