// state-store.js — lectura/escritura del estado sincronizado de un usuario
// (sync/{syncCode}.json) con primitivas para operaciones contables server-side.
// Espejo de la lógica de "add_transaction" del reducer (store.jsx): la aprobación
// del bot de Telegram ajusta saldos igual que lo haría el cliente.
import { mergeStates } from "../api/_merge.js";
import { readJSON, writeJSON } from "./blob-json.js";

const syncKey = (id) => `sync/${String(id).toLowerCase().trim()}.json`;

export const SYNC_CODE_RE = /^[a-z0-9-]{16,64}$/i;

export function validSyncCode(code) {
  return SYNC_CODE_RE.test(String(code || ""));
}

/** Devuelve el estado completo de un syncCode o null si no existe. */
export async function loadSyncState(syncCode) {
  if (!validSyncCode(syncCode)) return null;
  const data = await readJSON(syncKey(syncCode));
  return data && data.state ? data.state : null;
}

/**
 * Lee el estado, aplica `mutate(old)` y persiste fusionado (merge por ID para no
 * pisar escrituras concurrentes del cliente). Missing state → crea base vacía.
 */
export async function updateSyncState(syncCode, mutate) {
  if (!validSyncCode(syncCode)) throw new Error("Código de sincronización inválido");
  const existing = await readJSON(syncKey(syncCode));
  const prevState = existing?.state || null;
  const base = prevState || {
    settings: {}, accounts: [], assets: {}, transactions: [], scheduled: [],
    categories: [], transferAliases: {}, categoryAliases: {}, statementPatterns: {},
  };
  const next = mutate(structuredClone(base));
  if (!next || typeof next !== "object") throw new Error("Mutación inválida");
  const merged = prevState ? mergeStates(prevState, next) : next;
  await writeJSON(syncKey(syncCode), { state: merged, updatedAt: Date.now() });
  return merged;
}

// ---------- Primitivas contables ----------

const uid = () => Math.random().toString(36).slice(2, 10);
const todayISO = () => new Date().toISOString().slice(0, 10);

/** Categoría por reglas (keywords) igual a utils.categorize, usando las del usuario. */
export function classifyCategory(description, categories) {
  const list = Array.isArray(categories) ? categories : [];
  const d = String(description || "").toLowerCase();
  let best = { cat: "Otros", score: 0 };
  for (const c of list) {
    const score = (c.keywords || []).reduce((s, w) => (w && d.includes(w) ? s + w.length : s), 0);
    if (score > best.score) best = { cat: c.name, score };
  }
  return best.cat;
}

function normalizeCategory(category, description, categories) {
  const list = Array.isArray(categories) ? categories : [];
  if (category && list.some((c) => c.name === category)) return category;
  return classifyCategory(description, list);
}

/**
 * Añade una lista de transacciones propuestas al estado, ajustando el saldo de
 * cuenta tal como hace "add_transaction" del reducer.
 * rows: [{ description, amount(+), direction "in"|"out", currency, category,
 *          accountId, date, notes?, transfer? }]
 */
export function addProposedTransactions(state, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return state;
  const categories = state.categories || [];
  let accounts = Array.isArray(state.accounts) ? state.accounts : [];
  let transactions = Array.isArray(state.transactions) ? state.transactions : [];
  const added = [];

  for (const r of rows) {
    const accountId = r.accountId;
    const acc = accounts.find((a) => a.id === accountId);
    if (!acc) continue; // cuenta borrada o inexistente → no asentar
    if (r.transfer) {
      // Transferencia interna: se resuelve contra el estado de Cuentas heredado
      // (origen/destino en la misma llamada). No soportado vía bot simple.
      continue;
    }
    const signed = r.direction === "in" ? Math.abs(+r.amount || 0) : -Math.abs(+r.amount || 0);
    if (signed === 0) continue;
    const tx = {
      id: uid(),
      date: r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? r.date : todayISO(),
      description: String(r.description || "Movimiento").slice(0, 80),
      amount: Math.round(signed * 100) / 100,
      currency: ["EUR", "USD", "MXN", "GBP", "BTC", "ETH"].includes(r.currency) ? r.currency : (acc.currency || "EUR"),
      category: normalizeCategory(r.category, r.description, categories),
      accountId: acc.id,
      _updatedAt: Date.now(),
    };
    if (r.notes) tx.notes = String(r.notes).slice(0, 200);
    if (r.auto) tx.auto = true;
    added.push(tx);
    accounts = accounts.map((a) =>
      a.id === acc.id ? { ...a, balance: Math.round((a.balance + tx.amount) * 100) / 100, _updatedAt: Date.now() } : a
    );
  }

  if (added.length === 0) return state;
  return { ...state, accounts, transactions: [...transactions, ...added] };
}

/** Aprende alias OCR → accountId en el estado (igual que learn_transfer_aliases). */
export function learnAccountAliases(state, hints, accountId) {
  if (!hints || !accountId) return state;
  const transferAliases = { ...(state.transferAliases || {}) };
  let changed = false;
  for (const hint of (Array.isArray(hints) ? hints : [hint])) {
    const key = String(hint || "").toLowerCase().trim();
    if (key && transferAliases[key] !== accountId) { transferAliases[key] = accountId; changed = true; }
  }
  if (!changed) return state;
  return { ...state, transferAliases };
}