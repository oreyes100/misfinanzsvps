// tokenSecurity.js — Cifrado AES-256-GCM de los tokens OAuth de Google Photos.
//
// Los tokens NUNCA viajan a la nube (quedan fuera de syncableSlice). Viven
// cifrados en localStorage bajo `mis-finazas-gphotos-tokens`. La clave AES se
// deriva por PBKDF2 (100k, SHA-256) de la sesión activa (username) + un salt
// aleatorio por cifrado. Sin sesión → los tokens no se pueden descifrar.
//
// El storage es inyectable para poder testearlo en Node (sin localStorage).

const ITERATIONS = 100_000;
const GCM_IV_LEN = 12;

function base64FromBytes(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function bytesFromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomSalt() {
  return base64FromBytes(crypto.getRandomValues(new Uint8Array(16)));
}

/** Deriva la clave AES-GCM de la sesión (username) + salt. */
async function deriveKey(username, salt) {
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(username),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: new TextEncoder().encode(salt), iterations: ITERATIONS, hash: "SHA-256" },
    base,
    256
  );
  return crypto.subtle.importKey("raw", bits, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

const defaultStorage = () => (typeof localStorage !== "undefined" ? localStorage : null);

export const TOKEN_KEY = "mis-finazas-gphotos-tokens";

/** ¿Hay tokens cifrados guardados? */
export function hasEncryptedTokens(storage = defaultStorage()) {
  return !!storage && !!storage.getItem(TOKEN_KEY);
}

/**
 * Cifra y guarda el payload de tokens. Requiere username (sesión activa).
 * @returns {Object} blob cifrado {v, salt, iv, data}
 */
export async function encryptTokens(payload, username, storage = defaultStorage()) {
  if (!payload || typeof payload !== "object") throw new Error("Payload de tokens inválido.");
  if (!username) throw new Error("Sin sesión activa: no se pueden cifrar los tokens.");
  if (!storage) throw new Error("Sin almacenamiento disponible para los tokens.");
  const salt = randomSalt();
  const key = await deriveKey(username, salt);
  const iv = crypto.getRandomValues(new Uint8Array(GCM_IV_LEN));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  const blob = {
    v: 1,
    salt,
    iv: base64FromBytes(iv),
    data: base64FromBytes(new Uint8Array(ciphertext)),
  };
  storage.setItem(TOKEN_KEY, JSON.stringify(blob));
  return blob;
}

/**
 * Descifra los tokens guardados. Devuelve el payload o null (sin tokens,
 * sesión inválida o MAC fallida — no se lanza, el caller decide reconectar).
 */
export async function decryptTokens(username, storage = defaultStorage()) {
  if (!storage) return null;
  const raw = storage.getItem(TOKEN_KEY);
  if (!raw) return null;
  let blob;
  try {
    blob = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!blob?.salt || !blob?.iv || !blob?.data) return null;
  if (!username) return null;
  try {
    const key = await deriveKey(username, blob.salt);
    const iv = bytesFromBase64(blob.iv);
    const data = bytesFromBase64(blob.data);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return null;
  }
}

/** Borra los tokens cifrados del dispositivo (desconexión). */
export function clearTokens(storage = defaultStorage()) {
  if (!storage) return;
  storage.removeItem(TOKEN_KEY);
}