// Merge logic for transactional sync push (GET → merge → POST).
// Pure functions: no accrueInterest, no side effects.
import { DEMO_ACCOUNT_IDS } from "./utils.js";

export function mergeByID(local, cloud, key = "id") {
  if (!Array.isArray(cloud) || !cloud.length) return Array.isArray(local) ? local : [];
  if (!Array.isArray(local)) return cloud;
  const map = new Map(local.map((x) => [x[key], x]));
  const demoSet = new Set(DEMO_ACCOUNT_IDS);
  let changed = false;
  for (const item of cloud) {
    const itemId = item[key];
    const existing = map.get(itemId);
    if (key === "id" && demoSet.has(itemId) && !existing) continue;
    if (!existing || (item._updatedAt || 0) > (existing._updatedAt || 0)) {
      map.set(itemId, item);
      changed = true;
    }
  }
  return changed ? [...map.values()] : local;
}

/** Merges two syncable slices (last-_updatedAt wins per entity). No accrueInterest. */
export function mergeSyncStates(local, cloud) {
  if (!cloud || typeof cloud !== "object") return local;
  if (!local || typeof local !== "object") return cloud;

  const mergedDeletedAccountIds = [...new Set([...(local.deletedAccountIds || []), ...(cloud.deletedAccountIds || [])])];
  const mergedDeleted = { ...(local.deletedTransactions || {}), ...(cloud.deletedTransactions || {}) };

  let mergedTxs = mergeByID(local.transactions, cloud.transactions);
  mergedTxs = mergedTxs.filter((t) => !mergedDeleted[t.id]);

  return {
    ...local,
    _syncVersion: Math.max(local._syncVersion || 0, cloud._syncVersion || 0),
    settings: { ...(local.settings || {}), ...(cloud.settings || {}) },
    accounts: mergeByID(local.accounts, cloud.accounts).filter((a) => !mergedDeletedAccountIds.includes(a.id)),
    transactions: mergedTxs,
    scheduled: mergeByID(local.scheduled, cloud.scheduled),
    deletedTransactions: mergedDeleted,
    deletedAccountIds: mergedDeletedAccountIds,
    categories: mergeByID(local.categories, cloud.categories, "id"),
    transferAliases: { ...(local.transferAliases || {}), ...(cloud.transferAliases || {}) },
    categoryAliases: { ...(local.categoryAliases || {}), ...(cloud.categoryAliases || {}) },
    statementPatterns: { ...(local.statementPatterns || {}), ...(cloud.statementPatterns || {}) },
    assets: (() => {
      const mergedDeletedAssetIds = [...new Set([...(local.deletedAssetIds || []), ...(cloud.deletedAssetIds || [])])];
      const merged = cloud.assets ? {
        ...(local.assets || {}),
        ...cloud.assets,
        crypto: mergeByID((local.assets || {}).crypto || [], cloud.assets.crypto || []),
        realEstate: mergeByID((local.assets || {}).realEstate || [], cloud.assets.realEstate || []),
        depreciating: mergeByID((local.assets || {}).depreciating || [], cloud.assets.depreciating || []),
      } : local.assets;
      if (!mergedDeletedAssetIds.length) return merged;
      return { ...merged, crypto: (merged.crypto || []).filter((c) => !mergedDeletedAssetIds.includes(c.id)), realEstate: (merged.realEstate || []).filter((r) => !mergedDeletedAssetIds.includes(r.id)), depreciating: (merged.depreciating || []).filter((d) => !mergedDeletedAssetIds.includes(d.id)) };
    })(),
    deletedAssetIds: [...new Set([...(local.deletedAssetIds || []), ...(cloud.deletedAssetIds || [])])],
  };
}
