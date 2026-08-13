// blob-json.js — lecturas/escrituras JSON privadas sobre Vercel Blob.
// Mismo patrón que api/sync.js y api/users.js (access: private, sin sufijo aleatorio).
import { get, put } from "@vercel/blob";

const MAX_BYTES = 4_000_000;

export async function readJSON(key) {
  try {
    const result = await get(key, { access: "private", useCache: false });
    if (!result) return null;
    const text = await new Response(result.stream).text();
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function writeJSON(key, data) {
  const payload = JSON.stringify(data);
  if (Buffer.byteLength(payload) > MAX_BYTES) {
    throw new Error("Payload demasiado grande para Blob");
  }
  await put(key, payload, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
  });
  return true;
}