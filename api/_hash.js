// _hash.js — Hash canónico de convergencia (W18) para el server (Vercel + local).
// Autocontenido (no importa de src/). Espejo EXACTO de syncableHash en src/utils.ts.
import { createHash } from "node:crypto";

export const SYNCABLE_KEYS = [
  "settings", "accounts", "assets", "transactions", "scheduled", "categories",
  "transferAliases", "categoryAliases", "statementPatterns", "reviewQueue",
  "_syncVersion", "deletedTransactions", "deletedAccountIds", "deletedAssetIds",
];

export function stableStringify(value) {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") + "}";
}

export function syncableSliceOf(state) {
  const out = {};
  for (const k of SYNCABLE_KEYS) if (k in state) out[k] = state[k];
  // W22: baseCurrency es preferencia local (device). No se incluye en el hash
  // para evitar resync perpetuo cuando dos clientes tienen distinta divisa.
  if (out.settings && typeof out.settings === "object") {
    const { baseCurrency, ...rest } = out.settings;
    out.settings = rest;
  }
  return out;
}

/** SHA-256 hex del slice canónico (server: node:crypto). */
export function syncableHash(state) {
  return createHash("sha256").update(stableStringify(syncableSliceOf(state))).digest("hex");
}