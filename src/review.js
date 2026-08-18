// review.js — Cola de revisión MCP (Command Center). Lógica pura y testeable.
//
// La cola absorbe el human-in-the-loop de Assistant: un intent se ENCOLA como
// item pendiente (staging) con su acción, y el usuario aprueba/corrige/descarta
// desde el menú MCP. Los transforms devuelven un NUEVO objeto reviewQueue
// (inmutables), listos para usarse en el reducer de store.jsx.

// ═══ Umbrales de clasificación ═══
export const FIX_THRESHOLD = 0.6;    // confianza < 0.6  → needs_fix (requiere corrección)
export const REVIEW_THRESHOLD = 0.8; // confianza < 0.8  → needs_review (requiere revisión)
                                     // confianza >= 0.8 → auto_ok (no entra a pending)

export const CLASS_NEEDS_FIX = "needs_fix";
export const CLASS_NEEDS_REVIEW = "needs_review";
export const CLASS_AUTO_OK = "auto_ok";

// ═══ Evidencia de propuesta (Wargame 10) ═══
// Regla de negocio: toda propuesta del MCP tiene evidencia real:
//   • OCR / Google Photos → receipt (imagen en IndexedDB)
//   • Sync / import       → statement (los datos del movimiento bancario)
//   • Manual              → none
// La evidencia se DERIVA del item real (preview + source + receiptId),
// sin inventar campos que el modelo no tiene (bank/reference no existen).
export function buildEvidence(item) {
  if (!item) return { kind: "none" };
  const hasReceipt = Boolean(item.receiptUrl || item.receiptBlob || item.receiptId);
  if (hasReceipt) {
    return {
      kind: "receipt",
      receiptUrl: item.receiptUrl,
      receiptBlob: item.receiptBlob,
      receiptId: item.receiptId,
    };
  }
  const src = item.source || "manual";
  if (src === "sync" || src === "import") {
    const p = item.preview || {};
    return {
      kind: "statement",
      accountName: p.accountName || "",
      accountId: p.accountId || "",
      date: p.date || "",
      description: p.description || "",
      amount: p.amount != null ? p.amount : null,
    };
  }
  if (src === "ocr") {
    return { kind: "ocr", description: item.preview?.description || "" };
  }
  return { kind: "none" };
}

/** Clasifica una confianza (0..1) en severity de revisión. */
export function classifyConfidence(confidence) {
  const c = Number(confidence);
  if (!Number.isFinite(c)) return CLASS_NEEDS_REVIEW;
  if (c < FIX_THRESHOLD) return CLASS_NEEDS_FIX;
  if (c < REVIEW_THRESHOLD) return CLASS_NEEDS_REVIEW;
  return CLASS_AUTO_OK;
}

// ═══ Acción staged ═══
/**
 * Convierte un intent (parseIntent) + cuentas resueltas en la acción a
 * dispatchear al aceptar. Devuelve null si el intent no es accionable.
 */
export function buildStagedAction(intent, accounts) {
  if (!intent || !Array.isArray(accounts) || !accounts.length) return null;

  switch (intent.type) {
    case "expense":
    case "income": {
      const acc = intent._resolvedAccount || accounts[0];
      return {
        type: "add_transaction",
        tx: {
          description: intent.description,
          amount: intent.type === "expense" ? -intent.amount : intent.amount,
          currency: acc.currency,
          accountId: acc.id,
          category: intent.category,
          subcategory: intent.subcategory || null,
        },
      };
    }
    case "transfer": {
      const from = intent._fromAccount || accounts[0];
      const to = intent._toAccount || accounts[1] || accounts[0];
      return { type: "transfer", fromId: from.id, toId: to.id, amount: intent.amount };
    }
    case "schedule_transfer": {
      const from = intent._fromAccount || accounts[0];
      const to = intent._toAccount || accounts[1] || accounts[0];
      return {
        type: "schedule_transfer",
        item: {
          fromId: from.id,
          toId: to.id,
          amount: intent.amount,
          when: "próximo día hábil",
          created: todayISO(),
          ...(intent.description ? { notes: intent.description } : {}),
        },
      };
    }
    case "set_limit":
      return { type: "set_limit", amount: intent.amount };
    default:
      return null;
  }
}

// ═══ Transforms inmutables de la cola ═══

export function emptyQueue() {
  return { pending: [], resolved: [], dismissed: [] };
}

/** Encola un item (dedupe por id). No añade items sin id. */
export function enqueueItem(queue, item) {
  if (!item?.id) return queue;
  if (queue.pending.some((i) => i.id === item.id)) return queue;
  return { ...queue, pending: [item, ...queue.pending] };
}

/** Acepta un item pendiente → resolved (con resolvedAt). */
export function acceptItem(queue, itemId) {
  const item = queue.pending.find((i) => i.id === itemId);
  if (!item) return queue;
  return {
    ...queue,
    pending: queue.pending.filter((i) => i.id !== itemId),
    resolved: [{ ...item, resolvedAt: Date.now() }, ...queue.resolved],
  };
}

/** Descarta un item pendiente → dismissed (con dismissedAt). */
export function dismissItem(queue, itemId) {
  const item = queue.pending.find((i) => i.id === itemId);
  if (!item) return queue;
  return {
    ...queue,
    pending: queue.pending.filter((i) => i.id !== itemId),
    dismissed: [{ ...item, dismissedAt: Date.now() }, ...queue.dismissed],
  };
}

/** Acepta todos los items needs_review (las sugerencias de revisión). */
export function acceptAllReviewable(queue) {
  const accepted = queue.pending.filter((i) => i.classification === CLASS_NEEDS_REVIEW);
  if (!accepted.length) return queue;
  const ids = new Set(accepted.map((i) => i.id));
  return {
    ...queue,
    pending: queue.pending.filter((i) => !ids.has(i.id)),
    resolved: [...accepted.map((i) => ({ ...i, resolvedAt: Date.now() })), ...queue.resolved],
  };
}

/** Descarta todos los items pendientes. */
export function dismissAll(queue) {
  if (!queue.pending.length) return queue;
  return {
    ...queue,
    pending: [],
    dismissed: [...queue.pending.map((i) => ({ ...i, dismissedAt: Date.now() })), ...queue.dismissed],
  };
}

// ═══ Cleanup (fase 3) ═══
export const RESOLVED_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 días
export const DISMISSED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 días
export const MAX_RESOLVED_ITEMS = 1000;

/** Poda historial: resolved > 30d y dismissed > 7d se eliminan. Cap a 1000 resolved. */
export function cleanupReviewQueue(queue, now = Date.now()) {
  const resolved = queue.resolved
    .filter((i) => now - (i.resolvedAt ?? i.createdAt) < RESOLVED_MAX_AGE_MS)
    .slice(0, MAX_RESOLVED_ITEMS);
  const dismissed = queue.dismissed.filter(
    (i) => now - (i.dismissedAt ?? i.createdAt) < DISMISSED_MAX_AGE_MS
  );
  return { ...queue, resolved, dismissed };
}

// ═══ Auto-captura de revisión (GHOST PIPELINE) ═══
// El server marca cada transacción ingerida con `_categoryConfidence` y
// `needsCategoryReview`. Estas txs NO generaban items de revisión en el frontend:
// el pipeline existía pero era silencioso. Aquí se materializan como items
// `unreviewed-<txId>` que entran a la cola (dedupe por id en enqueueItem).

const MAX_AUTO_ENQUEUE_PER_BATCH = 50; // cap: no inundar la cola en un restore grande

/**
 * Convierte transacciones sin categoría / con categoría fallback / confianza baja
 * en items de revisión. Devuelve array de items listos para enqueueItem.
 * - tx con `category` vacía/null            → classification = needs_fix (no clasificada)
 * - tx con `needsCategoryReview === true`   → classification vía classifyConfidence
 * - tx con `_categoryConfidence < 0.8`      → classification vía classifyConfidence
 * - tx con `category` válida y confianza >= 0.8 → NO genera item
 * - tx ya aceptada/descartada (ids en `resolvedIds`) → NO genera item (idempotente)
 */
export function buildUnreviewedItems(txs, { accounts = [], resolvedIds = new Set() } = {}) {
  if (!Array.isArray(txs)) return [];
  const items = [];
  for (const tx of txs) {
    if (!tx?.id) continue;
    if (resolvedIds.has(`unreviewed-${tx.id}`)) continue;
    const confidence = Number(tx._categoryConfidence);
    const hasConfidence = Number.isFinite(confidence) && tx._categoryConfidence !== undefined;
    const cat = typeof tx.category === "string" ? tx.category.trim() : "";
    const needsReview =
      !cat ||
      cat === "null" ||
      tx.needsCategoryReview === true ||
      (hasConfidence && confidence < REVIEW_THRESHOLD);

    if (!needsReview) continue;

    const classification = hasConfidence ? classifyConfidence(confidence) : CLASS_NEEDS_FIX;
    if (classification === CLASS_AUTO_OK) continue; // confianza >= 0.8 no entra a pending

    // WG11: conflictos OCR llegan como txs sin resolver (pendingResolution) —
    // el item los hereda para que el EditPanel muestre motivo y evidencia.
    const pendingResolution = tx.pendingResolution || null;
    const conflict = !!pendingResolution;

    const accountName =
      accounts.find((a) => a.id === tx.accountId)?.name ||
      (tx.currency ? `${tx.currency.toUpperCase()}` : "Desconocida");

    items.push({
      id: `unreviewed-${tx.id}`,
      source: "sync",
      classification: conflict ? CLASS_NEEDS_FIX : classification,
      confidence: hasConfidence ? confidence : 0,
      createdAt: Date.now(),
      autoCaptured: true,
      pendingResolution,
      receiptUrl: tx.evidenceUrl ? `/api/evidence/${tx.evidenceUrl}` : undefined,
      preview: {
        description: tx.description || "Sin descripción",
        amount: tx.amount ?? 0,
        currency: tx.currency ?? null,
        category: cat || null,
        categoryId: null,
        accountId: tx.accountId,
        accountName,
        date: tx.date || null,
      },
      action: conflict
        ? {
            type: "add_transaction",
            tx: {
              description: tx.description || "",
              amount: tx.amount ?? 0,
              currency: tx.currency ?? null,
              accountId: tx.accountId || null,
              category: null,
              date: tx.date || null,
              pendingResolution,
            },
          }
        : null, // no hay acción staged: solo categorización
    });
    if (items.length >= MAX_AUTO_ENQUEUE_PER_BATCH) break;
  }
  return items;
}

// ═══ Cálculos derivados (selectores pequeños) ═══

/** Cuenta de pendientes por severidad. */
export function pendingCounts(queue) {
  const pending = queue?.pending || [];
  return {
    total: pending.length,
    needsFix: pending.filter((i) => i.classification === CLASS_NEEDS_FIX).length,
    needsReview: pending.filter((i) => i.classification === CLASS_NEEDS_REVIEW).length,
  };
}

function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}