// push.js — Vercel Function: POST /api/push (W23 convergencia fuerte).
// El cliente envía su DELTA crudo (sin merge por entidad en el cliente);
// el server consolida de forma determinista (mergeStates) y avanza
// _syncVersion (consolidateAndBump). Devuelve el snapshot consolidado para
// que el cliente lo ADOPTE por reemplazo total.
import { get, put } from "@vercel/blob";
import { consolidateAndBump } from "./_merge.js";
import { syncableHash } from "./_hash.js";

const ID_RE = /^[a-z0-9-]{16,64}$/i;
const MAX_BYTES = 1_000_000;

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
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Vary", "Origin");
  }
}

export default async function handler(req, res) {
  const origin = allowedOrigin(req);
  cors(res, origin);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!origin || origin === "") return res.status(403).json({ error: "Origen no autorizado." });
  if (req.method !== "POST") return res.status(405).json({ error: "Método no permitido." });

  const id = String(req.query.id || "");
  if (!ID_RE.test(id)) return res.status(400).json({ error: "Código de sincronización inválido." });
  const key = `sync/${id.toLowerCase()}.json`;

  const body = req.body;
  if (!body || typeof body.state !== "object" || Array.isArray(body.state)) {
    return res.status(400).json({ error: "Estado inválido." });
  }

  let finalState = body.state;
  let existing = null;
  try {
    const result = await get(key, { access: "private", useCache: false });
    if (result) {
      existing = JSON.parse(await new Response(result.stream).text()).state || null;
    }
  } catch { /* sin blob previo */ }

  if (existing && existing !== body.state) {
    finalState = consolidateAndBump(existing, body.state);
  } else {
    // Primer push / sin previo: normalizar versión.
    finalState = { ...finalState, _syncVersion: (finalState._syncVersion || 0) + 1 };
  }

  const payload = JSON.stringify({ state: finalState, updatedAt: Date.now() });
  if (Buffer.byteLength(payload) > MAX_BYTES) {
    return res.status(413).json({ error: "Estado demasiado grande." });
  }

  try {
    await put(key, payload, { access: "private", addRandomSuffix: false, allowOverwrite: true, contentType: "application/json" });
    return res.status(200).json({
      ok: true,
      state: finalState,
      syncVersion: finalState._syncVersion ?? null,
      hash: syncableHash(finalState),
    });
  } catch {
    return res.status(500).json({ error: "Error guardando en el almacenamiento." });
  }
}
