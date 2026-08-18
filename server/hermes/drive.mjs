// drive.mjs — Acceso a carpetas públicas de Google Drive (sin OAuth).
// Lista el contenido vía embeddedfolderview y descarga imágenes/PDFs.
// Es una evolución del scraper de api/google-import.js: Google cambió el HTML
// (ahora los IDs van en id="entry-<FILEID>", ya no data-id).

import fs from "node:fs";
import path from "node:path";

const UA = { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36" };
const MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".heic", ".heif", ".pdf"]);

export function driveFolderId(urlOrId) {
  const s = String(urlOrId || "");
  const m = s.match(/drive\.google\.com\/(?:drive\/)?folders\/([A-Za-z0-9_-]{6,})/);
  if (m) return m[1];
  const open = s.match(/drive\.google\.com\/open\?id=([A-Za-z0-9_-]{6,})/);
  if (open) return open[1];
  return s.indexOf("/") === -1 ? s : null;
}

function safeName(name) {
  const base = String(name || "archivo")
    .replace(/[^\w.\- ]/g, "_")
    .trim()
    .replace(/\s+/g, "_");
  return base.length > 120 ? base.slice(0, 120) : base;
}

/**
 * Lista los archivos de una carpeta pública de Drive.
 * @param {string} folderUrlOrId - Enlace o ID de la carpeta.
 * @returns {Promise<Array<{id:string, name:string, ext:string, isImage:boolean}>>}
 */
export async function listDrivePublic(folderUrlOrId) {
  const id = driveFolderId(folderUrlOrId);
  if (!id) throw new Error("No pude leer el ID de la carpeta de Drive (revisa el enlace)");
  const url = `https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(id)}#list`;
  const html = await fetch(url, { headers: UA }).then((r) => {
    if (!r.ok) throw new Error(`Drive respondió ${r.status}`);
    return r.text();
  });

  // Google usa dos formatos históricamente:
  //  - viejo: data-id="<ID>"
  //  - actual: <div class="flip-entry" id="entry-<ID>"
  let ids = [...html.matchAll(/data-id="([A-Za-z0-9_-]{20,})"/g)].map((m) => m[1]);
  if (ids.length === 0) {
    ids = [...html.matchAll(/id="entry-([A-Za-z0-9_-]{20,})"/g)].map((m) => m[1]);
  }
  const names = [...html.matchAll(/flip-entry-title[^>]*>([^<]+)</g)].map((m) => m[1].trim());

  return ids.map((fid, i) => {
    const name = names[i] || fid;
    const ext = path.extname(name).toLowerCase();
    return { id: fid, name, ext, isImage: IMAGE_EXT.has(ext) };
  });
}

/**
 * Descarga un archivo de Drive y lo guarda en disco.
 * @param {{id:string, name:string}} file
 * @param {string} dir - Directorio destino.
 * @returns {Promise<string>} Ruta absoluta del archivo descargado.
 */
export async function downloadDriveFile(file, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const url = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(file.id)}&export=download`;
  const res = await fetch(url, { headers: UA, redirect: "follow" });
  if (!res.ok) throw new Error(`Descarga falló (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error("Archivo mayor de 8 MB");
  if (buf.length === 0) throw new Error("Archivo vacío");
  const out = path.join(dir, safeName(file.name));
  fs.writeFileSync(out, buf);
  return out;
}

export function rmQuiet(file) {
  try {
    fs.unlinkSync(file);
  } catch {
    /* ignorar */
  }
}