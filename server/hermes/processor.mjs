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
import { loadAIConfig, callWithFallback } from "./aiClient.mjs";
import { categoryFromMap, transferRuleFor } from "./learning.mjs";

export const IMAGE_EXT = [".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"];

export function loadProcessorConfig(configPath, overrides = {}) {
  const base = {
    syncCode: null,
    serverUrl: "http://127.0.0.1:3000", // W25: el bot escribe vía POST /api/push del propio server
    dbPath: null,
    watchDir: "/home/devops/obsidian-vault/images/inbox",
    processedDir: "/home/devops/obsidian-vault/images/processed",
    reviewDir: "/home/devops/obsidian-vault/images/review",
    evidenceDir: "/home/devops/obsidian-vault/evidence",
    journalFile: "/home/devops/hermes-agent/journal.jsonl",
    pollIntervalMs: 15000,
    maxAuditRounds: 3,
    folderAccountMap: {},
    bankAccountMap: {},
    geminiKey: null,
    ocrProvider: "paddle",
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

// WG11: copia la imagen conflictiva a evidenceDir para que el endpoint
// /api/evidence/:name la sirva al cliente (menú MCP). Devuelve el nombre
// de archivo en evidenceDir (o null si no hay imagen / no se pudo copiar).
function saveEvidenceImage(cfg, file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    const ext = path.extname(file) || ".jpg";
    const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    fs.mkdirSync(cfg.evidenceDir, { recursive: true });
    fs.copyFileSync(file, path.join(cfg.evidenceDir, name));
    return name;
  } catch {
    return null;
  }
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

  // WG11: sin cuenta resuelta → CONFLICTO (con imagen) en vez de abortar.
  if (!acc) {
    const total = r2((result.total || items.reduce((s, it) => s + Math.abs(it.amount || 0), 0)) || 0);
    const conflicto = apply.addConflictTransaction(state, {
      description: `Recibo sin cuenta: ${result.merchant || "comercio desconocido"}`,
      amount: -Math.abs(total),
      currency: state.accounts?.[0]?.currency || "EUR",
      date: result.date || null,
      notes: `Ingresado por Hermes desde recibo [${source}]`,
      auto: true,
      pendingResolution: { reason: "cuenta del recibo no resuelta", merchant: result.merchant || null, total },
      evidenceUrl: saveEvidenceImage(cfg, file),
    });
    return {
      state: conflicto,
      actions: [{ kind: "conflict_unresolved", reason: "receipt_account", merchant: result.merchant, total }],
    };
  }

  // Si los ítems no traen montos (tickets: importes en columnas separadas que
  // el OCR no empareja con el producto), usamos el TOTAL del recibo como una
  // sola transacción.
  const itemTotal = r2(items.reduce((s, it) => s + Math.abs(it.amount || 0), 0));
  if (items.length === 0 || itemTotal <= 0) {
    if (!(result.total > 0)) throw new Error("recibo sin total ni ítems");
    const cat = categoryFromMap(cfg, result.merchant, result.merchant) || "Otros";
    const tx = apply.addTransaction(state, {
      description: result.merchant || "Compra",
      amount: -r2(result.total),
      currency: acc.currency,
      accountId: acc.id,
      category: cat,
      date: result.date || null,
      notes: `Ingresado por Hermes desde recibo [${source}]`,
      auto: true,
    });
    return { state: tx, actions: [{ kind: "receipt", desc: result.merchant || "Compra", amount: -r2(result.total), accountId: acc.id, category: cat }] };
  }

  const groups = new Map();
  for (const it of items) {
    const key = categoryFromMap(cfg, result.merchant, it.name) || it.category || "Otros";
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

  // WG11: consultar primero las reglas de transferencia aprendidas (Fase 3).
  // Si el par (from|to) ya se resolvió antes, se reutiliza sin preguntar.
  const rule = transferRuleFor(cfg, t.from, t.to);
  if (rule?.fromId && rule?.toId && rule.fromId !== rule.toId) {
    const fromAcc = (state.accounts || []).find((a) => a.id === rule.fromId);
    const toAcc = (state.accounts || []).find((a) => a.id === rule.toId);
    if (fromAcc && toAcc) {
      const next = apply.addTransfer(state, {
        fromId: rule.fromId,
        toId: rule.toId,
        amount: t.amount,
        date: result.date || null,
        notes: `Ingresado por Hermes desde comprobante [${source}]${rule.note ? ` — ${rule.note}` : ""}`,
      });
      return {
        state: next,
        actions: [
          { kind: "transfer_out", fromId: rule.fromId, toId: rule.toId, amount: -r2(t.amount) },
          { kind: "transfer_in", fromId: rule.fromId, toId: rule.toId, amount: r2(t.amount) },
        ],
      };
    }
  }

  // Resolver ambas puntas con cuentas propias.
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

  // WG11: punta(s) sin resolver → CONFLICTO (ya NO degrada a movimiento simple).
  // La tx llega al menú MCP como ⚠️ Corregir CON imagen, para que el usuario
  // complete la cuenta faltante y el sistema aprenda la regla de transferencia.
  const conflicto = apply.addConflictTransaction(state, {
    description: `Transferencia sin resolver: ${t.from || "?"} → ${t.to || "?"}`,
    amount: -r2(t.amount),
    currency: (from || to)?.currency || state.accounts?.[0]?.currency || "EUR",
    date: result.date || null,
    notes: `Ingresado por Hermes desde comprobante [${source}]`,
    auto: true,
    pendingResolution: {
      reason: "cuentas no resueltas",
      from: t.from,
      to: t.to,
      resolvedId: (from || to)?.id || null, // punta ya conocida, para pre-llenar
    },
    evidenceUrl: saveEvidenceImage(cfg, file),
  });
  return {
    state: conflicto,
    actions: [{ kind: "conflict_unresolved", from: t.from, to: t.to, amount: -r2(t.amount), resolvedId: (from || to)?.id || null }],
  };
}

// WG11: busca en cfg.transferRules un par (from|to) normalizado que coincida.
// (ver server/hermes/learning.mjs)

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
      category: categoryFromMap(cfg, result.merchant, m.description) || m.category || null,
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
  // Paso 1: OCR local (PaddleOCR) si el provider es "paddle" (default).
  // W26: la llamada pasa por callWithFallback — circuit breaker + reintentos +
  // timeout duro de aiConfig (≤60s). Antes el timeout era de 20 MINUTOS
  // hardcodeado (causa documentada del bot atascado).
  let ocrText = null;
  const ocrProvider = cfg.ocrProvider || "paddle";
  if (ocrProvider === "paddle" && cfg.ocrUrl) {
    try {
      const res = await callWithFallback(
        "ocr",
        { paddle: () => ocrImage(imgPath, { url: cfg.ocrUrl }) },
        { config: loadAIConfig() }
      );
      ocrText = res.result;
      appendJournal(cfg.journalFile, { event: "ocr", file: sourceBase, chars: ocrText.length, attempt: res.attempt, provider: res.provider, latencyMs: res.latencyMs });
    } catch (e) {
      // La cadena ya reintentó (maxRetries de aiConfig). Si todo falla, el flujo
      // sigue: entra Gemini vision como respaldo (paso 3).
      console.warn(`[processor] OCR skip ${sourceBase}: ${e.message}`);
      appendJournal(cfg.journalFile, { event: "ocr_failed", file: sourceBase, error: String(e.message || e).slice(0, 300) });
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
      appendJournal(cfg.journalFile, { event: "ocr_debug", file: sourceBase, error: parsed.error, ocrText: ocrText.slice(0, 1500) });
    }
  }

  // Paso 3: respaldo Gemini si el parser local no reconoció el formato.
  if (!result) {
    const geminiKey = effectiveGeminiKey(cfg, state);
    if (!geminiKey) throw new Error("sin GEMINI key: pon settings.geminiKey en la app, config.geminiKey o env GEMINI_API_KEY");
    try {
      result = await aiExtractFromFile(imgPath, geminiKey, {
        categories: state.categories || [],
        accounts: state.accounts || [],
        ocrText,
      });
      appendJournal(cfg.journalFile, { event: "extract_gemini", file: sourceBase, type: result.type });
    } catch (e) {
      // WG11: Gemini en límite/falla → NO descartar. Se degrada a un resultado
      // mínimo de tipo "receipt" sin cuentas: el flujo lo marcará como
      // CONFLICTO en el menú MCP (con imagen) en vez de abortar la imagen.
      console.warn(`[processor] Gemini falló ${sourceBase}: ${e.message}`);
      appendJournal(cfg.journalFile, { event: "gemini_fallback_conflict", file: sourceBase, error: String(e.message || e).slice(0, 300) });
      result = {
        type: "receipt",
        merchant: null,
        date: null,
        total: null,
        items: [],
        movements: [],
        transfer: null,
        statementBalance: null,
      };
    }
  }
  return { result, local };
}

// ---------- Procesamiento de una imagen (devuelve acciones; no mueve archivos) ----------

export async function processImage(db, cfg, imagePath, sourceBase) {
  const state = await apply.loadState(db, cfg.syncCode);
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

  // W25: el bot ya NO escribe directo a SQLite (read-modify-write del doc
  // completo desde un segundo proceso = lost-update que borraba transacciones
  // del bot o de la webapp). Ahora envía un delta mínimo a POST /api/push y el
  // server consolida de forma determinista (consolidateAndBump). Si el push
  // falla, processImage lanza → hermes.mjs mueve el archivo a revisión y NO se
  // reporta "aplicada" (confirmación real).
  let pushRes = null;
  try {
    pushRes = await apply.pushDelta(cfg, apply.computeDelta(state, next));
  } catch (e) {
    appendJournal(cfg.journalFile, {
      event: "push_failed",
      file: sourceBase,
      type: result.type,
      error: String(e.message || e).slice(0, 300),
    });
    throw e;
  }
  const finalState = pushRes.state || next;
  appendJournal(cfg.journalFile, {
    event: "processed",
    file: sourceBase,
    type: result.type,
    actions,
    report,
    newSyncVersion: pushRes.syncVersion ?? null,
    hash: pushRes.hash ?? null,
  });
  return { ok: true, type: result.type, actions, report, state: finalState, syncVersion: pushRes.syncVersion ?? null };
}

export { openDb };