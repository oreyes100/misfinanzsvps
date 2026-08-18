// evidence.mjs — GET /api/evidence/:name (WG11).
// Sirve imágenes de evidencia OCR (transacciones conflictivas) que Hermes
// guardó en cfg.evidenceDir. El nombre se valida contra path traversal.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function evidenceDir() {
  try {
    const cfg = JSON.parse(readFileSync(path.join(HERE, "hermes", "config.json"), "utf8"));
    if (cfg.evidenceDir) return cfg.evidenceDir;
  } catch {}
  return path.join(HERE, "hermes", "evidence");
}

const MIME = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".pdf": "application/pdf",
};

export async function sendEvidence(req, res, name) {
  // Solo nombre de archivo plano: sin separadores → bloquea traversal.
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith(".")) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ error: "Nombre de evidencia inválido." }));
  }
  const dir = evidenceDir();
  const filePath = path.join(dir, name);
  if (!existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ error: "Evidencia no encontrada." }));
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Cache-Control": "private, max-age=3600",
  });
  return res.end(readFileSync(filePath));
}
