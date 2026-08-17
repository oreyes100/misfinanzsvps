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
import { fileURLToPath } from "node:url";
import { loadProcessorConfig, processImage, openDb } from "./processor.mjs";
import { listDrivePublic, downloadDriveFile, rmQuiet, driveFolderId } from "./drive.mjs";
import { appendJournal } from "./journal.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.HERMES_CONFIG || path.join(HERE, "config.json");

const cfg = loadProcessorConfig(CONFIG_PATH);
const db = openDb(cfg.dbPath || undefined);
const drive = cfg.drive || {};
if (!drive.folderUrl) throw new Error("config.drive.folderUrl requerido (enlace o ID de la carpeta pública de Drive)");
const DOWNLOAD_DIR = drive.downloadDir || "/home/devops/drive-downloads";
const STATE_FILE = drive.stateFile || "/home/devops/drive-state.json";

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

function alreadyDone(state, fileId) {
  return !!(state.processed[fileId] || state.failed[fileId]);
}

// ---------- Sync Drive → DB ----------

async function syncOnce() {
  const state = readState();
  const folderId = driveFolderId(drive.folderUrl);
  const files = (await listDrivePublic(folderId)).filter((f) => f.isImage);
  const pendientes = files.filter((f) => !alreadyDone(state, f.id));

  const results = { total: files.length, nuevos: pendientes.length, ok: 0, fallidos: 0, errores: [] };

  for (const file of pendientes) {
    let local = null;
    try {
      // Descargar con el nombre original del Drive para que el parser local
      // (que a veces detecta el banco por el nombre) no pierda contexto.
      local = await downloadDriveFile(file, DOWNLOAD_DIR);
      const sourceBase = file.name;
      const res = await processImage(db, cfg, local, sourceBase);
      state.processed[file.id] = { name: file.name, at: new Date().toISOString(), type: res.type, actions: res.actions.length };
      results.ok++;
      console.log(`[drive] OK ${file.name} → ${res.type} (${res.actions.length} acciones)`);
    } catch (e) {
      state.failed[file.id] = { name: file.name, at: new Date().toISOString(), error: String(e.message || e) };
      results.fallidos++;
      results.errores.push({ file: file.name, error: String(e.message || e) });
      console.error(`[drive] FAIL ${file.name}: ${e.message}`);
    } finally {
      if (local) rmQuiet(local);
    }
  }

  writeState(state);
  appendJournal(cfg.journalFile, { event: "drive_sync", folderId, total: results.total, nuevos: results.nuevos, ok: results.ok, fallidos: results.fallidos, at: new Date().toISOString() });
  return results;
}

// ---------- Modo daemon ----------

async function watchLoop() {
  console.log(`[drive] vigilando ${drive.folderUrl} cada ${drive.pollIntervalMs || 30000}ms`);
  await syncOnce();
  setInterval(() => {
    syncOnce().catch((e) => console.error(`[drive] sync error: ${e.message}`));
  }, drive.pollIntervalMs || 30000);
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
    "Reintenta procesar los archivos de Google Drive que fallaron anteriormente.",
    {},
    async () => {
      const state = readState();
      const failedIds = Object.keys(state.failed);
      const folderId = driveFolderId(drive.folderUrl);
      const files = await listDrivePublic(folderId);
      const retry = files.filter((f) => failedIds.includes(f.id) && f.isImage);
      const results = { reintentos: retry.length, ok: 0, fallidos: 0, errores: [] };
      for (const file of retry) {
        delete state.failed[file.id];
        let local = null;
        try {
          local = await downloadDriveFile(file, DOWNLOAD_DIR);
          const res = await processImage(db, cfg, local, file.name);
          state.processed[file.id] = { name: file.name, at: new Date().toISOString(), type: res.type, actions: res.actions.length };
          results.ok++;
        } catch (e) {
          state.failed[file.id] = { name: file.name, at: new Date().toISOString(), error: String(e.message || e) };
          results.fallidos++;
          results.errores.push({ file: file.name, error: String(e.message || e) });
        } finally {
          if (local) rmQuiet(local);
        }
      }
      writeState(state);
      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
      };
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