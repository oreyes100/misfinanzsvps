import { get, put } from "@vercel/blob";

const ID_RE = /^[a-z0-9-]{16,64}$/i;
const MAX_BYTES = 1_000_000;

function allowedOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return "";
  const allowed = (process.env.ALLOWED_ORIGINS || "https://mis-finazas-gold.vercel.app").split(",").map((s) => s.trim());
  if (allowed.includes(origin)) return origin;
  if (origin.startsWith("http://localhost:") || origin.startsWith("capacitor://localhost")) return origin;
  return "";
}

function cors(res, origin) {
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Vary", "Origin");
  }
}

export default async function handler(req, res) {
  const origin = allowedOrigin(req);
  cors(res, origin);

  if (req.method === "OPTIONS") return res.status(204).end();

  if (!origin) {
    return res.status(403).json({ error: "Origen no autorizado." });
  }

  const id = String(req.query.id || "");
  if (!ID_RE.test(id)) {
    return res.status(400).json({ error: "Código de sincronización inválido." });
  }
  const key = `sync/${id.toLowerCase()}.json`;

  if (req.method === "GET") {
    try {
      const result = await get(key, { access: "private", useCache: false });
      if (!result) return res.status(200).json({ found: false });
      const data = JSON.parse(await new Response(result.stream).text());
      return res.status(200).json({ found: true, state: data.state, updatedAt: data.updatedAt });
    } catch {
      return res.status(500).json({ error: "Error leyendo el almacenamiento." });
    }
  }

  if (req.method === "POST") {
    const body = req.body;
    if (!body || typeof body.state !== "object" || Array.isArray(body.state)) {
      return res.status(400).json({ error: "Estado inválido." });
    }
    const payload = JSON.stringify({ state: body.state, updatedAt: Date.now() });
    if (Buffer.byteLength(payload) > MAX_BYTES) {
      return res.status(413).json({ error: "Estado demasiado grande." });
    }
    try {
      await put(key, payload, {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: "application/json",
      });
      return res.status(200).json({ ok: true });
    } catch {
      return res.status(500).json({ error: "Error guardando en el almacenamiento." });
    }
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Método no permitido." });
}
