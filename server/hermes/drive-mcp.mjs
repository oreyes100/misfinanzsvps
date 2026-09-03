// drive-mcp.mjs — Servidor MCP para el flujo Google Drive → Hermes → Mis Finanzas.
//
// Expone tools (para que Hermes Agent de Nous Research las invoque) y un modo
// watcher que vigila la carpeta pública de Drive por polling y procesa imágenes
// nuevas automáticamente (OCR → parseo → transacciones en SQLite).
//
// Uso:
//   node drive-mcp.mjs                     → arranca el servidor MCP (stdio).
//   node drive-mcp.mjs --watch             → modo daemon: procesa Drive solo.
//   node drive-mcp.mjs --sync              → un ciclo de sync y sale (para cron).
//   node drive-mcp.mjs --status            → imprime el estado del tracking.

import fs from "node:fs";
import path from "node:path";
import dns from "node:dns";
import { fileURLToPath } from "node:url";
import { loadProcessorConfig, processImage, openDb } from "./processor.mjs";
import { listDrivePublic, downloadDriveFile, rmQuiet, driveFolderId } from "./drive.mjs";
import { appendJournal } from "./journal.mjs";

// W29: el IPv6 del VPS está roto — forzar resolución IPv4 primero (si no, el
// fetch de Node a Google falla intermitentemente con "fetch failed").
dns.setDefaultResultOrder("ipv4first");

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.HERMES_CONFIG || path.join(HERE, "config.json");

const cfg = loadProcessorConfig(CONFIG_PATH);
const db = openDb(cfg.dbPath || undefined);
const drive = cfg.drive || {};
if (!drive.folderUrl) throw new Error("config.drive.folderUrl requerido (enlace o ID de la carpeta pública de Drive)");
const DOWNLOAD_DIR = drive.downloadDir || "/home/devops/drive-downloads";
const STATE_FILE = drive.stateFile || "/home/devops/drive-state.json";

// Configuración del bucle de reintentos (loop recursivo de corrección).
const MAX_ATTEMPTS = Math.max(1, drive.maxAttempts ?? 5);
const RETRY_BASE_MS = Math.max(1000, drive.retryBaseMs ?? 20000);
const RETRY_BACKOFF = drive.retryBackoff ?? 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Errores recuperables: no son definitivos, se reintentan con backoff.
const RETRYABLE = /ENOENT|no such file|timeout|timed out|L[ií]mite de uso|rate limit|429|500|502|503|socket|ECONNRESET|OCR server|imagen no encontrada|bad request/i;

function isRetryableError(e) {
  return RETRYABLE.test(String((e && e.message) || e));
}

function attemptsOf(failedEntry) {
  return (failedEntry && Number.isFinite(failedEntry.attempts) ? failedEntry.attempts : 0) || 0;
}

function nextRetryAt(failedEntry) {
  const n = attemptsOf(failedEntry);
  const backoff = RETRY_BASE_MS * Math.pow(RETRY_BACKOFF, n);
  const delay = Math.min(backoff, 10 * 60 * 1000);
  return Date.now() + delay;
}

// ---------- Tracking de archivos ya procesados ----------

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { processed: {}, failed: {} };
  }
}

function writeState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// Un archivo ya no se procesa si: fue procesado OK, o falló de forma definitiva
// (agotó los reintentos) y aún no le toca volver a intentarlo.
function alreadyDone(state, fileId) {
  if (state.processed[fileId]) return true;
  const failed = state.failed[fileId];
  if (!failed) return false;
  if (attemptsOf(failed) >= MAX_ATTEMPTS) return true;
  const at = failed.retryAt || 0;
  return at > Date.now(); // pendiente de reintento en el futuro -> no reintentar todavía
}

// ---------- Sync Drive → DB ----------

async function processFile(state, file) {
  let local = null;
  try {
    // Descargar con el nombre original del Drive para que el parser local
    // (que a veces detecta el banco por el nombre) no pierda contexto.
    local = await downloadDriveFile(file, DOWNLOAD_DIR);
    const sourceBase = file.name;
    const res = await processImage(db, cfg, local, sourceBase);
    delete state.failed[file.id];
    state.processed[file.id] = { name: file.name, at: new Date().toISOString(), type: res.type, actions: res.actions.length };
    return { ok: true, type: res.type, actions: res.actions.length };
  } catch (e) {
    const error = String((e && e.message) || e);
    const prev = state.failed[file.id] || {};
    const attempts = attemptsOf(prev) + 1;
    const entry = { name: file.name, at: new Date().toISOString(), error, attempts };
    if (attempts < MAX_ATTEMPTS && isRetryableError(e)) {
      // Error recuperable: lo programamos para reintento con backoff (loop).
      entry.retryAt = nextRetryAt(entry);
      state.failed[file.id] = entry;
      return { ok: false, retry: true, attempts, error, retryAt: entry.retryAt };
    }
    // Fallo definitivo (no recuperable o agotó intentos).
    state.failed[file.id] = entry;
    return { ok: false, retry: false, attempts, error };
  } finally {
    if (local) rmQuiet(local);
  }
}

async function syncOnce() {
  const state = readState();
  const folderId = driveFolderId(drive.folderUrl);
  const files = (await listDrivePublic(folderId)).filter((f) => f.isImage);
  const pendientes = files.filter((f) => !alreadyDone(state, f.id));

  const results = { total: files.length, nuevos: pendientes.length, ok: 0, fallidos: 0, reintentos: 0, errores: [] };

  for (const file of pendientes) {
    // Si es un reintento pendiente, respetar el backoff antes de volver a procesar.
    const prev = state.failed[file.id];
    const wait = (prev && prev.retryAt ? prev.retryAt - Date.now() : 0);
    if (wait > 0) {
      console.log(`[drive] ${file.name}: reintento programado en ${Math.round(wait / 1000)}s`);
      await sleep(Math.min(wait, 10000));
    }
    const r = await processFile(state, file);
    if (r.ok) {
      results.ok++;
      console.log(`[drive] OK ${file.name} → ${r.type} (${r.actions} acciones)`);
    } else if (r.retry) {
      results.reintentos++;
      console.warn(`[drive] RETRY ${file.name} (${r.attempts}/${MAX_ATTEMPTS}): ${r.error}`);
      results.errores.push({ file: file.name, error: r.error, attempts: r.attempts, retry: true });
    } else {
      results.fallidos++;
      results.errores.push({ file: file.name, error: r.error, attempts: r.attempts });
      console.error(`[drive] FAIL ${file.name}: ${r.error}`);
    }
    writeState(state);
  }

  appendJournal(cfg.journalFile, { event: "drive_sync", folderId, total: results.total, nuevos: results.nuevos, ok: results.ok, fallidos: results.fallidos, reintentos: results.reintentos, at: new Date().toISOString() });
  return results;
}

// ---------- Modo daemon ----------

async function watchLoop() {
  console.log(`[drive] vigilando ${drive.folderUrl} cada ${drive.pollIntervalMs || 30000}ms (reintentos: ${MAX_ATTEMPTS}, backoff ${RETRY_BASE_MS}ms)`);
  // Bucle secuencial: cada ciclo espera a que el anterior termine para no
  // procesar el mismo archivo dos veces en paralelo (causa ENOENT/duplicados).
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await syncOnce();
    } catch (e) {
      // W29: loggear la causa raíz (e.cause.code: ETIMEDOUT/ECONNRESET/UND_ERR...)
      console.error(`[drive] sync error: ${e.message} causa=${e.cause?.code || e.cause?.message || "n/a"}`);
    } finally {
      running = false;
    }
  };
  await tick();
  setInterval(tick, drive.pollIntervalMs || 30000);
}

// ---------- Modo MCP ----------

async function runMcp() {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { z } = await import("zod");

  const server = new McpServer({
    name: "hermes-drive",
    version: "1.0.0",
  });

  server.tool(
    "drive_list_pending",
    "Lista los archivos de imagen nuevos en la carpeta pública de Google Drive que aún no se han procesado.",
    { folderUrl: z.string().optional().describe("Enlace o ID de la carpeta. Por defecto usa config.drive.folderUrl.") },
    async ({ folderUrl }) => {
      const folderId = driveFolderId(folderUrl || drive.folderUrl);
      const files = (await listDrivePublic(folderId)).filter((f) => f.isImage);
      const state = readState();
      const pendientes = files.filter((f) => !alreadyDone(state, f.id));
      return {
        content: [{ type: "text", text: JSON.stringify({ total: files.length, pendientes: pendientes.map((f) => ({ id: f.id, name: f.name })) }, null, 2) }],
      };
    }
  );

  server.tool(
    "drive_process_pending",
    "Descarga y procesa todas las imágenes nuevas de la carpeta pública de Google Drive (OCR → parseo → transacciones en Mis Finanzas).",
    { folderUrl: z.string().optional().describe("Enlace o ID de la carpeta. Por defecto usa config.drive.folderUrl.") },
    async ({ folderUrl }) => {
      if (folderUrl) drive.folderUrl = folderUrl;
      const results = await syncOnce();
      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
      };
    }
  );

  server.tool(
    "drive_status",
    "Muestra el estado del tracking Drive→Hermes: total de archivos, procesados, fallidos y sus errores.",
    {},
    async () => {
      const state = readState();
      const processed = Object.values(state.processed);
      const failed = Object.values(state.failed);
      return {
        content: [{ type: "text", text: JSON.stringify({ procesados: processed.length, fallidos: failed.length, ultimosProcesados: processed.slice(-5), errores: failed }, null, 2) }],
      };
    }
  );

  server.tool(
    "drive_retry_failed",
    "Reintenta procesar los archivos de Google Drive que fallaron anteriormente (o que están pendientes de reintento por backoff).",
    {},
    async () => {
      const state = readState();
      const failedIds = Object.keys(state.failed);
      const folderId = driveFolderId(drive.folderUrl);
      const files = await listDrivePublic(folderId);
      // Reintentar todos los fallidos, ignorando el backoff programado.
      const retry = files.filter((f) => failedIds.includes(f.id) && f.isImage);
      const results = { reintentos: retry.length, ok: 0, fallidos: 0, pendientes: 0, errores: [] };
      for (const file of retry) {
        delete state.failed[file.id];
        const r = await processFile(state, file);
        if (r.ok) {
          results.ok++;
          console.log(`[drive] OK ${file.name} → ${r.type} (${r.actions} acciones)`);
        } else if (r.retry) {
          results.pendientes++;
          results.errores.push({ file: file.name, error: r.error, attempts: r.attempts, retry: true });
          console.warn(`[drive] RETRY ${file.name} (${r.attempts}/${MAX_ATTEMPTS}): ${r.error}`);
        } else {
          results.fallidos++;
          results.errores.push({ file: file.name, error: r.error, attempts: r.attempts });
          console.error(`[drive] FAIL ${file.name}: ${r.error}`);
        }
        writeState(state);
      }
      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
      };
    }
  );

server.tool(
    "image_process_local",
    "Procesa una imagen local (ruta absoluta de archivo) y registra las transacciones detectadas en Mis Finanzas (OCR → parseo → alta). Úsalo cuando el usuario envía una foto de recibo/transferencia/estado de cuenta por un canal (p. ej. Telegram).",
    {
      imagePath: z.string().describe("Ruta absoluta a la imagen local (jpg/png/webp) a procesar."),
      sourceBase: z.string().optional().describe("Nombre de origen para el registro (por defecto el nombre del archivo)."),
    },
    async ({ imagePath, sourceBase }) => {
      const resolved = path.resolve(imagePath);
      if (!fs.existsSync(resolved)) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `imagen no encontrada: ${resolved}` }, null, 2) }] };
      }
      try {
        const res = await processImage(db, cfg, resolved, sourceBase || path.basename(resolved));
        appendJournal(cfg.journalFile, { event: "telegram_image_processed", file: sourceBase || path.basename(resolved), type: res.type, actions: res.actions.length, at: new Date().toISOString() });
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, type: res.type, actions: res.actions, report: res.report || null }, null, 2) }],
        };
      } catch (e) {
        const error = String((e && e.message) || e);
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error }, null, 2) }] };
      }
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ---------- CLI ----------

async function main() {
  const arg = process.argv[2];
  if (arg === "--watch") return watchLoop();
  if (arg === "--sync") {
    const results = await syncOnce();
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  if (arg === "--status") {
    const state = readState();
    console.log(JSON.stringify({ procesados: Object.keys(state.processed).length, fallidos: Object.keys(state.failed).length, errores: Object.values(state.failed) }, null, 2));
    return;
  }
  return runMcp();
}

main().catch((e) => {
  console.error("[drive-mcp] fatal:", e);
  process.exit(1);
});