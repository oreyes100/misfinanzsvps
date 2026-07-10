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

function findMatch(mov, accountTransactions, consumed) {
  let best = { tx: null, score: -1, type: null };

  for (const tx of accountTransactions) {
    if (consumed.has(tx.id)) continue; // 1-a-1: una tx registrada solo cubre UN movimiento del extracto
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

    // Match solo por importe + fecha (descripción muy distinta) — sospechoso, no silencioso
    if (amountMatch && dd <= 2 && ds <= 0.55) {
      const score = 0.3 - dd * 0.05;
      if (score > best.score) {
        best = { tx, score, type: "detail_mismatch" };
      }
    }
  }

  if (best.score >= 0) consumed.add(best.tx.id);
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
  const consumed = new Set(); // ids de txs registradas ya emparejadas (matching 1-a-1)

  for (let i = 0; i < movements.length; i++) {
    const mov = movements[i];
    const match = findMatch(mov, accountTx, consumed);

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
          proposal: {
            description: mov.description?.slice(0, 60) || "Movimiento bancario",
            amount: mov.amount,
            date: mov.date,
            category: mov.category || null,
            notes: "",
          },
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
        proposal: {
          description: tx.description,
          amount: mov.amount,
          date: tx.date,
          category: tx.category || null,
          notes: tx.notes || "",
        },
      });
    }

    if (match.type === "detail_mismatch") {
      // Mismo importe y fecha pero descripción muy distinta — posible asiento mal descrito
      const tx = match.tx;
      checklist.push({
        id: `det-${i}`,
        type: "detail_mismatch",
        severity: "low",
        mov,
        tx,
        description: mov.description,
        date: mov.date,
        amount: mov.amount,
        registeredDescription: tx.description,
        direction: tx.amount > 0 ? "in" : "out",
        proposed: `Verificar asiento: registrado como "${tx.description}", el extracto dice "${mov.description}"`,
        action: "correct_details",
        proposal: {
          description: mov.description?.slice(0, 60) || tx.description,
          amount: Math.abs(tx.amount),
          date: tx.date,
          category: tx.category || null,
          notes: tx.notes || "",
        },
      });
    }

    // Solo "exact" pasa sin generar item
  }

  // --- Asientos fantasma: registrados en la app dentro del período pero ausentes del extracto ---
  if (targetAccount && period) {
    for (const tx of accountTx) {
      if (consumed.has(tx.id)) continue;
      if (!tx.date || tx.date < period.from || tx.date > period.to) continue;
      checklist.push({
        id: `phantom-${tx.id}`,
        type: "phantom_transaction",
        severity: "medium",
        tx,
        description: tx.description,
        date: tx.date,
        amount: Math.abs(tx.amount),
        direction: tx.amount > 0 ? "in" : "out",
        proposed: `"${tx.description}" (${fmtAmountShort(Math.abs(tx.amount))}) está registrado pero NO aparece en el estado de cuenta — verificar o eliminar`,
        action: "remove_transaction",
        proposal: {
          description: tx.description,
          amount: Math.abs(tx.amount),
          date: tx.date,
          category: tx.category || null,
          notes: tx.notes || "",
        },
      });
    }
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
  // Coincidencias exactas = movimientos del extracto sin ningún item de discrepancia asociado
  const movementIssues = checklist.filter((c) => c.type !== "phantom_transaction").length;
  const exactMatches = Math.max(0, movements.length - movementIssues);

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
      phantomTransactions: checklist.filter((c) => c.type === "phantom_transaction").length,
      detailMismatches: checklist.filter((c) => c.type === "detail_mismatch").length,
    },
    checklist,
  };
}

// ---------- Fusión con auditoría IA ----------

const AI_KIND_MAP = {
  missing: { type: "missing_transaction", action: "add_transaction", severity: "high" },
  phantom: { type: "phantom_transaction", action: "remove_transaction", severity: "medium" },
  amount_mismatch: { type: "amount_mismatch", action: "correct_amount", severity: "medium" },
  detail_mismatch: { type: "detail_mismatch", action: "correct_details", severity: "low" },
  wrong_sign: { type: "wrong_sign", action: "correct_sign", severity: "high" },
};

/**
 * Convierte los hallazgos de aiAudit (ocr.js) al formato del checklist local.
 * La IA es la fuente autoritativa cuando está disponible; este resultado
 * REEMPLAZA al checklist heurístico.
 */
export function aiItemsToChecklist(items, transactions) {
  const byId = new Map((transactions || []).map((t) => [t.id, t]));
  const checklist = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const map = AI_KIND_MAP[it.kind];
    if (!map) continue;
    const tx = it.txId ? byId.get(it.txId) || null : null;
    // phantom/mismatch requieren tx real; si la IA alucinó el id, degradar a missing
    if ((it.kind !== "missing") && it.txId && !tx) continue;
    checklist.push({
      id: `ai-${it.kind}-${i}`,
      type: map.type,
      severity: it.severity && ["high", "medium", "low"].includes(it.severity) ? it.severity : map.severity,
      mov: null,
      tx,
      description: it.description || tx?.description || "—",
      date: it.date || tx?.date || null,
      amount: it.amount,
      registeredAmount: tx ? Math.abs(tx.amount) : undefined,
      registeredDescription: tx?.description,
      difference: tx && it.kind === "amount_mismatch" ? Math.abs(it.amount - Math.abs(tx.amount)) : undefined,
      direction: it.direction || (tx && tx.amount > 0 ? "in" : "out"),
      proposed: it.explanation || "",
      action: map.action,
      category: it.proposal?.category || null,
      proposal: it.proposal || {
        description: it.description || "",
        amount: it.amount,
        date: it.date || null,
        category: null,
        notes: "",
      },
      source: "ai",
    });
  }
  const sev = { high: 0, medium: 1, low: 2 };
  checklist.sort((a, b) => (sev[a.severity] ?? 2) - (sev[b.severity] ?? 2) || (a.date || "").localeCompare(b.date || ""));
  return checklist;
}

/** Recalcula el summary desde un checklist (para cuando la IA reemplaza al heurístico). */
export function summarizeChecklist(checklist, totalMovements) {
  const count = (t) => checklist.filter((c) => c.type === t).length;
  const movementIssues = checklist.filter((c) => c.type !== "phantom_transaction").length;
  return {
    totalMovements,
    exactMatches: Math.max(0, totalMovements - movementIssues),
    amountMismatches: count("amount_mismatch"),
    missingTransactions: count("missing_transaction"),
    missingTransfers: count("missing_transfer"),
    phantomTransactions: count("phantom_transaction"),
    detailMismatches: count("detail_mismatch"),
    wrongSigns: count("wrong_sign"),
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
      case "correct_details": {
        if (!item.tx) break;
        actions.push({
          id: item.id,
          type: "update_transaction",
          payload: { id: item.tx.id, patch: { description: item.proposal?.description || item.description } },
          label: `✏️ Actualizar descripción: "${item.proposal?.description?.slice(0, 40)}"`,
        });
        break;
      }
      case "remove_transaction": {
        if (!item.tx) break;
        actions.push({
          id: item.id,
          type: "delete_transaction",
          payload: { id: item.tx.id },
          label: `🗑 Eliminar asiento no respaldado: "${item.description?.slice(0, 40)}"`,
        });
        break;
      }
      case "correct_sign": {
        if (!item.tx) break;
        const fixed = item.direction === "out" ? -Math.abs(item.tx.amount) : Math.abs(item.tx.amount);
        actions.push({
          id: item.id,
          type: "update_transaction",
          payload: { id: item.tx.id, patch: { amount: Math.round(fixed * 100) / 100 } },
          label: `↔️ Corregir signo: "${item.description?.slice(0, 40)}"`,
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
