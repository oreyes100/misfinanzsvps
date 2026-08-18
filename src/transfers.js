// transfers.js — Lógica pura de transferencias (RECEIPT VISION, RV-04/05).
// El esquema real NO usa type:"transfer" ni transferPair: una transferencia es un
// PAR de transacciones normales con `counterpartId` apuntando a la CUENTA contraria:
//   out: { accountId: fromId, counterpartId: toId, amount: -amt }
//   in : { accountId: toId,  counterpartId: fromId, amount: +credited }
// Estas funciones son puras y testeables; el reducer de store.jsx solo las invoca.

import { todayISO } from "./utils.js";

/**
 * Encuentra el par de una transferencia dada cualquiera de sus patas.
 * Empareja por counterpartId mutuo + importe espejado.
 * @returns {{out: object|null, in: object|null}} out = patada negativa (origen), in = positiva (destino)
 */
export function findTransferPair(txs, tx) {
  if (!tx || !tx.counterpartId) return { out: null, in: null };
  const other = txs.find(
    (t) => t.id !== tx.id && t.accountId === tx.counterpartId && t.counterpartId === tx.accountId && Math.abs(t.amount) === Math.abs(tx.amount)
  );
  if (!other) return { out: null, in: null };
  return tx.amount < 0 ? { out: tx, in: other } : { out: other, in: tx };
}

/** Convierte importe entre divisas usando fx. */
export function convertAmount(amount, fromCur, toCur, fx) {
  if (!fromCur || !toCur || fromCur === toCur) return amount;
  const f = fx[fromCur];
  const t = fx[toCur];
  if (!f || !t) return amount;
  return Math.round(((amount * f) / t) * 100) / 100;
}

/**
 * Reconstruye el par de transferencias (RV-05).
 * @param {object} p {fromAccountId, toAccountId, amount, date, description, notes, fx, metadata}
 * @returns {[{out}, {in}]} patas nuevas con counterpartId mutuo
 */
export function buildTransferPair(p) {
  const {
    fromAccountId,
    toAccountId,
    amount,
    date = todayISO(),
    description = "Transferencia",
    notes,
    fx = {},
    fromCurrency = "EUR",
    toCurrency = "EUR",
    metadata = {},
  } = p;
  const credited = convertAmount(amount, fromCurrency, toCurrency, fx);
  const out = {
    id: p.outId || `tf_out_${Math.random().toString(36).slice(2, 10)}`,
    date,
    description,
    amount: -amount,
    currency: fromCurrency,
    category: "Transferencia",
    accountId: fromAccountId,
    counterpartId: toAccountId,
    ...(notes ? { notes } : {}),
    ...metadata,
    _updatedAt: Date.now(),
  };
  const inTx = {
    id: p.inId || `tf_in_${Math.random().toString(36).slice(2, 10)}`,
    date,
    description,
    amount: credited,
    currency: toCurrency,
    category: "Transferencia",
    accountId: toAccountId,
    counterpartId: fromAccountId,
    ...(notes ? { notes } : {}),
    ...metadata,
    _updatedAt: Date.now(),
  };
  return [out, inTx];
}

/**
 * Reajusta saldos de las cuentas afectadas por un par de transferencias.
 * Separa el destino VIEJO (revertir la entrada) del NUEVO (aplicar la entrada),
 * porque un swap atómico puede cambiar la cuenta destino (b → c).
 */
export function applyPairBalances(accounts, { fromId, oldToId = null, newToId = null, oldAmount = 0, oldToAmount = 0, newAmount = 0, newToAmount = 0 }) {
  return accounts.map((a) => {
    let bal = a.balance;
    if (a.id === fromId) bal -= oldAmount; // revertir salida (oldAmount negativo → +|old|)
    if (oldToId && a.id === oldToId) bal -= oldToAmount; // revertir entrada vieja
    if (a.id === fromId) bal += newAmount; // aplicar nueva salida (negativa)
    if (newToId && a.id === newToId) bal += newToAmount; // aplicar nueva entrada
    return bal === a.balance ? a : { ...a, balance: Math.round(bal * 100) / 100 };
  });
}

/**
 * EDIT TRANSFER (RV-05): cambia destino/monto/fecha/descripción del par de forma
 * atómica. Devuelve {accounts, transactions, transferId} o null si inválido.
 */
export function editTransferPair(state, { originalId, newToAccountId, newAmount, newDate, newDescription, metadata = {} }) {
  const tx = state.transactions.find((t) => t.id === originalId);
  if (!tx) return null;
  const pair = findTransferPair(state.transactions, tx);
  if (!pair.out) return null;
  const out = pair.out;
  const inTx = pair.in;

  const finalTo = newToAccountId || inTx?.accountId || out.counterpartId;
  if (out.accountId === finalTo) return null; // origen == destino

  const finalAmount = newAmount !== undefined ? Math.abs(newAmount) : Math.abs(out.amount);
  if (!(finalAmount > 0)) return null;
  const finalDate = newDate || out.date;
  const finalDescription = newDescription || out.description;

  const fromAccount = state.accounts.find((a) => a.id === out.accountId);
  const toAccount = state.accounts.find((a) => a.id === finalTo);
  if (!fromAccount || !toAccount) return null;

  const [newOut, newIn] = buildTransferPair({
    fromAccountId: out.accountId,
    toAccountId: finalTo,
    amount: finalAmount,
    date: finalDate,
    description: finalDescription,
    notes: out.notes,
    fx: state.fx,
    fromCurrency: fromAccount.currency,
    toCurrency: toAccount.currency,
    metadata: {
      receiptId: metadata.receiptId ?? out.receiptId ?? null,
      tags: metadata.tags ?? out.tags ?? [],
      notes: out.notes,
    },
  });

  const accounts = applyPairBalances(state.accounts, {
    fromId: out.accountId,
    oldToId: inTx ? inTx.accountId : null,
    newToId: finalTo,
    oldAmount: out.amount,
    oldToAmount: inTx ? inTx.amount : 0,
    newAmount: newOut.amount,
    newToAmount: newIn.amount,
  });

  // Eliminar el par viejo, insertar el nuevo al frente.
  const rest = state.transactions.filter((t) => t.id !== out.id && (inTx ? t.id !== inTx.id : true));
  return { accounts, transactions: [newOut, newIn, ...rest], out, inTx, newOut, newIn };
}

/**
 * CONVERT TO TRANSFER (RV-04): convierte un gasto/ingreso en par de transferencias.
 * Devuelve {accounts, transactions, removed} o null si inválido.
 */
export function convertToTransfer(state, { transactionId, toAccountId, metadata = {} }) {
  const tx = state.transactions.find((t) => t.id === transactionId);
  if (!tx || !toAccountId || toAccountId === tx.accountId) return null;
  const fromAccount = state.accounts.find((a) => a.id === tx.accountId);
  const toAccount = state.accounts.find((a) => a.id === toAccountId);
  if (!fromAccount || !toAccount) return null;

  const amount = Math.abs(tx.amount);
  const [newOut, newIn] = buildTransferPair({
    fromAccountId: tx.accountId,
    toAccountId,
    amount,
    date: tx.date,
    description: tx.description || "Transferencia",
    notes: tx.notes,
    fx: state.fx,
    fromCurrency: fromAccount.currency,
    toCurrency: toAccount.currency,
    metadata: {
      receiptId: metadata.receiptId ?? tx.receiptId ?? null,
      tags: metadata.tags ?? tx.tags ?? [],
      notes: tx.notes,
    },
  });

  const accounts = applyPairBalances(state.accounts, {
    fromId: tx.accountId,
    oldToId: null,
    newToId: toAccountId,
    oldAmount: tx.amount, // revertir la tx original
    oldToAmount: 0,
    newAmount: newOut.amount,
    newToAmount: newIn.amount,
  });

  const rest = state.transactions.filter((t) => t.id !== tx.id);
  return { accounts, transactions: [newOut, newIn, ...rest], removed: tx };
}

/**
 * CONVERT FROM TRANSFER (RV-04): convierte un par de transferencias en gasto/ingreso.
 * Devuelve {accounts, transactions, removed: [out, in]} o null si inválido.
 */
export function convertFromTransfer(state, { transactionId, newType, newCategoryId, keepAccountId }) {
  const tx = state.transactions.find((t) => t.id === transactionId);
  if (!tx) return null;
  const pair = findTransferPair(state.transactions, tx);
  if (!pair.out) return null;
  const out = pair.out;
  const inTx = pair.in;

  const targetAccountId = keepAccountId || (newType === "income" ? inTx?.accountId || out.accountId : out.accountId);
  const account = state.accounts.find((a) => a.id === targetAccountId);
  if (!account) return null;

  const amount = Math.abs(out.amount);
  const newTx = {
    id: `cv_${Math.random().toString(36).slice(2, 10)}`,
    date: out.date,
    description: out.description,
    amount: newType === "expense" ? -amount : amount,
    currency: account.currency,
    category: newCategoryId || "Otros",
    accountId: targetAccountId,
    ...(out.receiptId ? { receiptId: out.receiptId } : {}),
    ...(out.tags?.length ? { tags: out.tags } : {}),
    _updatedAt: Date.now(),
  };

  const accounts = applyPairBalances(state.accounts, {
    fromId: out.accountId,
    oldToId: inTx ? inTx.accountId : null,
    newToId: null,
    oldAmount: out.amount,
    oldToAmount: inTx ? inTx.amount : 0,
    newAmount: newTx.amount,
    newToAmount: 0,
  });

  const rest = state.transactions.filter((t) => t.id !== out.id && (inTx ? t.id !== inTx.id : true));
  return { accounts, transactions: [newTx, ...rest], removed: [out, inTx] };
}