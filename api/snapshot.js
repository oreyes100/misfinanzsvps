// snapshot.js — Vercel Function: GET /api/snapshot (W18, paridad con server.mjs).
// Devuelve el estado completo + hash canónico + syncVersion para que el cliente
// decida convergencia (server = única fuente de verdad).
import { get } from "@vercel/blob";
import { syncableHash } from "./_hash.js";

const ID_RE = /^[a-z0-9-]{16,64}$/i;

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

export default async function handler(req, res) {
  const origin = allowedOrigin(req);
  if (origin && origin !== "same-origin") {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!origin || origin === "") return res.status(403).json({ error: "Origen no autorizado." });
  if (req.method !== "GET") return res.status(405).json({ error: "Método no permitido." });

  const id = String(req.query.id || "");
  if (!ID_RE.test(id)) return res.status(400).json({ error: "Código de sincronización inválido." });
  const key = `sync/${id.toLowerCase()}.json`;
  try {
    const result = await get(key, { access: "private", useCache: false });
    if (!result) return res.status(200).json({ found: false });
    const data = JSON.parse(await new Response(result.stream).text());
    const state = data.state;
    return res.status(200).json({
      found: true,
      state,
      hash: syncableHash(state),
      syncVersion: (state && state._syncVersion) ?? null,
      updatedAt: data.updatedAt,
    });
  } catch {
    return res.status(500).json({ error: "Error leyendo el almacenamiento." });
  }
}