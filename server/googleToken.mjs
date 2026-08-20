// googleToken.mjs — Intercambio code→tokens EN EL SERVER (W3 Fase 1)
// Nunca expone client_secret al bundle. Soporta PKCE (code_verifier) y reutiliza GOOGLE_CLIENT_ID del server.
import { readFileSync } from "node:fs";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export async function handleGoogleToken(req, res, body) {
  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST" });
    return res.end(JSON.stringify({ error: "Método no permitido." }));
  }
  const { code, verifier, redirect_uri, code_verifier } = body || {};
  const cv = verifier || code_verifier;
  const ru = redirect_uri || body?.redirectUri;
  if (!code || !cv) {
    return json(res, 400, { error: "Faltan code y verifier." });
  }
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) {
    return json(res, 503, { error: "GOOGLE_CLIENT_ID no configurado en el servidor." });
  }
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || undefined;
  // redirect_uri debe coincidir con el registrado: https://dineroorganizado.duckdns.org/oauth/callback
  const redirectUri = ru || `${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host || req.headers["x-forwarded-host"] || "dineroorganizado.duckdns.org"}/oauth/callback`;

  const params = new URLSearchParams({
    code: String(code),
    client_id: clientId,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
    code_verifier: String(cv),
  });
  if (clientSecret) params.set("client_secret", clientSecret);

  let r;
  try {
    r = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
  } catch (e) {
    return json(res, 502, { error: "No se pudo contactar a Google.", detail: String(e.message || e) });
  }
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!r.ok) {
    return json(res, r.status, { error: "Intercambio con Google falló.", detail: data.error || data.error_description || text.slice(0, 300) });
  }
  // Validar que el scope concedido incluya photoslibrary.readonly (no más amplio que necesario)
  const scope = String(data.scope || "");
  if (scope && !scope.includes("photoslibrary.readonly")) {
    // no bloqueamos, pero log
    console.warn("[googleToken] scope sin photoslibrary.readonly:", scope);
  }
  return json(res, 200, data);
}

export async function handleGoogleConfig(req, res) {
  if (req.method !== "GET") {
    res.writeHead(405, { Allow: "GET" });
    return res.end(JSON.stringify({ error: "Método no permitido." }));
  }
  const clientId = process.env.GOOGLE_CLIENT_ID || "";
  return json(res, 200, {
    clientId,
    configured: !!clientId,
    scope: "https://www.googleapis.com/auth/photoslibrary.readonly",
  });
}
