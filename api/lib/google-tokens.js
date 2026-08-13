// google-tokens.js — almacenamiento y renovación de tokens OAuth de Google
// por syncCode (clave privada Blob: google-tokens/{syncCode}.json).
import { readJSON, writeJSON } from "./blob-json.js";

const tokensKey = (code) => `google-tokens/${String(code).toLowerCase()}.json`;

export async function getGoogleTokens(syncCode) {
  const data = await readJSON(tokensKey(syncCode));
  return data?.tokens || null;
}

export async function saveGoogleTokens(syncCode, tokens) {
  await writeJSON(tokensKey(syncCode), { syncCode, tokens, updatedAt: Date.now() });
}

async function exchangeRefresh(refreshToken) {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret || !refreshToken) return null;
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.access_token) return null;
  return { access_token: data.access_token, expires_in: data.expires_in || 3600, fetched_at: Date.now() };
}

/** Si el access_token está caducado (margen 5 min), lo renueva con refresh_token. */
export async function ensureGoogleTokens(syncCode) {
  const tokens = await getGoogleTokens(syncCode);
  if (!tokens) return null;
  const expiresAt = (tokens.fetched_at || Date.now()) + ((tokens.expires_in || 3600) - 300) * 1000;
  if (Date.now() < expiresAt) return tokens;
  const fresh = await exchangeRefresh(tokens.refresh_token);
  if (!fresh) return tokens; // sin refresh_token o falló → devolver viejos
  const next = { ...tokens, ...fresh };
  await saveGoogleTokens(syncCode, next);
  return next;
}