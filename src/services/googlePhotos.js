// googlePhotos.js — OAuth 2.0 PKCE (S256) contra Google Photos, 100% client-side.
//
// Flujo full-page redirect: el usuario pulsa "Conectar" → startAuth() guarda el
// PKCE (verifier+state) y navega a la pantalla de Google → Google vuelve a
// `${origin}/oauth/callback?code=...&state=...` → nginx sirve el SPA (try_files)
// → App.jsx llama handleOAuthCallback() → exchange por tokens → se cifran con
// tokenSecurity. Solo los metadatos viajan a la nube; los tokens NUNCA.

import { clearTokens, decryptTokens, encryptTokens } from "./tokenSecurity.js";
import { currentSession } from "../auth.js";

export const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const REVOKE_ENDPOINT = "https://oauth2.googleapis.com/revoke";
export const USERINFO_ENDPOINT = "https://openidconnect.googleapis.com/v1/userinfo";
export const PHOTOS_SCOPE = "https://www.googleapis.com/auth/photoslibrary.readonly";

const PKCE_KEY = "mis-finazas-gphotos-pkce";
const PKCE_MAX_AGE_MS = 10 * 60 * 1000; // 10 min

/** Client ID de la consola de Google. Vacío → sin configurar. */
export function clientId() {
  return (typeof import.meta !== "undefined" && import.meta.env?.VITE_GOOGLE_PHOTOS_CLIENT_ID) || "";
}

export function isConfigured() {
  return !!clientId();
}

/** URI de retorno. El server sirve index.html para cualquier ruta (try_files). */
export function redirectUri() {
  return `${window.location.origin}/oauth/callback`;
}

function randomHex(len) {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function generateVerifier() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const arr = new Uint8Array(64);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => chars[b % chars.length]).join("");
}

function base64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function codeChallenge(verifier) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

/**
 * Inicia el flujo OAuth: genera PKCE, lo persiste y navega a Google.
 * Lanza si no hay client ID configurado.
 */
export async function startAuth() {
  const cid = clientId();
  if (!cid) throw new Error("VITE_GOOGLE_PHOTOS_CLIENT_ID no está configurado.");
  const verifier = generateVerifier();
  const state = randomHex(16);
  const challenge = await codeChallenge(verifier);
  localStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state, ts: Date.now() }));
  const params = new URLSearchParams({
    client_id: cid,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: `${PHOTOS_SCOPE} openid email`,
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  window.location.href = `${AUTH_ENDPOINT}?${params.toString()}`;
}

/** Extrae {code, state, error} de la query string de retorno. */
export function parseCallbackParams(search) {
  const p = new URLSearchParams(search || "");
  return {
    code: p.get("code"),
    state: p.get("state"),
    error: p.get("error"),
    error_description: p.get("error_description"),
  };
}

/**
 * Procesa el retorno del OAuth (se llama desde App.jsx al montar).
 * Intercambia el code por tokens, los cifra y devuelve el resultado.
 * @returns {Promise<{ok:boolean, email?:string, reason?:string, message?:string}>}
 */
export async function handleOAuthCallback(search = window.location.search) {
  const { code, state, error } = parseCallbackParams(search);
  if (!code && !error) return { ok: false, reason: "no_callback" };

  if (error) return { ok: false, reason: "oauth_error", message: error };

  let pkce = null;
  try {
    pkce = JSON.parse(localStorage.getItem(PKCE_KEY) || "null");
  } catch {}
  if (!pkce || pkce.state !== state) return { ok: false, reason: "state_mismatch" };
  if (Date.now() - pkce.ts > PKCE_MAX_AGE_MS) return { ok: false, reason: "expired" };
  localStorage.removeItem(PKCE_KEY);

  const cid = clientId();
  const username = currentSession()?.username;
  if (!cid) return { ok: false, reason: "not_configured" };
  if (!username) return { ok: false, reason: "no_session" };

  const params = new URLSearchParams({
    code,
    client_id: cid,
    redirect_uri: redirectUri(),
    grant_type: "authorization_code",
    code_verifier: pkce.verifier,
  });
  let r;
  try {
    r = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
  } catch {
    return { ok: false, reason: "network_error" };
  }
  if (!r.ok) return { ok: false, reason: "exchange_failed", message: `token ${r.status}` };

  let data;
  try {
    data = await r.json();
  } catch {
    return { ok: false, reason: "exchange_failed" };
  }
  if (!data.access_token) return { ok: false, reason: "exchange_failed", message: "sin access_token" };

  const payload = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || null,
    expires_at: Date.now() + (data.expires_in || 3600) * 1000,
    scope: data.scope || PHOTOS_SCOPE,
  };
  await encryptTokens(payload, username);

  // Email/name del usuario (scope openid email) — para mostrarlo en Ajustes.
  let email = null;
  try {
    const u = await fetch(USERINFO_ENDPOINT, { headers: { Authorization: `Bearer ${data.access_token}` } });
    if (u.ok) {
      const profile = await u.json();
      email = profile.email || null;
    }
  } catch {}

  return { ok: true, email };
}

/**
 * Devuelve un access token válido, refrescándolo si expiró y hay refresh_token.
 * null si no hay tokens descifrables o el refresh falló.
 */
export async function getAccessToken() {
  const username = currentSession()?.username;
  if (!username) return null;
  const tokens = await decryptTokens(username);
  if (!tokens?.access_token) return null;

  const needsRefresh = tokens.expires_at && Date.now() > tokens.expires_at - 60_000;
  if (!needsRefresh) return tokens.access_token;
  if (!tokens.refresh_token) return null;

  const cid = clientId();
  if (!cid) return null;
  const params = new URLSearchParams({
    client_id: cid,
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
  });
  try {
    const r = await fetch(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    if (!r.ok) return null;
    const data = await r.json();
    if (!data.access_token) return null;
    const updated = { ...tokens, access_token: data.access_token, expires_at: Date.now() + (data.expires_in || 3600) * 1000 };
    await encryptTokens(updated, username);
    return data.access_token;
  } catch {
    return null;
  }
}

/** Revoca el token en Google y borra el cifrado local. */
export async function revokeTokens() {
  const username = currentSession()?.username;
  const tokens = username ? await decryptTokens(username) : null;
  if (tokens?.access_token) {
    try {
      await fetch(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(tokens.access_token)}`, { method: "POST" });
    } catch {}
  }
  clearTokens();
}