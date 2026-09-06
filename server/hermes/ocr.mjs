// ocr.mjs — Cliente para el servidor local Unlimited-OCR (CPU).
// Extrae el texto bruto de una imagen (recibo / estado de cuenta) vía HTTP.
// Usa node:http en vez de fetch: la inferencia CPU tarda y fetch/undici
// impone un headersTimeout fijo de 300s que no se puede subir.
// W26: el timeout viene de aiConfig.json (clamp ≤60s). Antes: 20 min hardcodeados
// (causa documentada del bot "atascado").

import http from "node:http";
import { loadAIConfig } from "./aiClient.mjs";

export async function ocrImage(
  filePath,
  { url = "http://127.0.0.1:8765", mode = "gundam", timeoutMs } = {}
) {
  // W26: timeout desde aiConfig (ocr.timeoutMs) — nunca >60s.
  const cfg = loadAIConfig();
  // W39: el clamp puede subirlo vía OCR_TIMEOUT_MAX (el pipeline de PDFs de muchas
  // páginas necesita >60s por página; la regla W26 sigue por defecto).
  const effectiveTimeout = Math.min(Number(timeoutMs) || cfg.ocr.timeoutMs, Number(process.env.OCR_TIMEOUT_MAX) || 60_000);
  const u = new URL(url);
  const body = JSON.stringify({ image: filePath, mode });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port || 8765,
        path: u.pathname === "/" ? "/ocr" : `${u.pathname}/ocr`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: effectiveTimeout,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let out = {};
          try {
            out = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            /* body no JSON */
          }
          if (res.statusCode !== 200 || !out.ok) {
            return reject(new Error(`OCR server ${res.statusCode}: ${out.error || "error"}`));
          }
          resolve(out.text || "");
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error(`OCR server timeout (${effectiveTimeout}ms)`)));
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}