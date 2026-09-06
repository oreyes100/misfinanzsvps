// apply.mjs — Mutaciones de estado compatibles con el reducer del cliente.
// Replica add_transaction / transfer / update balance de src/reducer.ts para que
// Hermes inyecte transacciones idénticas a las que crearía el usuario en la app.
// Nota: db.mjs se importa lazy (solo en loadState/saveState) para que las
// funciones puras (addTransaction, addConflictTransaction) sean testeables
// sin mejor-sqlite3 instalado localmente.

import { ensureCategory } from "./categoryGuard.mjs";

export const uid = () => Math.random().toString(36).slice(2, 10);

export const todayISO = () => new Date().toISOString().slice(0, 10);

const r2 = (n) => Math.round(n * 100) / 100;

export async function loadState(db, code) {
  const { getSyncDoc } = await import("../db.mjs");
  const doc = getSyncDoc(db, code);
  if (!doc || !doc.state) throw new Error(`sync doc ${code} no encontrado`);
  return doc.state;
}

export async function saveState(db, code, state) {
  const { putSyncDoc } = await import("../db.mjs");
  const next = { ...state, _syncVersion: (state._syncVersion || 0) + 1 };
  putSyncDoc(db, code, next, Date.now());
  return next;
}

// ---------- W25: el bot escribe vía POST /api/push (mismo protocolo que la webapp) ----------

// Marca _updatedAt en las cuentas modificadas: sin esto, mergeById del server
// (api/_merge.js) conservaría la versión vieja de la cuenta y el balance del
// bot se perdería en la consolidación.
const touchAccount = (a) => ({ ...a, _updatedAt: Date.now() });

/**
 * W25 Fase 1: envía el delta del bot a POST /api/push?id=<syncCode>.
 * El server consolida (consolidateAndBump) y avanza _syncVersion.
 * 3 reintentos con backoff lineal. Lanza si todos fallan → el llamador NO debe
 * reportar "aplicada" (Fase 2: confirmación real).
 */
export async function pushDelta(cfg, delta, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const maxRetries = opts.maxRetries ?? 3;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const serverUrl = (cfg.serverUrl || "http://127.0.0.1:3000").replace(/\/+$/, "");
  const url = `${serverUrl}/api/push?id=${encodeURIComponent(cfg.syncCode)}`;
  let lastError = null;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const r = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: delta }),
      });
      if (r.ok) {
        const data = await r.json();
        if (data && data.ok) return data; // { ok, state, syncVersion, hash }
        lastError = new Error(`server rechazó el push: ${JSON.stringify(data).slice(0, 200)}`);
      } else {
        lastError = new Error(`HTTP ${r.status}`);
      }
    } catch (e) {
      lastError = e;
    }
    if (attempt < maxRetries) await sleep(1000 * attempt);
  }
  throw new Error(`push del bot falló tras ${maxRetries} intentos: ${lastError?.message || lastError}`);
}

export function addTransaction(state, t) {
  const guard = ensureCategory({ category: t.category, description: t.description });
  const tx = {
    id: uid(),
    date: t.date || todayISO(),
    _updatedAt: Date.now(),
    _createdAt: Date.now(),
    description: String(t.description || "").slice(0, 60),
    amount: t.amount,
    currency: t.currency,
    accountId: t.accountId,
    category: guard.category,
    subcategory: t.subcategory || null,
    auto: t.auto || false,
    counterpartId: t.counterpartId || null,
    notes: t.notes || null,
    _categorySource: guard.categorySource,
    _categoryConfidence: guard.categoryConfidence,
    _needsCategoryReview: guard.needsCategoryReview || undefined,
  };
  const accounts = (state.accounts || []).map((a) =>
    a.id === tx.accountId ? touchAccount({ ...a, balance: r2((a.balance || 0) + tx.amount) }) : a
  );
  return { ...state, accounts, transactions: [tx, ...(state.transactions || [])] };
}

// WG11: transacción CONFLICTIVA (OCR no resuelto). No se asigna cuenta ni
// categoría: entra a la cola de revisión del menú MCP con pendingResolution y
// evidenceUrl para que el usuario corrija (y el sistema aprenda) en la app.
export function addConflictTransaction(state, t) {
  const tx = {
    id: uid(),
    date: t.date || todayISO(),
    _updatedAt: Date.now(),
    _createdAt: Date.now(),
    description: String(t.description || "").slice(0, 60),
    amount: t.amount,
    currency: t.currency,
    accountId: t.accountId || null,
    category: null,
    subcategory: null,
    auto: t.auto || false,
    counterpartId: null,
    notes: t.notes || null,
    _categorySource: "conflict",
    _categoryConfidence: 0,
    _needsCategoryReview: true,
    pendingResolution: t.pendingResolution || { reason: "conflicto OCR" },
    evidenceUrl: t.evidenceUrl || null,
  };
  return { ...state, transactions: [tx, ...(state.transactions || [])] };
}

export function addTransfer(state, { fromId, toId, amount, date, notes, fromDesc, toDesc }) {
  const from = (state.accounts || []).find((a) => a.id === fromId);
  const to = (state.accounts || []).find((a) => a.id === toId);
  if (!from || !to || !(amount > 0)) throw new Error("transferencia inválida");
  const credited =
    from.currency === to.currency
      ? amount
      : (amount * (state.fx?.[from.currency] || 1)) / (state.fx?.[to.currency] || 1);
  const d = date || todayISO();
  const n = notes ? String(notes).trim() : undefined;
  const accounts = (state.accounts || []).map((a) => {
    if (a.id === fromId) return touchAccount({ ...a, balance: r2((a.balance || 0) - amount) });
    if (a.id === toId) return touchAccount({ ...a, balance: r2((a.balance || 0) + credited) });
    return a;
  });
  const txs = [
    {
      id: uid(), date: d, description: fromDesc || `Transferencia a ${to.name}`, amount: -amount,
      currency: from.currency, category: "Transferencia", accountId: fromId, counterpartId: toId,
      _updatedAt: Date.now(),
    _createdAt: Date.now(), ...(n ? { notes: n } : {}),
    },
    {
      id: uid(), date: d, description: toDesc || `Transferencia desde ${from.name}`, amount: r2(credited),
      currency: to.currency, category: "Transferencia", accountId: toId, counterpartId: fromId,
      _updatedAt: Date.now(),
    _createdAt: Date.now(), ...(n ? { notes: n } : {}),
    },
  ];
  return { ...state, accounts, transactions: [...txs, ...(state.transactions || [])] };
}

/**
 * W25: delta mínimo que el bot envía al server — solo las transacciones nuevas
 * y las cuentas cuyo balance cambió. consolidateAndBump(existing, delta) hace
 * el merge por ID: las cuentas del bot ganan por _updatedAt (más reciente) y
 * todo lo demás se conserva del estado existente.
 */
export function computeDelta(prev, next) {
  const prevTxIds = new Set((prev.transactions || []).map((t) => t.id));
  const transactions = (next.transactions || []).filter((t) => !prevTxIds.has(t.id));
  const prevAcc = new Map((prev.accounts || []).map((a) => [a.id, a]));
  const accounts = (next.accounts || []).filter((a) => {
    const p = prevAcc.get(a.id);
    return !p || p.balance !== a.balance;
  });
  return { accounts, transactions };
}

// ---------- Resolución de cuenta desde un texto (replica resolveAccount de ocr.js) ----------

const norm = (s) => (s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

export function findAccount(state, hint, aliases = {}) {
  if (!hint) return null;
  const h = norm(hint);
  if (aliases[h]) {
    const byAlias = (state.accounts || []).find((a) => a.id === aliases[h]);
    if (byAlias) return byAlias;
  }
  const matches = (state.accounts || []).filter((a) => {
    const an = norm(a.name);
    return h.includes(an) || an.includes(h);
  });
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const exact = matches.find((a) => norm(a.name) === h);
    if (exact) return exact;
    return null; // ambiguo -> revisión humana
  }
  // coincidencia por token significativo (p. ej. "Santander SuperCuenta" -> "santander")
  const tokens = h.split(/[\s*:.#-]+/).filter((t) => t.length >= 4);
  for (const tok of tokens) {
    const byToken = (state.accounts || []).filter((a) => norm(a.name).includes(tok));
    if (byToken.length === 1) return byToken[0];
  }
  const digits = h.match(/\d{3,4}/)?.[0];
  if (digits) return (state.accounts || []).find((a) => norm(a.name).includes(digits)) || null;
  return null;
}

export function reconcileBalance(state, accountId, statementBalance, { description, notes } = {}) {
  const acc = (state.accounts || []).find((a) => a.id === accountId);
  if (!acc) throw new Error("cuenta no encontrada");
  const diff = r2(statementBalance - (acc.balance || 0));
  if (diff === 0) return { state, applied: false, diff: 0 };
  const next = addTransaction(state, {
    description: description || "Ajuste por conciliación de estado de cuenta",
    amount: diff,
    currency: acc.currency,
    accountId,
    category: "Otros",
    notes: notes || "Detectado automáticamente por Hermes al conciliar estado de cuenta",
    auto: true,
  });
  return { state: next, applied: true, diff };
}

export function findAccountByFolder(state, folderAccountMap, filePath, watchDir) {
  const rel = filePath.replace(watchDir.replace(/\/+$/, ""), "").split(/[\\/]/).filter(Boolean);
  const folder = rel[0] ? rel[0].toLowerCase() : "";
  if (folderAccountMap && folderAccountMap[folder]) {
    return (state.accounts || []).find((a) => a.id === folderAccountMap[folder]) || null;
  }
  return null;
}