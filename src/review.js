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