// processor.mjs — Núcleo reutilizable del pipeline Hermes.
// Encapsula el flujo completo: OCR local → parseo local → respaldo Gemini →
// dispatch por tipo (recibo / transferencia / estado de cuenta) → persistencia
// en SQLite. Lo usa hermes.mjs (carpeta local) y drive-mcp.mjs (Google Drive).

import fs from "node:fs";
import path from "node:path";
import { openDb } from "../db.mjs";
import { aiExtractFromFile } from "./gemini.mjs";
import { ocrImage } from "./ocr.mjs";
import { parseOcrText } from "./local.mjs";
import * as apply from "./apply.mjs";
import { reviewStatement, reviewStatementLocal, reconcileEndingBalance } from "./review.mjs";
import { appendJournal } from "./journal.mjs";

export const IMAGE_EXT = [".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"];

export function loadProcessorConfig(configPath, overrides = {}) {
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
    bankAccountMap: {},
    geminiKey: null,
    ocrUrl: null,
    // Sección Drive (usada por drive-mcp.mjs):
    drive: {
      folderUrl: null,
      downloadDir: "/home/devops/drive-downloads",
      stateFile: "/home/devops/drive-state.json",
      pollIntervalMs: 30000,
      enabled: true,
    },
  };
  if (fs.existsSync(configPath)) {
    const file = JSON.parse(fs.readFileSync(configPath, "utf8"));
    for (const k of Object.keys(base)) {
      if (file[k] !== undefined) {
        base[k] = typeof base[k] === "object" && base[k] !== null && !Array.isArray(base[k]) && typeof file[k] === "object" && file[k] !== null
          ? { ...base[k], ...file[k] }
          : file[k];
      }
    }
  }
  Object.assign(base, overrides);
  if (!base.syncCode) throw new Error("config.syncCode requerido");
  return base;
}

function effectiveGeminiKey(cfg, state) {
  return cfg.geminiKey || process.env.GEMINI_API_KEY || state.settings?.geminiKey || null;
}

function r2(n) {
  return Math.round(n * 100) / 100;
}

function resolveAccountFor(cfg, state, result, file) {
  const byFolder = apply.findAccountByFolder(state, cfg.folderAccountMap, file, cfg.watchDir);
  if (byFolder) return byFolder;
  if (result.merchant && cfg.bankAccountMap) {
    // Coincidencia por token (p. ej. "BBVA MEXICO (CTA **3167)" -> "bbva"),
    // no solo por clave exacta, para capturar cuentas que mencionan el banco.
    const text = String(result.merchant).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const tokens = text.split(/[^\p{L}\p{N}]+/u).filter((s) => s.length >= 3);
    for (const [key, mapped] of Object.entries(cfg.bankAccountMap)) {
      const k = String(key).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      if (text === k || tokens.includes(k) || text.includes(k)) {
        const acc = (state.accounts || []).find((a) => a.id === mapped || a.name === mapped);
        if (acc) return acc;
      }
    }
  }
  const hint = result.type === "transfer"
    ? `${result.transfer?.from || ""} ${result.transfer?.to || ""}`
    : result.merchant;
  return apply.findAccount(state, hint, state.transferAliases || {});
}

// ---------- Handlers por tipo (idénticos a hermes.mjs) ----------

function handleReceipt(cfg, state, result, file, source) {
  const items = Array.isArray(result.items) ? result.items : [];
  const acc = resolveAccountFor(cfg, state, result, file);
  if (!acc) throw new Error("cuenta del recibo no resuelta");

  // Si los ítems no traen montos (tickets: importes en columnas separadas que
  // el OCR no empareja con el producto), usamos el TOTAL del recibo como una
  // sola transacción.
  const itemTotal = r2(items.reduce((s, it) => s + Math.abs(it.amount || 0), 0));
  if (items.length === 0 || itemTotal <= 0) {
    if (!(result.total > 0)) throw new Error("recibo sin total ni ítems");
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

function handleTransfer(cfg, state, result, file, source) {
  const t = result.transfer;
  if (!t || !(t.amount > 0)) throw new Error("comprobante sin importe");

  // Resolver ambas puntas. Si alguna no resuelve a una cuenta propia, en lugar
  // de fallar se degrada a un movimiento simple (egreso/ingreso) en la cuenta
  // que sí se conozca; el texto de la contraparte queda en la descripción.
  const aliases = state.transferAliases || {};
  const from = apply.findAccount(state, t.from, aliases) || resolveAccountFor(cfg, state, { merchant: t.from, transfer: t, type: "transfer" }, file);
  const to = apply.findAccount(state, t.to, aliases) || resolveAccountFor(cfg, state, { merchant: t.to, transfer: t, type: "transfer" }, file);

  if (from && to && from.id !== to.id) {
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

  // Degradación: una sola punta conocida -> movimiento simple en esa cuenta.
  const acc = from || to;
  if (acc) {
    const out = !!from; // salió de la cuenta conocida -> egreso
    const amount = out ? -r2(t.amount) : r2(t.amount);
    const counterpart = out ? t.to : t.from;
    const next = apply.addTransaction(state, {
      description: counterpart ? `Transferencia ${out ? "a" : "desde"} ${counterpart}` : "Transferencia",
      amount,
      currency: acc.currency,
      accountId: acc.id,
      category: "Otros",
      date: result.date || null,
      notes: `Ingresado por Hermes desde comprobante [${source}]`,
      auto: true,
    });
    return {
      state: next,
      actions: [{ kind: out ? "transfer_out" : "transfer_in", accountId: acc.id, amount, counterpart }],
    };
  }

  throw new Error(`cuentas de transferencia no resueltas: from="${t.from}" to="${t.to}"`);
}

async function handleStatement(cfg, state, result, file, source) {
  const movements = Array.isArray(result.movements) ? result.movements.filter((m) => m && m.amount > 0) : [];
  if (movements.length === 0) throw new Error("extracto sin movimientos");
  const acc = resolveAccountFor(cfg, state, result, file);
  if (!acc) throw new Error("cuenta del estado de cuenta no resuelta");

  const geminiKey = effectiveGeminiKey(cfg, state);
  const categories = state.categories || [];

  let current = state;
  const direct = [];
  for (const m of movements) {
    if (m.isTransfer) continue;
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

  const reviewed = await reviewStatement({
    state: current,
    account: acc,
    movements,
    geminiKey,
    categories,
    maxRounds: cfg.maxAuditRounds,
    source,
  });

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

async function handleStatementLocal(cfg, state, result, file, source) {
  const movements = Array.isArray(result.movements) ? result.movements.filter((m) => m && m.amount > 0) : [];
  if (movements.length === 0) throw new Error("extracto sin movimientos");
  const acc = resolveAccountFor(cfg, state, result, file);
  if (!acc) throw new Error("cuenta del estado de cuenta no resuelta");

  const reviewed = await reviewStatementLocal({
    state,
    account: acc,
    movements,
    source,
  });

  const reconciled = reconcileEndingBalance({
    state: reviewed.state,
    accountId: acc.id,
    statementBalance: result.statementBalance,
    source,
  });

  const actions = [
    ...reviewed.applied.map((a) => ({ kind: "statement_movement", amount: a.amount, date: a.date, desc: a.description, accountId: acc.id })),
    ...(reconciled.applied ? [{ kind: "reconcile", diff: reconciled.diff }] : []),
  ];
  return {
    state: reconciled.state,
    actions,
    report: { applied: reviewed.applied.length, skipped: reviewed.skipped, reconcile: reconciled.diff },
  };
}

// ---------- OCR + parseo ----------

async function extractFromImage(cfg, state, imgPath, sourceBase) {
  // Paso 1: OCR local (PaddleOCR). Reintenta con backoff si el servidor está
  // ocupado o la inferencia falla por razones transitorias; si falla no
  // bloquea el flujo (luego entra Gemini).
  let ocrText = null;
  if (cfg.ocrUrl) {
    const maxOcr = cfg.ocrRetries ?? 2;
    for (let attempt = 1; attempt <= maxOcr; attempt++) {
      try {
        ocrText = await ocrImage(imgPath, { url: cfg.ocrUrl });
        appendJournal(cfg.journalFile, { event: "ocr", file: sourceBase, chars: ocrText.length, attempt });
        break;
      } catch (e) {
        const retriable = /socket hang up|ECONNREFUSED|ECONNRESET|timeout|no such file|ENOENT|500|503/i.test(String(e.message));
        if (attempt < maxOcr && retriable) {
          const wait = 15000 * attempt;
          console.warn(`[processor] OCR ${sourceBase} reintento ${attempt}/${maxOcr} en ${wait / 1000}s: ${e.message}`);
          await new Promise((r) => setTimeout(r, wait));
        } else {
          console.warn(`[processor] OCR skip ${sourceBase}: ${e.message}`);
          break;
        }
      }
    }
  }

  // Paso 2: extracción LOCAL (parser sin IA) como vía principal.
  let result = null;
  let local = false;
  if (ocrText) {
    const parsed = parseOcrText(ocrText);
    if (parsed.ok) {
      result = parsed.result;
      local = true;
      appendJournal(cfg.journalFile, { event: "extract_local", file: sourceBase, type: result.type });
    } else {
      console.warn(`[processor] extract local falló ${sourceBase}: ${parsed.error}`);
    }
  }

  // Paso 3: respaldo Gemini si el parser local no reconoció el formato.
  if (!result) {
    const geminiKey = effectiveGeminiKey(cfg, state);
    if (!geminiKey) throw new Error("sin GEMINI key: pon settings.geminiKey en la app, config.geminiKey o env GEMINI_API_KEY");
    result = await aiExtractFromFile(imgPath, geminiKey, {
      categories: state.categories || [],
      accounts: state.accounts || [],
      ocrText,
    });
    appendJournal(cfg.journalFile, { event: "extract_gemini", file: sourceBase, type: result.type });
  }
  return { result, local };
}

// ---------- Procesamiento de una imagen (devuelve acciones; no mueve archivos) ----------

export async function processImage(db, cfg, imagePath, sourceBase) {
  const state = apply.loadState(db, cfg.syncCode);
  const { result, local } = await extractFromImage(cfg, state, imagePath, sourceBase);

  let next = state;
  let actions = [];
  let report = null;

  if (result.type === "receipt") {
    ({ state: next, actions } = handleReceipt(cfg, state, result, imagePath, sourceBase));
  } else if (result.type === "transfer") {
    ({ state: next, actions } = handleTransfer(cfg, state, result, imagePath, sourceBase));
  } else if (result.type === "statement") {
    if (local) {
      ({ state: next, actions, report } = await handleStatementLocal(cfg, state, result, imagePath, sourceBase));
    } else {
      ({ state: next, actions, report } = await handleStatement(cfg, state, result, imagePath, sourceBase));
    }
  } else {
    throw new Error(`tipo no soportado: ${result.type}`);
  }

  const finalState = apply.saveState(db, cfg.syncCode, next);
  appendJournal(cfg.journalFile, {
    event: "processed",
    file: sourceBase,
    type: result.type,
    actions,
    report,
    newSyncVersion: finalState._syncVersion,
  });
  return { ok: true, type: result.type, actions, report, state: finalState };
}

export { openDb };