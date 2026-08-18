// hermes.mjs — Agente Hermes: analiza repositorios de imágenes y registra
// transacciones automáticamente en Mis Finanzas (mismo motor SQLite).
//
// Modos:
//   node hermes.mjs           → bucle de escaneo (poll) del watchDir.
//   node hermes.mjs --once    → procesa pendientes y sale.
//   node hermes.mjs FILE      → procesa un archivo concreto y sale.
//   node hermes.mjs --journal → imprime las últimas entradas de la bitácora.
//   node hermes.mjs --config  → imprime la configuración efectiva.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendJournal, readJournal } from "./journal.mjs";
import { loadProcessorConfig, processImage, openDb } from "./processor.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.HERMES_CONFIG || path.join(HERE, "config.json");

const cfg = loadProcessorConfig(CONFIG_PATH);
const db = openDb(cfg.dbPath || undefined);

// Bloqueo de instancia única (evita procesos zombi compitiendo por los archivos).
const PID_FILE = path.join(HERE, ".hermes.pid");
function acquireSingleInstance() {
  if (fs.existsSync(PID_FILE)) {
    try {
      const pid = parseInt(fs.readFileSync(PID_FILE, "utf8"), 10);
      if (pid && pid !== process.pid) {
        try {
          process.kill(pid, 0); // ¿sigue vivo?
          console.error(`[hermes] ya hay una instancia activa (pid ${pid}); abortando`);
          process.exit(0);
        } catch {
          fs.unlinkSync(PID_FILE); // pid muerto, se puede continuar
        }
      }
    } catch {
      /* ignorar */
    }
  }
  fs.writeFileSync(PID_FILE, String(process.pid));
}
if (!process.argv[2] || !["--journal", "--config"].includes(process.argv[2])) {
  acquireSingleInstance();
  process.on("exit", () => {
    try {
      fs.unlinkSync(PID_FILE);
    } catch {
      /* ignorar */
    }
  });
}

function moveTo(file, dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.renameSync(file, path.join(dir, path.basename(file)));
}

// ---------- Flujo principal ----------

// Cooldown cuando Gemini rechaza por cuota: evita martillar la API.
let rateLimitUntil = 0;

async function processFile(file) {
  const base = path.basename(file);
  const lock = file + ".processing";
  if (Date.now() < rateLimitUntil) {
    return { ok: false, file: base, error: "rate_limit_cooldown" };
  }
  try {
    fs.renameSync(file, lock); // reclama el archivo para evitar doble proceso
  } catch {
    // el archivo desapareció entre el escaneo y aquí (carrera con el sync)
    console.warn(`[hermes] SKIP ${base}: archivo ya no disponible`);
    return { ok: false, file: base, error: "no disponible" };
  }

  try {
    const sourceBase = path.basename(file).replace(/\.processing$/, "");
    // Hermes reclama el archivo renombrándolo a X.jpeg.processing. El servidor
    // OCR maneja la extensión .processing con un temp copy; pasamos el lock.
    const imgPath = lock;

    const { ok, type, actions, report } = await processImage(db, cfg, imgPath, sourceBase);

    fs.mkdirSync(cfg.processedDir, { recursive: true });
    fs.renameSync(lock, path.join(cfg.processedDir, sourceBase));
    console.log(`[hermes] OK ${base} → ${type} (${actions.length} acciones)`);
    return { ok, file: base, type, actions, report };
  } catch (e) {
    const isRateLimit = /Límite de uso/i.test(String(e.message || ""));
    if (isRateLimit) {
      // Cuota de Gemini saturada: no es un fallo real. Se devuelve el archivo a
      // su nombre (sin moverlo a revisión) y se aplica un cooldown; el siguiente
      // poll lo reintentará.
      rateLimitUntil = Date.now() + 60000;
      try {
        fs.renameSync(lock, lock.replace(/\.processing$/, ""));
      } catch {
        /* el archivo pudo moverse a medias */
      }
      appendJournal(cfg.journalFile, { event: "deferred", file: base, error: String(e.message || e) });
      console.warn(`[hermes] DEFER ${base}: ${e.message}`);
      return { ok: false, file: base, error: "rate_limit_deferred" };
    }
    // devolver el archivo a su nombre y moverlo a revisión
    try {
      fs.renameSync(lock, lock.replace(/\.processing$/, ""));
      moveTo(lock.replace(/\.processing$/, ""), cfg.reviewDir);
    } catch {
      /* el archivo pudo moverse a medias */
    }
    appendJournal(cfg.journalFile, { event: "failed", file: base, error: String(e.message || e) });
    console.error(`[hermes] FAIL ${base}: ${e.message}`);
    return { ok: false, file: base, error: String(e.message || e) };
  }
}

function scanPendings() {
  if (!fs.existsSync(cfg.watchDir)) fs.mkdirSync(cfg.watchDir, { recursive: true });
  const entries = fs.readdirSync(cfg.watchDir, { recursive: true });

  // Nombres ya resueltos (procesados o en revisión): si un archivo vuelve a
  // aparecer en inbox es una re-copia estancada del sync; no debe reprocesarse.
  const doneNames = new Set();
  for (const dir of [cfg.processedDir, cfg.reviewDir]) {
    if (!fs.existsSync(dir)) continue;
    for (const e of fs.readdirSync(dir, { recursive: true })) {
      const full = path.join(dir, e);
      try {
        if (fs.statSync(full).isFile()) doneNames.add(String(e));
      } catch {
        /* ignorar */
      }
    }
  }
  // Archivos actualmente en procesamiento (hay un .processing activo del mismo base).
  const processingNames = new Set(
    entries.filter((e) => String(e).endsWith(".processing")).map((e) => String(e).replace(/\.processing$/, ""))
  );

  const files = [];
  for (const entry of entries) {
    const name = String(entry);
    if (name.startsWith(".") || name.endsWith(".processing")) continue;
    if (doneNames.has(name)) continue;
    if (processingNames.has(name)) continue;
    const full = path.join(cfg.watchDir, entry);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (![".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"].includes(path.extname(name).toLowerCase())) continue;
    files.push(full);
  }
  return files;
}

// Recupera archivos bloqueados por una interrupción previa (.processing huérfanos):
// se desbloquean y se mueven a revisión para no perder ni duplicar datos.
function recoverStaleLocks() {
  if (!fs.existsSync(cfg.watchDir)) return 0;
  const entries = fs.readdirSync(cfg.watchDir, { recursive: true });
  let recovered = 0;
  for (const entry of entries) {
    const full = path.join(cfg.watchDir, entry);
    if (!String(entry).endsWith(".processing")) continue;
    try {
      const st = fs.statSync(full);
      if (Date.now() - st.ctimeMs < 5 * 60 * 1000) continue; // aún joven; dar tiempo
      const clean = full.replace(/\.processing$/, "");
      fs.renameSync(full, clean);
      moveTo(clean, cfg.reviewDir);
      appendJournal(cfg.journalFile, { event: "recovered", file: path.basename(clean), note: "bloqueo huérfano movido a revisión" });
      recovered++;
    } catch {
      /* ignorar */
    }
  }
  return recovered;
}

async function main() {
  const arg = process.argv[2];

  if (arg === "--config") {
    console.log(JSON.stringify({ ...cfg, geminiKey: cfg.geminiKey ? "<set>" : null }, null, 2));
    return;
  }
  if (arg === "--journal") {
    console.log(JSON.stringify(readJournal(cfg.journalFile, 30), null, 2));
    return;
  }
  if (arg === "--once") {
    const recovered = recoverStaleLocks();
    if (recovered > 0) console.log(`[hermes] recuperados ${recovered} bloqueos huérfanos`);
    const pend = scanPendings();
    console.log(`[hermes] pendientes: ${pend.length}`);
    for (const f of pend) await processFile(f);
    return;
  }
  if (arg && !arg.startsWith("--")) {
    await processFile(arg);
    return;
  }

  // bucle de escaneo
  console.log(`[hermes] escaneando ${cfg.watchDir} cada ${cfg.pollIntervalMs}ms`);
  let tickRunning = false;
  const tick = async () => {
    if (tickRunning) return;
    tickRunning = true;
    try {
      for (const f of scanPendings()) await processFile(f);
    } finally {
      tickRunning = false;
    }
  };
  await tick();
  recoverStaleLocks();
  setInterval(() => {
    recoverStaleLocks();
    tick();
  }, cfg.pollIntervalMs);
}

main().catch((e) => {
  console.error("[hermes] fatal:", e);
  process.exit(1);
});