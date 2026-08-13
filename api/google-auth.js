// google-auth.js — OAuth2 de Google (Drive / Photos) para acceder a la carpeta
// de imágenes y clasificarlas con IA.
//
//   GET /api/google-auth?syncCode=XXX&scope=drive
//       → { connected:true } | { connected:false, authUrl }
//   GET /api/google-auth?syncCode=XXX&scope=drive&code=....&state=XXX
//       → callback de Google: intercambia el code por tokens y los guarda.
//
// Requiere variables de entorno GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET.
// redirect_uri = https://<dominio>/api/google-auth (debe estar registrado en
// Google Cloud Console).
import { allowedOrigin, cors } from "../lib/cors.js";
import { validSyncCode } from "../lib/state-store.js";
import { getGoogleTokens, saveGoogleTokens } from "../lib/google-tokens.js";

const SCOPES = {
  drive: "https://www.googleapis.com/auth/drive.readonly",
  photos: "https://www.googleapis.com/auth/photoslibrary.readonly",
};

export const config = { maxDuration: 20 };

function appOrigin(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers.host || req.headers["x-forwarded-host"];
  return `${proto}://${host}`;
}

function buildAuthUrl(syncCode, scope, redirectUri) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: `${SCOPES.drive} ${SCOPES.photos}`,
    state: `${syncCode}:${scope}`,
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

async function exchangeCode(code, redirectUri) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    code,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!res.ok) throw new Error(`Intercambio de token falló (${res.status})`);
  const data = await res.json();
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
    fetched_at: Date.now(),
    scope: data.scope,
  };
}

export default async function handler(req, res) {
  const origin = allowedOrigin(req);
  cors(res, origin);

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Método no permitido." });
  }

  const syncCode = String((req.query?.syncCode || req.query?.state || "").split(":")[0]).toLowerCase();
  if (!validSyncCode(syncCode)) {
    return res.status(200).json({ ok: false, oauthAvailable: hasCreds(), error: "no_sync" });
  }

  const redirectUri = `${appOrigin(req)}/api/google-auth`;

  // Callback de Google: code + state en la URL.
  const code = req.query?.code;
  if (code) {
    try {
      const tokens = await exchangeCode(code, redirectUri);
      await saveGoogleTokens(syncCode, tokens);
      const ok = !!tokens.access_token;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end(
        `<!doctype html><html lang="es"><body style="font-family:system-ui;background:#0b1426;color:#e2e8f0;display:grid;place-items:center;height:100vh">
        <div style="text-align:center"><h1>${ok ? "✓ Google conectado" : "Error en la conexión"}</h1>
        <p>${ok ? "Cierra esta pestaña y vuelve a la app." : "No se guardaron los permisos. Reintenta."}</p></div></body></html>`
      );
    } catch (e) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.end(`<!doctype html><html lang="es"><body style="font-family:system-ui">Conexión con Google falló: ${e.message}</body></html>`);
    }
  }

  // Diagnóstico.
  const connected = !!(await getGoogleTokens(syncCode));
  if (connected) return res.status(200).json({ ok: true, connected: true });
  if (!hasCreds()) {
    return res.status(200).json({ ok: false, connected: false, oauthAvailable: false, error: "no_creds" });
  }
  return res.status(200).json({
    ok: true,
    connected: false,
    oauthAvailable: true,
    authUrl: buildAuthUrl(syncCode, req.query?.scope === "photos" ? "photos" : "drive", redirectUri),
  });
}

function hasCreds() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}