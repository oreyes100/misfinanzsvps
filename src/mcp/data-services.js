// data-services.js — Puente entre las herramientas MCP y la lógica real del
// proyecto: state-store (SQLite/Blob), OCR (src/ocr.js) y drive-mcp (CLI).
//
// Sin datos mock: cada handler delega en la lógica real ya existente, y los
// resultados se devuelven en un sobre JSON estable para las tools MCP.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { loadSyncState, updateSyncState, validSyncCode } from "../../lib/state-store.js";

const execFileAsync = promisify(execFile);
const DRIVE_MCP = fileURLToPath(new URL("../../server/hermes/drive-mcp.mjs", import.meta.url));

// Igual que utils.ts `uid`; se evita importar TS desde Node para no romper el
// arranque directo del servidor con `node` (Node no resuelve .js → .ts).
const uid = () => Math.random().toString(36).slice(2, 10);

// ─── Balance / transacciones (espejo de reducer.ts) ───────────

/** Obtiene el balance de una cuenta (o de todas) de un syncCode. */
export async function getBalance({ syncCode, accountId }) {
  const state = await loadSyncState(syncCode);
  if (!state) return { ok: false, error: "Estado no encontrado para el syncCode" };
  const accounts = (state.accounts || []).map(({ id, name, type, currency, balance }) => ({
    id, name, type, currency, balance,
  }));
  if (accountId) {
    const acc = accounts.find((a) => a.id === accountId);
    if (!acc) return { ok: false, error: `Cuenta '${accountId}' no existe` };
    return { ok: true, account: acc };
  }
  const total = accounts.reduce((s, a) => s + (a.balance || 0), 0);
  return { ok: true, total: Math.round(total * 100) / 100, accounts };
}

/** Registra una transacción ajustando el balance (mismo efecto que add_transaction). */
export async function addTransaction({ syncCode, accountId, amount, description, category, date }) {
  if (!validSyncCode(syncCode)) return { ok: false, error: "Código de sincronización inválido" };
  const n = Number(amount);
  if (!Number.isFinite(n)) return { ok: false, error: "amount debe ser un número" };
  const desc = String(description || "").trim() || "Transacción";

  const next = await updateSyncState(syncCode, (s) => {
    const account = (s.accounts || []).find((a) => a.id === accountId);
    if (!account) return s;
    const tx = {
      id: uid(),
      date: date || new Date().toISOString().slice(0, 10),
      _updatedAt: Date.now(),
      description: desc,
      amount: Math.round(n * 100) / 100,
      currency: account.currency,
      category: category || "Otros",
      accountId,
    };
    return {
      ...s,
      transactions: [tx, ...(s.transactions || [])],
      accounts: (s.accounts || []).map((a) =>
        a.id === accountId ? { ...a, balance: Math.round((a.balance + tx.amount) * 100) / 100, _updatedAt: Date.now() } : a
      ),
    };
  });
  const tx = (next.transactions || [])[0];
  return tx ? { ok: true, transactionId: tx.id, balance: next.accounts.find((a) => a.id === accountId)?.balance } : { ok: false, error: "Cuenta no encontrada" };
}

/** Transfiere fondos entre cuentas con FX cuando las divisas difieren (espejo de transfer). */
export async function transferFunds({ syncCode, fromAccountId, toAccountId, amount, notes }) {
  if (!validSyncCode(syncCode)) return { ok: false, error: "Código de sincronización inválido" };
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0) return { ok: false, error: "amount debe ser un número positivo" };

  let transferId = null;
  const next = await updateSyncState(syncCode, (s) => {
    const from = (s.accounts || []).find((a) => a.id === fromAccountId);
    const to = (s.accounts || []).find((a) => a.id === toAccountId);
    if (!from || !to || n <= 0) return s;
    const fx = s.fx || {};
    const credited = from.currency === to.currency
      ? n
      : (n * (fx[from.currency] || 1)) / (fx[to.currency] || 1);
    const date = new Date().toISOString().slice(0, 10);
    const note = notes ? String(notes).trim() : undefined;
    const ts = Date.now();
    const txs = [
      { id: uid(), date, description: `Transferencia a ${to.name}`, amount: -Math.round(n * 100) / 100, currency: from.currency, category: "Transferencia", accountId: fromAccountId, counterpartId: toAccountId, _updatedAt: ts, ...(note ? { notes: note } : {}) },
      { id: uid(), date, description: `Transferencia desde ${from.name}`, amount: Math.round(credited * 100) / 100, currency: to.currency, category: "Transferencia", accountId: toAccountId, counterpartId: fromAccountId, _updatedAt: ts, ...(note ? { notes: note } : {}) },
    ];
    transferId = txs[0].id;
    return {
      ...s,
      transactions: [...txs, ...(s.transactions || [])],
      accounts: (s.accounts || []).map((a) => {
        if (a.id === fromAccountId) return { ...a, balance: Math.round((a.balance - n) * 100) / 100, _updatedAt: ts };
        if (a.id === toAccountId) return { ...a, balance: Math.round((a.balance + credited) * 100) / 100, _updatedAt: ts };
        return a;
      }),
    };
  });
  if (!transferId) return { ok: false, error: "Cuentas origen/destino no encontradas" };
  const accounts = next.accounts || [];
  return {
    ok: true,
    transferId,
    fromBalance: accounts.find((a) => a.id === fromAccountId)?.balance,
    toBalance: accounts.find((a) => a.id === toAccountId)?.balance,
  };
}

// ─── OCR (src/ocr.js real) ────────────────────────────────────

/**
 * Parsea un recibo a partir de texto o imagen (OCR Tesseract lazy).
 * Devuelve { merchant, total, date, items, groups }.
 */
export async function scanReceipt({ text, imageBase64, categories, categoryAliases }) {
  const { parseReceipt, ocrImage } = await import("../ocr.js");
  let source = String(text || "");
  if (imageBase64) {
    source = await ocrImage(imageBase64);
  }
  if (!source.trim()) return { ok: false, error: "No se pudo extraer texto del recibo" };
  const parsed = parseReceipt(source, categories, categoryAliases);
  return { ok: true, ...parsed };
}

/**
 * Parsea una captura de transferencia a { amount, from, to, fromHint, toHint, confident }.
 */
export async function scanTransfer({ text, accounts, transferAliases }) {
  const { parseTransfer } = await import("../ocr.js");
  const parsed = parseTransfer(String(text || ""), accounts || [], transferAliases || {});
  return { ok: true, ...parsed };
}

// ─── Drive → Hermes (CLI real de server/hermes/drive-mcp.mjs) ─

async function runDrive(args) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [DRIVE_MCP, ...args], {
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, data: JSON.parse(stdout || "{}") };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

export const driveStatus = () => runDrive(["--status"]);
export const driveSync = () => runDrive(["--sync"]);
export const drivePending = () => runDrive(["--status"]);
