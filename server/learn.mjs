// learn.mjs — POST /api/learn (WG11). Persiste aprendizaje del usuario en
// server/hermes/config.json: bankAccountMap (merchant→cuenta), transferRules
// (par from/to → resolución) y merchantCategoryMap (merchant→categoría).
// El pipeline Hermes relee el config en cada procesamiento, así el aprendizaje
// queda activo sin reiniciar el servicio.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = process.env.HERMES_CONFIG || path.join(HERE, "hermes", "config.json");

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveConfig(cfg) {
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), "utf8");
  fs.renameSync(tmp, CONFIG_PATH);
}

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ");
}

// Aprender mapeo de cuenta: `bankAccountMap[merchant] = accountId`.
// Verifica que accountId exista en el estado sincronizado (via getSyncDoc).
function learnAccountMapping(cfg, entry, state) {
  const merchant = norm(entry.merchant);
  const accountId = String(entry.accountId || "");
  if (!merchant || !accountId) return { ok: false, error: "merchant y accountId requeridos" };
  const exists = (state.accounts || []).some((a) => a.id === accountId);
  if (!exists) return { ok: false, error: "accountId no existe en el estado" };
  cfg.bankAccountMap = cfg.bankAccountMap || {};
  cfg.bankAccountMap[merchant] = accountId;
  return { ok: true, learned: { kind: "account", merchant, accountId } };
}

// Aprender regla de transferencia: `transferRules["from|to"] = { fromId, toId }`.
function learnTransferRule(cfg, entry, state) {
  const from = norm(entry.from);
  const to = norm(entry.to);
  const fromId = String(entry.fromId || "");
  const toId = String(entry.toId || "");
  if (!from && !to) return { ok: false, error: "origen o destino requeridos" };
  if (!fromId && !toId) return { ok: false, error: "fromId o toId requeridos" };
  const ids = [fromId, toId].filter(Boolean);
  const exists = (state.accounts || []).some((a) => ids.includes(a.id));
  if (!exists) return { ok: false, error: "algún accountId no existe en el estado" };
  cfg.transferRules = cfg.transferRules || {};
  cfg.transferRules[`${from}|${to}`] = { fromId: fromId || null, toId: toId || null };
  return { ok: true, learned: { kind: "transfer", from, to, fromId, toId } };
}

// Aprender categoría: `merchantCategoryMap[merchant] = category`.
function learnCategory(cfg, entry, state) {
  const merchant = norm(entry.merchant);
  const category = String(entry.category || "").trim();
  if (!merchant || !category) return { ok: false, error: "merchant y category requeridos" };
  cfg.merchantCategoryMap = cfg.merchantCategoryMap || {};
  cfg.merchantCategoryMap[merchant] = category;
  return { ok: true, learned: { kind: "category", merchant, category } };
}

export async function handleLearn(req, res, body) {
  const payload = (body && typeof body === "object" && body.entry) ? body.entry : body;
  if (!payload || typeof payload !== "object") {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ error: "Cuerpo JSON requerido." }));
  }

  const cfg = loadConfig();
  // Estado sincronizado: solo para validar que los ids existen.
  let state = { accounts: [] };
  try {
    const { getSyncDoc } = await import("./db.mjs");
    const doc = cfg.syncCode ? getSyncDoc(cfg.syncCode) : null;
    state = (doc && doc.state) || state;
  } catch {}

  let result;
  if (payload.kind === "transfer") result = learnTransferRule(cfg, payload, state);
  else if (payload.kind === "category") result = learnCategory(cfg, payload, state);
  else result = learnAccountMapping(cfg, payload, state);

  if (!result.ok) {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ error: result.error }));
  }

  saveConfig(cfg);
  res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  return res.end(JSON.stringify({ ok: true, learned: result.learned }));
}
