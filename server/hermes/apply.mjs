// apply.mjs — Mutaciones de estado compatibles con el reducer del cliente.
// Replica add_transaction / transfer / update balance de src/reducer.ts para que
// Hermes inyecte transacciones idénticas a las que crearía el usuario en la app.

import { getSyncDoc, putSyncDoc } from "../db.mjs";

export const uid = () => Math.random().toString(36).slice(2, 10);

export const todayISO = () => new Date().toISOString().slice(0, 10);

const r2 = (n) => Math.round(n * 100) / 100;

export function loadState(db, code) {
  const doc = getSyncDoc(db, code);
  if (!doc || !doc.state) throw new Error(`sync doc ${code} no encontrado`);
  return doc.state;
}

export function saveState(db, code, state) {
  const next = { ...state, _syncVersion: (state._syncVersion || 0) + 1 };
  putSyncDoc(db, code, next, Date.now());
  return next;
}

export function addTransaction(state, t) {
  const tx = {
    id: uid(),
    date: t.date || todayISO(),
    _updatedAt: Date.now(),
    description: String(t.description || "").slice(0, 60),
    amount: t.amount,
    currency: t.currency,
    accountId: t.accountId,
    category: t.category || null,
    subcategory: t.subcategory || null,
    auto: t.auto || false,
    counterpartId: t.counterpartId || null,
    notes: t.notes || null,
  };
  const accounts = (state.accounts || []).map((a) =>
    a.id === tx.accountId ? { ...a, balance: r2((a.balance || 0) + tx.amount) } : a
  );
  return { ...state, accounts, transactions: [tx, ...(state.transactions || [])] };
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
    if (a.id === fromId) return { ...a, balance: r2((a.balance || 0) - amount) };
    if (a.id === toId) return { ...a, balance: r2((a.balance || 0) + credited) };
    return a;
  });
  const txs = [
    {
      id: uid(), date: d, description: fromDesc || `Transferencia a ${to.name}`, amount: -amount,
      currency: from.currency, category: "Transferencia", accountId: fromId, counterpartId: toId,
      _updatedAt: Date.now(), ...(n ? { notes: n } : {}),
    },
    {
      id: uid(), date: d, description: toDesc || `Transferencia desde ${from.name}`, amount: r2(credited),
      currency: to.currency, category: "Transferencia", accountId: toId, counterpartId: fromId,
      _updatedAt: Date.now(), ...(n ? { notes: n } : {}),
    },
  ];
  return { ...state, accounts, transactions: [...txs, ...(state.transactions || [])] };
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