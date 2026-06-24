// ---------- Módulo de Auditoría ----------
// Coteja estados de cuenta (PDF/imagen) contra transacciones registradas
// y genera checklist de correcciones para aplicar al store.

// ---------- Normalización de texto ----------

const NORM = (s) =>
  (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .trim();

const NORM_DESC = (s) =>
  (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

// ---------- Distancia Levenshtein ----------

function levenshtein(a, b) {
  const alen = a.length, blen = b.length;
  if (!alen) return blen;
  if (!blen) return alen;
  const prevRow = new Array(blen + 1);
  const currRow = new Array(blen + 1);
  for (let j = 0; j <= blen; j++) prevRow[j] = j;
  for (let i = 1; i <= alen; i++) {
    currRow[0] = i;
    for (let j = 1; j <= blen; j++) {
      currRow[j] =
        a[i - 1] === b[j - 1]
          ? prevRow[j - 1]
          : Math.min(prevRow[j - 1], prevRow[j], currRow[j - 1]) + 1;
    }
    for (let j = 0; j <= blen; j++) prevRow[j] = currRow[j];
  }
  return prevRow[blen];
}

function descSimilarity(a, b) {
  const na = NORM_DESC(a), nb = NORM_DESC(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  const dist = levenshtein(na.slice(0, 25), nb.slice(0, 25));
  const maxLen = Math.max(na.length, nb.length, 1);
  return Math.max(0, 1 - dist / maxLen);
}

function dateDist(d1, d2) {
  if (!d1 || !d2) return Infinity;
  return Math.abs(new Date(d1 + "T12:00:00") - new Date(d2 + "T12:00:00")) / 86400000;
}

// ---------- Identificar cuenta ----------

/**
 * Identifica qué cuenta del sistema corresponde al estado de cuenta.
 * Estrategias: nombre, rango de fechas y transacciones, patrón de movimientos.
 */
export function identifyAccount(extract, accounts) {
  if (!extract || !accounts?.length) return { account: null, confidence: 0, reason: "Sin datos suficientes" };

  const merchant = (extract.merchant || "").toLowerCase().trim();
  const movs = extract.movements || [];

  // 1. Match por nombre de cuenta/tarjeta en el merchant del extracto
  let bestName = { account: null, score: 0 };
  for (const a of accounts) {
    const an = a.name.toLowerCase().trim();
    if (!an) continue;
    if (merchant.includes(an)) {
      const score = an.length / Math.max(merchant.length, 1);
      if (score > bestName.score) bestName = { account: a, score: score + 0.3 };
    }
    // También match inverso
    if (an.includes(merchant)) {
      const score = merchant.length / Math.max(an.length, 1);
      if (score > bestName.score) bestName = { account: a, score: score + 0.2 };
    }
  }
  if (bestName.score >= 0.3) {
    return {
      account: bestName.account,
      confidence: Math.min(0.7 + bestName.score, 0.95),
      reason: `Nombre "${bestName.account.name}" mencionado en el extracto`,
    };
  }

  // 2. Match por rango de fechas: cuenta con más transacciones en el período
  const dates = movs.filter((m) => m.date).map((m) => m.date).sort();
  if (dates.length >= 2) {
    const start = dates[0];
    const end = dates[dates.length - 1];
    let bestPer = { account: null, count: 0 };
    for (const a of accounts) {
      // Buscar en todas las transacciones del estado, no solo las de esta cuenta
      // (no tenemos access a transactions aquí, el llamador las provee)
    }
    // Esta lógica se completa en auditStatement donde tenemos transacciones
  }

  return { account: null, confidence: 0, reason: "No se pudo identificar automáticamente. Selecciona la cuenta manualmente." };
}

// ---------- Matching de movimientos ----------

function findMatch(mov, accountTransactions) {
  let best = { tx: null, score: -1, type: null };

  for (const tx of accountTransactions) {
    const txAmount = Math.abs(tx.amount);
    const movAmount = mov.amount;
    const amountMatch = Math.abs(txAmount - movAmount) < 0.03;
    const dd = dateDist(mov.date, tx.date);
    const ds = descSimilarity(mov.description, tx.description);

    // Match exacto: mismo importe, fecha cercana, descripción similar
    if (amountMatch && dd <= 3 && ds > 0.55) {
      const score = ds * 0.6 + (dd < 0.5 ? 0.4 : dd < 1.5 ? 0.25 : 0.1);
      if (score > best.score) {
        best = { tx, score, type: "exact" };
      }
    }

    // Match parcial: fecha cercana y descripción similar PERO importe diferente
    if (dd <= 3 && ds > 0.5 && !amountMatch) {
      const score = ds * 0.4 + (dd < 0.5 ? 0.2 : 0.05);
      if (score > best.score) {
        best = { tx, score, type: "amount_mismatch", diff: Math.abs(movAmount - txAmount) };
      }
    }

    // Match solo por importe + fecha (cuando descripción es muy distinta)
    if (amountMatch && dd <= 2 && ds <= 0.55) {
      const score = 0.3 - dd * 0.05;
      if (score > best.score) {
        best = { tx, score, type: "amount_only" };
      }
    }
  }

  return best.score >= 0 ? best : null;
}

// ---------- Auditoría principal ----------

/**
 * Audit complete: analiza el extracto y genera checklist de correcciones.
 *
 * @param {Object} extract — resultado de aiExtract() (ocr.js)
 *   { type: "statement", merchant, movements: [{date, description, amount, direction, isTransfer, category}] }
 * @param {Object[]} accounts — state.accounts
 * @param {Object[]} transactions — state.transactions
 * @param {Object} [options]
 * @param {string} [options.overrideAccountId] — forzar cuenta (si detección automática falló)
 * @returns {AuditResult}
 */
export function auditStatement(extract, accounts, transactions, options = {}) {
  const movements = (extract.movements || []).filter((m) => m && m.amount > 0);
  const overrideId = options.overrideAccountId;

  // Identificar cuenta
  const ident = overrideId
    ? { account: accounts.find((a) => a.id === overrideId) || null, confidence: 1, reason: "Selección manual" }
    : identifyAccount(extract, accounts);

  const targetAccount = ident.account;

  // Transacciones registradas de la cuenta identificada
  const accountTx = targetAccount
    ? transactions.filter((t) => t.accountId === targetAccount.id)
    : [];

  // Período del extracto
  const dates = movements.filter((m) => m.date).map((m) => m.date).sort();
  const period = dates.length >= 2 ? { from: dates[0], to: dates[dates.length - 1] } : null;

  // --- Comparar cada movimiento del extracto vs registradas ---

  const checklist = [];

  for (let i = 0; i < movements.length; i++) {
    const mov = movements[i];
    const match = findMatch(mov, accountTx);

    if (!match) {
      // No hay match → transacción faltante en nuestro registro
      if (mov.isTransfer) {
        checklist.push({
          id: `miss-trf-${i}`,
          type: "missing_transfer",
          severity: "high",
          mov,
          description: mov.description,
          date: mov.date,
          amount: mov.amount,
          direction: mov.direction,
          proposed: `Registrar transferencia faltante: ${mov.description} — ${fmtAmountShort(mov.amount)} (${mov.direction === "in" ? "entrante" : "saliente"})`,
          action: "add_transfer",
        });
      } else {
        checklist.push({
          id: `miss-tx-${i}`,
          type: "missing_transaction",
          severity: "high",
          mov,
          description: mov.description,
          date: mov.date,
          amount: mov.amount,
          direction: mov.direction,
          proposed: `Registrar movimiento faltante: "${mov.description}" — ${fmtAmountShort(mov.amount)}`,
          action: "add_transaction",
          category: mov.category || null,
        });
      }
      continue;
    }

    if (match.type === "amount_mismatch") {
      // Misma descripción/fecha, importe diferente
      const tx = match.tx;
      const dir = tx.amount > 0 ? "in" : "out";
      checklist.push({
        id: `amt-${i}`,
        type: "amount_mismatch",
        severity: "medium",
        mov,
        tx,
        description: mov.description,
        date: mov.date,
        amount: mov.amount,
        registeredAmount: Math.abs(tx.amount),
        difference: match.diff,
        direction: dir,
        proposed: `Corregir importe en "${mov.description}": de ${fmtAmountShort(Math.abs(tx.amount))} → ${fmtAmountShort(mov.amount)}`,
        action: "correct_amount",
      });
    }

    // Si es "exact" o "amount_only" → todo correcto, no generar item
  }

  // --- Detectar transferencias entre cuentas internas no registradas ---
  // Buscar: mismo importe (±0.03), misma fecha (±1 día), en dos cuentas distintas
  if (targetAccount) {
    for (let i = 0; i < movements.length; i++) {
      const m = movements[i];
      if (!m.isTransfer) continue;
      // Buscar si ya hay una transferencia registrada entre cuentas
      const existingTransfers = transactions.filter(
        (t) => t.category === "Transferencia" && dateDist(t.date, m.date) <= 2
      );
      const alreadyLogged = existingTransfers.some(
        (t) => Math.abs(Math.abs(t.amount) - m.amount) < 0.03
      );
      if (!alreadyLogged && !checklist.find((c) => c.id === `miss-trf-${i}`)) {
        checklist.push({
          id: `trf-match-${i}`,
          type: "missing_transfer",
          severity: "high",
          mov: m,
          description: m.description,
          date: m.date,
          amount: m.amount,
          direction: m.direction,
          proposed: `Transferencia no registrada: "${m.description}" — ${fmtAmountShort(m.amount)}`,
          action: "add_transfer",
        });
      }
    }
  }

  // Ordenar: más severo primero, luego por fecha
  checklist.sort((a, b) => {
    const sev = { high: 0, medium: 1, low: 2 };
    const sa = sev[a.severity] ?? 2;
    const sb = sev[b.severity] ?? 2;
    if (sa !== sb) return sa - sb;
    return (a.date || "").localeCompare(b.date || "");
  });

  // --- Resumen ---
  const exactMatches = movements.length - checklist.length;

  return {
    account: targetAccount,
    accountConfidence: ident.confidence,
    accountReason: ident.reason,
    movementsExtracted: movements.length,
    exactMatches,
    period,
    summary: {
      totalMovements: movements.length,
      exactMatches,
      amountMismatches: checklist.filter((c) => c.type === "amount_mismatch").length,
      missingTransactions: checklist.filter((c) => c.type === "missing_transaction").length,
      missingTransfers: checklist.filter((c) => c.type === "missing_transfer").length,
    },
    checklist,
  };
}

// ---------- Helpers ----------

function fmtAmountShort(amount) {
  if (amount == null) return "—";
  return amount.toFixed(2);
}

// ---------- Re-export para UI ----------

/**
 * Construye la lista de correcciones aplicables desde el checklist.
 * Cada item sabe exactamente qué dispatch disparar.
 */
export function buildCorrectionActions(checklist, selectedAccountId, accounts) {
  const actions = [];
  for (const item of checklist) {
    switch (item.action) {
      case "add_transaction": {
        actions.push({
          id: item.id,
          type: "add_transaction",
          payload: {
            tx: {
              date: item.date,
              description: item.description?.slice(0, 60) || "Movimiento bancario",
              amount: item.direction === "out" ? -item.amount : item.amount,
              category: item.category || item.mov?.category || null,
              accountId: selectedAccountId,
              auto: false,
            },
          },
          label: `➕ ${item.description?.slice(0, 40) || "Movimiento"} — ${item.amount.toFixed(2)}`,
        });
        break;
      }
      case "correct_amount": {
        if (!item.tx) break;
        const newAmount = item.direction === "out" ? -item.amount : item.amount;
        actions.push({
          id: item.id,
          type: "update_transaction",
          payload: { id: item.tx.id, patch: { amount: Math.round(newAmount * 100) / 100 } },
          label: `✏️ "${item.description?.slice(0, 30)}": ${item.registeredAmount?.toFixed(2)} → ${item.amount.toFixed(2)}`,
        });
        break;
      }
      case "add_transfer": {
        // add_transfer necesita from/to — el usuario debe seleccionar contraparte
        actions.push({
          id: item.id,
          type: "add_transfer_partial",
          payload: {
            date: item.date,
            description: item.description,
            amount: item.amount,
            direction: item.direction,
            fromAccountId: item.direction === "out" ? selectedAccountId : null,
            toAccountId: item.direction === "in" ? selectedAccountId : null,
          },
          label: `🔄 ${item.description?.slice(0, 40) || "Transferencia"} — ${item.amount.toFixed(2)}`,
          needsCounterpart: true,
        });
        break;
      }
    }
  }
  return actions;
}
