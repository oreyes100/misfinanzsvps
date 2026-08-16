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
import { openDb } from "../db.mjs";
import { aiExtractFromFile } from "./gemini.mjs";
import { ocrImage } from "./ocr.mjs";
import * as apply from "./apply.mjs";
import { reviewStatement, reconcileEndingBalance } from "./review.mjs";
import { appendJournal, readJournal } from "./journal.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.HERMES_CONFIG || path.join(HERE, "config.json");

const IMAGE_EXT = [".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"];

function loadConfig() {
  const base = {
    syncCode: null,
    dbPath: null,
    watchDir: "/home/devops/obsidian-vault/images/inbox",
    processedDir: "/home/devops/obsidian-vault/images/processed",
    reviewDir: "/home/devops/obsidian-vault/images/review",
    journalFile: "/home/devops/hermes-agent/journal.jsonl",
    pollIntervalMs: 15000,
    maxAuditRounds: 3,
    folderAccountMap: {},
    geminiKey: null,
    ocrUrl: null,
  };
  if (fs.existsSync(CONFIG_PATH)) {
    Object.assign(base, JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")));
  }
  if (!base.syncCode) throw new Error("config.syncCode requerido");
  return base;
}

const cfg = loadConfig();
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

function effectiveGeminiKey(state) {
  return cfg.geminiKey || process.env.GEMINI_API_KEY || state.settings?.geminiKey || null;
}

function moveTo(file, dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.renameSync(file, path.join(dir, path.basename(file)));
}

function resolveAccountFor(state, result, file) {
  const byFolder = apply.findAccountByFolder(state, cfg.folderAccountMap, file, cfg.watchDir);
  if (byFolder) return byFolder;
  const hint = result.type === "transfer"
    ? `${result.transfer?.from || ""} ${result.transfer?.to || ""}`
    : result.merchant;
  return apply.findAccount(state, hint, state.transferAliases || {});
}

function r2(n) {
  return Math.round(n * 100) / 100;
}

// ---------- Procesamiento de cada tipo ----------

function handleReceipt(state, result, file, source) {
  const items = Array.isArray(result.items) ? result.items : [];
  if (items.length === 0) {
    if (!(result.total > 0)) throw new Error("recibo sin total ni ítems");
    const acc = resolveAccountFor(state, result, file);
    if (!acc) throw new Error("cuenta del recibo no resuelta");
    const tx = apply.addTransaction(state, {
      description: result.merchant || "Compra",
      amount: -r2(result.total),
      currency: acc.currency,
      accountId: acc.id,
      category: "Otros",
      date: result.date || null,
      notes: `Ingresado por Hermes desde recibo [${source}]`,
      auto: true,
    });
    return { state: tx, actions: [{ kind: "receipt", desc: result.merchant || "Compra", amount: -r2(result.total), accountId: acc.id }] };
  }

  const groups = new Map();
  for (const it of items) {
    const key = it.category || "Otros";
    const g = groups.get(key) || { category: key, total: 0, desc: [] };
    g.total = r2(g.total + Math.abs(it.amount || 0));
    g.desc.push(it.name);
    groups.set(key, g);
  }
  const acc = resolveAccountFor(state, result, file);
  if (!acc) throw new Error("cuenta del recibo no resuelta");

  let next = state;
  const actions = [];
  for (const g of groups.values()) {
    const amount = -r2(g.total);
    next = apply.addTransaction(next, {
      description: `${result.merchant || "Compra"} · ${g.desc.slice(0, 3).join(", ")}`,
      amount,
      currency: acc.currency,
      accountId: acc.id,
      category: g.category,
      date: result.date || null,
      notes: `Ingresado por Hermes desde recibo [${source}]`,
      auto: true,
    });
    actions.push({ kind: "receipt_item", category: g.category, amount, accountId: acc.id });
  }
  return { state: next, actions };
}

function handleTransfer(state, result, file, source) {
  const t = result.transfer;
  if (!t || !(t.amount > 0)) throw new Error("comprobante sin importe");
  const from = apply.findAccount(state, t.from, state.transferAliases || {});
  const to = apply.findAccount(state, t.to, state.transferAliases || {});
  if (!from || !to || from.id === to.id) {
    throw new Error(`cuentas de transferencia no resueltas: from="${t.from}" to="${t.to}"`);
  }
  const next = apply.addTransfer(state, {
    fromId: from.id,
    toId: to.id,
    amount: t.amount,
    date: result.date || null,
    notes: `Ingresado por Hermes desde comprobante [${source}]`,
  });
  return {
    state: next,
    actions: [
      { kind: "transfer_out", fromId: from.id, toId: to.id, amount: -r2(t.amount) },
      { kind: "transfer_in", fromId: from.id, toId: to.id, amount: r2(t.amount) },
    ],
  };
}

async function handleStatement(state, result, file, source) {
  const movements = Array.isArray(result.movements) ? result.movements.filter((m) => m && m.amount > 0) : [];
  if (movements.length === 0) throw new Error("extracto sin movimientos");
  const acc = resolveAccountFor(state, result, file);
  if (!acc) throw new Error("cuenta del estado de cuenta no resuelta");

  const geminiKey = effectiveGeminiKey(state);
  const categories = state.categories || [];

  // 1) Registrar movimientos que NO sean transferencias como transacciones directas.
  let current = state;
  const direct = [];
  for (const m of movements) {
    if (m.isTransfer) continue; // las transferencias se resuelven en la auditoría
    const amount = m.direction === "in" ? m.amount : -m.amount;
    current = apply.addTransaction(current, {
      description: m.description || "Movimiento",
      amount,
      currency: acc.currency,
      accountId: acc.id,
      category: m.category || null,
      date: m.date || null,
      notes: `Ingresado por Hermes desde estado de cuenta [${source}]`,
      auto: true,
    });
    direct.push({ kind: "statement_movement", amount, date: m.date, accountId: acc.id });
  }

  // 2) Revisión recursiva: audita contra lo registrado, aplica faltantes hasta cuadrar.
  const reviewed = await reviewStatement({
    state: current,
    account: acc,
    movements,
    geminiKey,
    categories,
    maxRounds: cfg.maxAuditRounds,
    source,
  });

  // 3) Reconciliación final al saldo del banco.
  const reconciled = reconcileEndingBalance({
    state: reviewed.state,
    accountId: acc.id,
    statementBalance: result.statementBalance,
    source,
  });

  return {
    state: reconciled.state,
    actions: [
      ...direct,
      ...reviewed.applied.map((a) => ({ kind: "audit_missing", amount: a.amount, date: a.date, desc: a.description })),
      ...(reconciled.applied ? [{ kind: "reconcile", diff: reconciled.diff }] : []),
    ],
    report: { round: reviewed.round, remaining: reviewed.remaining, truncated: !!reviewed.truncated, reconcile: reconciled.diff },
  };
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
    const state = apply.loadState(db, cfg.syncCode);
    const geminiKey = effectiveGeminiKey(state);
    if (!geminiKey) throw new Error("sin GEMINI key: pon settings.geminiKey en la app, config.geminiKey o env GEMINI_API_KEY");

    const sourceBase = path.basename(file).replace(/\.processing$/, "");

    // Paso OCR local (Unlimited-OCR): opcional, si falla no bloquea el flujo.
    let ocrText = null;
    if (cfg.ocrUrl) {
      try {
        ocrText = await ocrImage(lock, { url: cfg.ocrUrl });
        appendJournal(cfg.journalFile, { event: "ocr", file: base, chars: ocrText.length });
        console.log(`[hermes] OCR ${base} → ${ocrText.length} caracteres`);
      } catch (e) {
        console.warn(`[hermes] OCR skip ${base}: ${e.message}`);
      }
    }

    const result = await aiExtractFromFile(lock, geminiKey, {
      categories: state.categories || [],
      accounts: state.accounts || [],
      ocrText,
    });

    const baseCurrency = state.settings?.baseCurrency || "MXN";
    let next = state;
    let actions = [];
    let report = null;

    if (result.type === "receipt") {
      ({ state: next, actions } = handleReceipt(state, result, lock, sourceBase));
    } else if (result.type === "transfer") {
      ({ state: next, actions } = handleTransfer(state, result, lock, sourceBase));
    } else if (result.type === "statement") {
      ({ state: next, actions, report } = await handleStatement(state, result, lock, sourceBase));
    } else {
      throw new Error(`tipo no soportado: ${result.type}`);
    }

    const finalState = apply.saveState(db, cfg.syncCode, next);
    fs.mkdirSync(cfg.processedDir, { recursive: true });
    fs.renameSync(lock, path.join(cfg.processedDir, sourceBase));
    appendJournal(cfg.journalFile, {
      event: "processed",
      file: base,
      type: result.type,
      actions,
      report,
      newSyncVersion: finalState._syncVersion,
    });
    console.log(`[hermes] OK ${base} → ${result.type} (${actions.length} acciones)`);
    return { ok: true, file: base, type: result.type, actions, report };
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
    if (!IMAGE_EXT.includes(path.extname(name).toLowerCase())) continue;
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