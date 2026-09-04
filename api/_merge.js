// Merge de estados de sync en servidor. Autocontenido (no importa de src/).
// Convención Vercel: archivos api/_*.js NO se exponen como endpoints.
export function mergeById(a, b) {
  const list = Array.isArray(a) ? [...a] : [];
  const map = new Map(list.map((x) => [x.id, x]));
  for (const item of Array.isArray(b) ? b : []) {
    const prev = map.get(item.id);
    if (!prev || (item._updatedAt || 0) > (prev._updatedAt || 0)) map.set(item.id, item);
  }
  return [...map.values()];
}

// Dedupe de intereses automáticos por clave compuesta (los legacy usan id aleatorio).
// W37-fix: la clave NO incluye la descripción — las 3 rutas de interés (normal/
// aplazados/ISR) describen el MISMO interés semántico con textos distintos y las
// 3 copias sobrevivían al dedupe (103 duplicados +10.42 documentados).
// W37b-fix: POR CATEGORÍA sin el requisito `auto` — los duplicados legacy vienen
// SIN el flag auto y el dedupe los saltaba (volvían al consolidar pushes viejos).
// W37d-fix: conservar la copia con `_updatedAt` MÁS ALTO por grupo — el
// first-seen conservaba la hermana EPOC/original y DROPPABA la edición del
// usuario (la revertía como "sibling" del dedupe).
export function dedupeAutoInterest(txs) {
  const best = new Map(); // key -> { t, order }
  let order = 0;
  for (const t of txs) {
    const isInterestClass = t && (t.category === "Intereses" || t.category === "Impuestos");
    if (!isInterestClass) { order++; continue; }
    // W37c-ROLLBACK: el importe VUELVE a la clave — el W37c sin el importe fusionó
    // variantes semánticamente DIFERENTES (10.42 ganancia vs 10.43 ISR-capped) y
    // borró las entradas legítimas (daño 884→290 confirmado). Los duplicados
    // verdaderos son EXACTOS en los centavos.
    const key = `${t.accountId}|${t.date}|${t.amount}`;
    const prev = best.get(key);
    const upd = t._updatedAt || 0;
    if (!prev) {
      best.set(key, { t, upd, order: order++ });
    } else if (upd > prev.upd) {
      // la más nueva gana el grupo; conserva la posición de la primera aparición
      best.set(key, { t, upd, order: prev.order });
    }
  }
  const ranked = [...best.values()].sort((a, b) => a.order - b.order);
  const interestOut = new Map(ranked.map((r) => [r.order, r.t]));
  const out = [];
  let o = 0;
  for (const t of txs) {
    const isInterestClass = t && (t.category === "Intereses" || t.category === "Impuestos");
    if (!isInterestClass) { out.push(t); continue; }
    const keep = interestOut.get(o);
    if (keep) out.push(keep);
    o++;
  }
  return out;
}

// W23: Consolida el delta entrante contra el estado existente de forma
// DETERMINISTA y avanza _syncVersion (server = única fuente de verdad).
// El +1 garantiza que TODOS los clientes detecten la nueva versión
// autoritativa y reemplacen su estado local (fin del merge por entidad en el
// cliente). Si no hay estado previo, el incoming se vuelve la base y se
// normaliza su _syncVersion (si le falta, se arranca en 1).
export function consolidateAndBump(existing, incoming) {
  if (!incoming || typeof incoming !== "object") return existing;
  if (!existing || typeof existing !== "object") return incoming;
  const merged = mergeStates(existing, incoming);
  const nextVersion = Math.max(existing._syncVersion || 0, incoming._syncVersion || 0) + 1;
  return { ...merged, _syncVersion: nextVersion };
}

export function mergeStates(existing, incoming) {
  if (!existing || typeof existing !== "object") return incoming;
  if (!incoming || typeof incoming !== "object") return existing;
  const deletedTransactions = { ...(existing.deletedTransactions || {}), ...(incoming.deletedTransactions || {}) };
  const deletedAccountIds = [...new Set([...(existing.deletedAccountIds || []), ...(incoming.deletedAccountIds || [])])];
  let transactions = mergeById(existing.transactions, incoming.transactions)
    .filter((t) => !deletedTransactions[t.id]);
  transactions = dedupeAutoInterest(transactions);
  const deletedAssetIds = [...new Set([...(existing.deletedAssetIds || []), ...(incoming.deletedAssetIds || [])])];
  const rawAssets = incoming.assets ? {
    ...(existing.assets || {}), ...incoming.assets,
    crypto: mergeById((existing.assets || {}).crypto, (incoming.assets || {}).crypto),
    realEstate: mergeById((existing.assets || {}).realEstate, (incoming.assets || {}).realEstate),
    depreciating: mergeById((existing.assets || {}).depreciating, (incoming.assets || {}).depreciating),
  } : existing.assets;
  const assets = deletedAssetIds.length ? {
    ...rawAssets,
    crypto: (rawAssets.crypto || []).filter((c) => !deletedAssetIds.includes(c.id)),
    realEstate: (rawAssets.realEstate || []).filter((r) => !deletedAssetIds.includes(r.id)),
    depreciating: (rawAssets.depreciating || []).filter((d) => !deletedAssetIds.includes(d.id)),
  } : rawAssets;
  return {
    ...existing, ...incoming,
    _syncVersion: Math.max(existing._syncVersion || 0, incoming._syncVersion || 0),
    settings: { ...(existing.settings || {}), ...(incoming.settings || {}) },
    accounts: mergeById(existing.accounts, incoming.accounts).filter((a) => !deletedAccountIds.includes(a.id)),
    transactions, deletedTransactions, deletedAccountIds, deletedAssetIds,
    scheduled: mergeById(existing.scheduled, incoming.scheduled),
    categories: mergeById(existing.categories, incoming.categories),
    transferAliases: { ...(existing.transferAliases || {}), ...(incoming.transferAliases || {}) },
    categoryAliases: { ...(existing.categoryAliases || {}), ...(incoming.categoryAliases || {}) },
    statementPatterns: { ...(existing.statementPatterns || {}), ...(incoming.statementPatterns || {}) },
    assets,
  };
}
