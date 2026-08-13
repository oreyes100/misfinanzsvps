// google-import.js — Importa imágenes de una carpeta de Google Drive (o álbum de
// Google Photos), las clasifica con IA y guarda un "batch" de propuestas en Blob.
//
// Fuentes:
//   - drive-public: carpeta de Drive compartida "pública" (sin OAuth). Lista vía
//     embeddedfolderview y descarga cada archivo por id.
//   - drive-api:   OAuth2 (ver google-auth.js) + Drive REST API.
//   - photos:      OAuth2 + Photos Library API (álbum compartido o de la librería).
//
// Por límites del plan (Hobby: timeout de función), el POST procesa un bloque por
// llamada (`limit`, por defecto 6). El cliente repite con `start` hasta `done`.
import { readJSON, writeJSON } from "./lib/blob-json.js";
import { allowedOrigin, cors } from "./lib/cors.js";
import { classifyImage } from "./lib/ai.js";
import { validSyncCode } from "./lib/state-store.js";
import { ensureGoogleTokens } from "./lib/google-tokens.js";

const IMG_MIME = /^(image\/(jpe?g|png|webp|gif|heic|heif)|application\/pdf)$/;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const batchKey = (code, id) => `ai-batches/${code}/${id}.json`;
const tokensKey = (code) => `google-tokens/${code}.json`;

const uid = () => Math.random().toString(36).slice(2, 12);

function b64(buffer) {
  return Buffer.from(buffer).toString("base64");
}

export const config = { maxDuration: 60 };

// ---------- Resolución de la lista de imágenes ----------

function driveFolderId(urlOrId) {
  const s = String(urlOrId || "");
  const m = s.match(/drive\.google\.com\/(?:drive\/)?folders\/([A-Za-z0-9_-]{6,})/);
  return m ? m[1] : (s.indexOf("/") === -1 ? s : null);
}

async function listDrivePublic(folderUrlOrId) {
  const id = driveFolderId(folderUrlOrId);
  if (!id) throw new Error("No pude leer el ID de la carpeta de Drive (revisa el enlace)");
  const html = await fetch(`https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(id)}#list`, {
    headers: { "User-Agent": "Mozilla/5.0" },
  }).then((r) => r.text());
  const ids = [...html.matchAll(/data-id="([A-Za-z0-9_-]{20,})"/g)].map((m) => m[1]);
  const names = [...html.matchAll(/flip-entry-title[^>]*>([^<]+)</g)].map((m) => m[1].trim());
  const files = ids.map((fid, i) => ({ id: fid, name: names[i] || fid, source: "drive-public" }));
  return files;
}

async function listDriveApi(syncCode, folderUrlOrId, apiKey) {
  const id = driveFolderId(folderUrlOrId);
  if (!id) throw new Error("No pude leer el ID de la carpeta de Drive");
  const tokens = await ensureGoogleTokens(syncCode);
  const attach = await readJSON(tokensKey(syncCode)); // para descargar alt=media
  if (!tokens?.access_token) throw new Error("Google no está vinculado (haz la conexión OAuth primero)");
  const q = `'${id}' in parents and (mimeType contains 'image/' or mimeType='application/pdf') and trashed=false`;
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id,name,mimeType,size)&pageSize=50`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  if (!res.ok) throw new Error("Error listando Drive (revisa el permiso del folder)");
  const data = await res.json();
  return (data.files || []).map((f) => ({
    id: f.id, name: f.name, mime: f.mimeType, source: "drive-api", size: f.size,
    tokens: attach || tokens,
  }));
}

async function listPhotos(syncCode, albumId, apiKey) {
  const tokens = await ensureGoogleTokens(syncCode);
  if (!tokens?.access_token) throw new Error("Google no está vinculado (haz la conexión OAuth primero)");
  const listPage = async (pageToken) => {
    const url = `https://photoslibrary.googleapis.com/v1/mediaItems:search${apiKey ? "?key=" + encodeURIComponent(apiKey) : ""}`;
    const body = { pageSize: 50, albumId: albumId || undefined, pageToken };
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokens.access_token}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error("Error leyendo el álbum de Google Photos");
    return res.json();
  };
  const items = [];
  let page;
  do {
    page = await listPage(page?.nextPageToken);
    for (const it of page.mediaItems || []) {
      if (!/^image\//.test(it.mimeType || "")) continue;
      items.push({ id: it.id, name: it.filename || it.id, mime: it.mimeType, source: "photos", baseUrl: it.baseUrl });
    }
  } while (page?.nextPageToken && items.length < 200);
  return items;
}

// ---------- Descarga ----------

async function downloadImage(file) {
  let url;
  if (file.source === "photos") {
    url = `${file.baseUrl}=d`; // =d fuerza descarga real del contenido
  } else if (file.source === "drive-api") {
    url = `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`;
  } else {
    url = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(file.id)}&export=download`;
  }
  const headers = file.source === "drive-api"
    ? { Authorization: `Bearer ${file.tokens?.access_token || ""}` }
    : {};
  const res = await fetch(url, { headers, redirect: "follow" });
  if (!res.ok) throw new Error(`Descarga falló (${res.status})`);
  const ctype = res.headers.get("content-type") || file.mime || "application/octet-stream";
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_IMAGE_BYTES) throw new Error("Archivo mayor de 8 MB");
  const mime = IMG_MIME.test(ctype) ? ctype : inferMime(file.name);
  if (!mime) throw new Error("No es una imagen o PDF");
  return { mime, base64: b64(buf), size: buf.length };
}

function inferMime(name) {
  const ext = String(name || "").split(".").pop().toLowerCase();
  const map = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", heic: "image/heic", heif: "image/heif", pdf: "application/pdf" };
  return map[ext] || null;
}

function buildSummary(result) {
  return {
    key: result.key,
    name: result.name,
    error: result.error,
    aiCode: result.aiCode,
    engine: result.engine,
    type: result.engine === "skipped" ? undefined : result.result?.type,
    date: result.result?.date || null,
    merchant: result.result?.merchant || null,
    total: result.result?.total || null,
    currency: result.result?.currency || null,
    description: result.result?.transactions?.[0]?.description || null,
    accountName: result.result?.accountName || null,
    accountId: result.result?.accountId || null,
    accountConfident: result.result?.accountConfident ?? false,
    confidence: result.result?.confidence ?? null,
    txCount: result.result?.transactions?.length || 0,
    accountHints: result.result?.accountHints || [],
    transactions: (result.result?.transactions || []).map((t) => ({
      description: t.description,
      amount: t.amount,
      direction: t.direction,
      category: t.category,
      date: t.date,
    })),
  };
}

export default async function handler(req, res) {
  const origin = allowedOrigin(req);
  cors(res, origin);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!origin || origin === "") return res.status(403).json({ error: "Origen no autorizado." });

  // ---- GET: diagnóstico / leer un batch ya guardado ----
  if (req.method === "GET") {
    const { syncCode, batchId, check } = req.query;
    if (!validSyncCode(syncCode)) return res.status(400).json({ error: "syncCode inválido" });
    if (check) {
      const tokens = await readJSON(tokensKey(syncCode));
      return res.status(200).json({
        ok: true,
        google: !!tokens?.access_token,
        scopes: (tokens?.scope || "").split(" ").filter(Boolean),
        envKeys: {
          GEMINI_API_KEY: !!process.env.GEMINI_API_KEY,
          OPENAI_API_KEY: !!process.env.OPENAI_API_KEY,
          ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
          AI_PROVIDER: process.env.AI_PROVIDER || null,
        },
      });
    }
    if (!batchId) return res.status(400).json({ error: "Faltan syncCode/batchId" });
    const batch = await readJSON(batchKey(syncCode, batchId));
    if (!batch) return res.status(404).json({ error: "Batch no encontrado" });
    return res.status(200).json({ batch });
  }

  if (req.method === "POST") {
    const body = req.body || {};
    const syncCode = String(body.syncCode || "").toLowerCase();
    if (!validSyncCode(syncCode)) return res.status(400).json({ error: "Código de sincronización inválido" });

    const source = ["drive-public", "drive-api", "photos"].includes(body.source) ? body.source : "drive-public";
    const provider = body.provider || process.env.AI_PROVIDER || "gemini";
    const apiKey = body.apiKey || process.env["GEMINI_API_KEY"] || process.env["OPENAI_API_KEY"] || process.env["ANTHROPIC_API_KEY"];
    if (!apiKey) return res.status(400).json({ error: "no_key", message: "Falta la clave de IA (Ajustes → IA o env)." });

    const start = Math.max(0, parseInt(body.start) || 0);
    const limit = Math.min(8, Math.max(1, parseInt(body.limit) || 6));
    const maxTotal = Math.min(200, Math.max(1, parseInt(body.max) || 40));

    let batch = body.batchId
      ? await readJSON(batchKey(syncCode, body.batchId))
      : null;
    if (!batch) {
      batch = {
        id: uid(), createdAt: Date.now(), updatedAt: Date.now(),
        syncCode, source, folderUrl: body.folderUrl || null, provider,
        items: [], status: "running",
      };
    }

    // Primera llamada: resolver la lista de archivos.
    if (batch.items.length === 0) {
      let files = [];
      try {
        if (source === "drive-public") files = await listDrivePublic(body.folderUrl || body.folderId || body.folder || "");
        else if (source === "drive-api") {
          const tokens = await readJSON(tokensKey(syncCode));
          files = await listDriveApi(syncCode, body.folderUrl || body.folderId || body.folder || "", apiKey)
            .then((list) => list.map((f) => ({ ...f, tokens })));
        } else {
          files = await listPhotos(syncCode, body.photoAlbumId || body.albumId || null, apiKey);
        }
      } catch (e) {
        return res.status(200).json({ ok: false, error: e.message || "Error listando archivos" });
      }
      files = files.filter((f) => IMG_MIME.test(f.mime || "") || inferMime(f.name));
      batch.items = files.slice(0, maxTotal).map((f, i) => ({
        key: `img-${i}`, name: f.name || f.id, file: f,
        status: "pending", result: null, error: null,
      }));
      batch.total = files.length;
    }

    // Procesar el bloque [start, start+limit).
    const slice = batch.items.slice(start, start + limit);

    for (const it of slice) {
      if (it.status === "done" || it.status === "error") continue;
      it.status = "processing";
      try {
        const img = await downloadImage(it.file);
        const result = await classifyImage(img, { provider, apiKey, model: body.model, categories: body.categories, accounts: body.accounts });
        it.result = result;
        it.status = "done";
        it.engine = provider;
      } catch (e) {
        it.status = "error";
        it.error = e.message || "Error de IA";
        it.aiCode = e.aiCode || null;
      }
    }

    const processed = batch.items.filter((i) => i.status === "done" || i.status === "error").length;
    batch.updatedAt = Date.now();
    if (processed >= batch.items.length) batch.status = "done";
    await writeJSON(batchKey(syncCode, batch.id), batch);

    const summaries = slice.map(buildSummary);
    return res.status(200).json({
      ok: true,
      batchId: batch.id,
      done: batch.status === "done",
      nextStart: start + slice.length,
      total: batch.items.length,
      processed,
      items: summaries,
    });
  }

  res.setHeader("Allow", "GET, POST");
  return res.status(405).json({ error: "Método no permitido." });
}