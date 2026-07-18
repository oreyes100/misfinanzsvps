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
export function dedupeAutoInterest(txs) {
  const seen = new Set();
  const out = [];
  for (const t of txs) {
    const isAutoInterest = t && t.auto && (t.category === "Intereses" || t.category === "Impuestos");
    if (!isAutoInterest) { out.push(t); continue; }
    const key = `${t.accountId}|${t.date}|${t.description}|${t.amount}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

export function mergeStates(existing, incoming) {
  if (!existing || typeof existing !== "object") return incoming;
  if (!incoming || typeof incoming !== "object") return existing;
  const deletedTransactions = { ...(existing.deletedTransactions || {}), ...(incoming.deletedTransactions || {}) };
  const deletedAccountIds = [...new Set([...(existing.deletedAccountIds || []), ...(incoming.deletedAccountIds || [])])];
  let transactions = mergeById(existing.transactions, incoming.transactions)
    .filter((t) => !deletedTransactions[t.id]);
  transactions = dedupeAutoInterest(transactions);
  const assets = incoming.assets ? {
    ...(existing.assets || {}), ...incoming.assets,
    crypto: mergeById((existing.assets || {}).crypto, (incoming.assets || {}).crypto),
    realEstate: mergeById((existing.assets || {}).realEstate, (incoming.assets || {}).realEstate),
    depreciating: mergeById((existing.assets || {}).depreciating, (incoming.assets || {}).depreciating),
  } : existing.assets;
  return {
    ...existing, ...incoming,
    _syncVersion: Math.max(existing._syncVersion || 0, incoming._syncVersion || 0),
    settings: { ...(existing.settings || {}), ...(incoming.settings || {}) },
    accounts: mergeById(existing.accounts, incoming.accounts).filter((a) => !deletedAccountIds.includes(a.id)),
    transactions, deletedTransactions, deletedAccountIds,
    scheduled: mergeById(existing.scheduled, incoming.scheduled),
    categories: mergeById(existing.categories, incoming.categories),
    transferAliases: { ...(existing.transferAliases || {}), ...(incoming.transferAliases || {}) },
    categoryAliases: { ...(existing.categoryAliases || {}), ...(incoming.categoryAliases || {}) },
    statementPatterns: { ...(existing.statementPatterns || {}), ...(incoming.statementPatterns || {}) },
    assets,
  };
}
