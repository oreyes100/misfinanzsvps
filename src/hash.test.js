import { describe, it, expect } from "vitest";
import { stableStringify, syncableSliceOf, syncableHash } from "./utils.js";
import { stableStringify as srvStable, syncableSliceOf as srvSlice, syncableHash as srvHash } from "../api/_hash.js";

const baseState = {
  settings: { baseCurrency: "MXN", spendLimit: 1200 },
  accounts: [
    { id: "a1", name: "MLJR", balance: 25193.41, _updatedAt: 1 },
    { id: "a2", name: "DidiInv", balance: 95135.13, _updatedAt: 2 },
  ],
  assets: { crypto: [{ id: "btc", qty: 0.082 }], gold: { grams: 45 }, realEstate: [{ id: "re1", valueEUR: 73695 }] },
  transactions: [
    { id: "t1", date: "2026-08-12", amount: 217.57, _w17_splitFrom: "int-abc" },
    { id: "sp1", date: "2026-07-18", amount: 8.33 },
  ],
  scheduled: [],
  categories: [{ id: "c1", name: "Comida" }],
  transferAliases: { ooo: "a1" },
  categoryAliases: {},
  statementPatterns: {},
  reviewQueue: { pending: [], resolved: [], dismissed: [] },
  _syncVersion: 250,
  deletedTransactions: { gone: 1787253381065 },
  deletedAccountIds: [],
  deletedAssetIds: [],
};

describe("stableStringify", () => {
  it("ignora el orden de las claves (canónico)", () => {
    const a = { b: 1, a: { d: 2, c: 3 } };
    const b = { a: { c: 3, d: 2 }, b: 1 };
    expect(stableStringify(a)).toBe(stableStringify(b));
  });
  it("difiere si cambia el contenido", () => {
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
  });
  it("estable en arrays (claves reordenadas, mismo contenido)", () => {
    expect(stableStringify([{ a: 1, b: 2 }])).toBe(stableStringify([{ b: 2, a: 1 }]));
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1])); // el orden del array SÍ importa
  });
});

describe("syncableSliceOf", () => {
  it("excluye slices volátiles (fx/priceHistory/goldPriceEUR)", () => {
    const slice = syncableSliceOf({ ...baseState, fx: { EUR: 1 }, priceHistory: { BTC: [] }, goldPriceEUR: 68.4 });
    expect(slice.fx).toBeUndefined();
    expect(slice.priceHistory).toBeUndefined();
    expect(slice.goldPriceEUR).toBeUndefined();
    expect(slice.transactions).toHaveLength(2);
  });
});

describe("syncableHash", () => {
  it("hash igual para estados semánticamente iguales con distinto orden de claves", async () => {
    const scrambled = {
      _syncVersion: baseState._syncVersion,
      reviewQueue: baseState.reviewQueue,
      deletedTransactions: baseState.deletedTransactions,
      deletedAccountIds: baseState.deletedAccountIds,
      deletedAssetIds: baseState.deletedAssetIds,
      statementPatterns: baseState.statementPatterns,
      categoryAliases: baseState.categoryAliases,
      transferAliases: baseState.transferAliases,
      categories: baseState.categories,
      scheduled: baseState.scheduled,
      transactions: baseState.transactions,
      assets: { ...baseState.assets },
      accounts: baseState.accounts.map((a) => ({ _updatedAt: a._updatedAt, balance: a.balance, id: a.id, name: a.name })),
      settings: { ...baseState.settings },
    };
    expect(await syncableHash(baseState)).toBe(await syncableHash(scrambled));
  });

  it("hash distinto si cambia un balance (estado divergente)", async () => {
    const diverged = { ...baseState, accounts: [{ ...baseState.accounts[0], balance: 5013349.9 }] };
    expect(await syncableHash(baseState)).not.toBe(await syncableHash(diverged));
  });

  it("cliente (webcrypto) y server (node:crypto) producen el MISMO hash", async () => {
    const client = await syncableHash(baseState);
    const server = srvHash(baseState);
    expect(client).toBe(server);
  });

  it("slices canónicos idénticos entre cliente y server", () => {
    const cs = syncableSliceOf(baseState);
    const ss = srvSlice(baseState);
    expect(stableStringify(cs)).toBe(stableStringify(ss));
  });

  it("W22: baseCurrency no afecta el hash (preferencia local)", async () => {
    const withMXN = { ...baseState, settings: { ...baseState.settings, baseCurrency: "MXN" } };
    const withEUR = { ...baseState, settings: { ...baseState.settings, baseCurrency: "EUR" } };
    const withUSD = { ...baseState, settings: { ...baseState.settings, baseCurrency: "USD" } };
    expect(await syncableHash(withMXN)).toBe(await syncableHash(withEUR));
    expect(await syncableHash(withMXN)).toBe(await syncableHash(withUSD));
  });

  it("W22: syncableSliceOf excluye baseCurrency de settings", () => {
    const slice = syncableSliceOf(baseState);
    expect(slice.settings.baseCurrency).toBeUndefined();
    expect(slice.settings.spendLimit).toBe(1200);
  });

  it("W22: server y cliente excluyen baseCurrency de forma idéntica", () => {
    const withMXN = { ...baseState, settings: { ...baseState.settings, baseCurrency: "MXN" } };
    const withEUR = { ...baseState, settings: { ...baseState.settings, baseCurrency: "EUR" } };
    expect(stableStringify(syncableSliceOf(withMXN))).toBe(stableStringify(srvSlice(withMXN)));
    expect(stableStringify(syncableSliceOf(withEUR))).toBe(stableStringify(srvSlice(withEUR)));
  });

  it("W22: hash estable ignora _isDemo y _demoSeededAt (no están en SYNCABLE_KEYS)", async () => {
    const a = { ...baseState, _isDemo: true, _demoSeededAt: 100 };
    const b = { ...baseState };
    expect(await syncableHash(a)).toBe(await syncableHash(b));
  });

  it("W22: syncableSliceOf preserva spendLimit y biometric (no solo baseCurrency)", () => {
    const state = { settings: { baseCurrency: "EUR", spendLimit: 500, biometric: false }, accounts: [] };
    const slice = syncableSliceOf(state);
    expect(slice.settings.spendLimit).toBe(500);
    expect(slice.settings.biometric).toBe(false);
    expect(slice.settings.baseCurrency).toBeUndefined();
  });

  it("W22: server syncableSliceOf excluye baseCurrency igual que cliente", () => {
    const state = { settings: { baseCurrency: "EUR", spendLimit: 500 }, accounts: [] };
    const clientSlice = syncableSliceOf(state);
    const serverSlice = srvSlice(state);
    expect(stableStringify(clientSlice)).toBe(stableStringify(serverSlice));
  });
});