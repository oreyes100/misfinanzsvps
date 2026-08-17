// state-corruption.test.js — FASE 5: Fortaleza de Datos (MCP-05).
//
// WAL (Write-Ahead Log) + checkpoints + recovery ante corrupción + export/import.
// Entorno Node (vitest), JS puro sin sintaxis TS, imports sin extensión.
import { describe, it, expect } from "vitest";
import { MemoryStorage, hasLocalStorage, createKeyValueStorage, fnv1a, stableStringify } from "../persistence-types";
import { WriteAheadLog } from "../write-ahead-log";
import { CheckpointManager } from "../checkpoint-manager";
import { RecoveryManager } from "../recovery-manager";
import { ExportImport } from "../export-import";
import { PersistenceOrchestrator } from "../persistence-orchestrator";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const makeState = (version, extra = {}) => ({
  accounts: [{ id: "a1", balance: 100 + version }],
  _syncVersion: version,
  ...extra,
});

// Entorno de prueba: almacenamiento compartido + config con flush inmediato.
const makeEnv = (keyPrefix = "t") => {
  const storage = new MemoryStorage();
  const config = {
    wal: { storage: "localStorage", flushIntervalMs: 0, keyPrefix, storageAdapter: storage },
    checkpoints: { storage: "localStorage", maxHistory: 2, keyPrefix, storageAdapter: storage },
    recovery: { autoHeal: true, maxToleratedDamage: 3 },
    exportImport: { signingKey: "test-key", verifyOnImport: true },
    orchestration: { checkpointEvery: { mutations: 5, intervalMs: 0 }, rollbackLimit: 2 },
  };
  return { storage, config };
};

const corruptWal = (storage, keyPrefix, mutate) => {
  const key = `${keyPrefix}:wal`;
  const payload = JSON.parse(storage.getItem(key));
  mutate(payload.entries);
  storage.setItem(key, JSON.stringify(payload));
};

const corruptCheckpoints = (storage, keyPrefix, mutate) => {
  const key = `${keyPrefix}:checkpoints`;
  const payload = JSON.parse(storage.getItem(key));
  mutate(payload.checkpoints);
  storage.setItem(key, JSON.stringify(payload));
};

// ─── WAL ───────────────────────────────────────────────────────
describe("FASE 5 · WriteAheadLog", () => {
  it("1. append → flush → carga: seq incremental y checksum íntegro", () => {
    const { storage } = makeEnv("t1");
    const wal = new WriteAheadLog({ storage: "localStorage", flushIntervalMs: 0, keyPrefix: "t1", storageAdapter: storage });
    wal.append({ version: 1, state: makeState(1) });
    wal.append({ version: 2, state: makeState(2) });
    wal.append({ version: 3, state: makeState(3) });
    expect(wal.getLastSeq()).toBe(2);
    expect(wal.verify().ok).toBe(true);

    // Simular re-apertura: leer desde almacenamiento persistido.
    const wal2 = new WriteAheadLog({ storage: "localStorage", flushIntervalMs: 0, keyPrefix: "t1", storageAdapter: storage });
    expect(wal2.getEntries().map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(wal2.verify().ok).toBe(true);
    wal.destroy();
    wal2.destroy();
  });

  it("2. compact(seq) conserva entradas posteriores y mantiene la cadena", () => {
    const { storage } = makeEnv("t2");
    const wal = new WriteAheadLog({ storage: "localStorage", flushIntervalMs: 0, keyPrefix: "t2", storageAdapter: storage });
    wal.append({ version: 1, state: makeState(1) });
    wal.append({ version: 2, state: makeState(2) });
    wal.append({ version: 3, state: makeState(3) });
    wal.append({ version: 4, state: makeState(4) });
    wal.compact(1);
    expect(wal.getEntries().map((e) => e.seq)).toEqual([2, 3]);
    expect(wal.getLastSeq()).toBe(3);
    expect(wal.verify().ok).toBe(true);
    wal.destroy();
  });

  it("3. detecta corrupción del snapshot de una entrada", () => {
    const { storage } = makeEnv("t3");
    const wal = new WriteAheadLog({ storage: "localStorage", flushIntervalMs: 0, keyPrefix: "t3", storageAdapter: storage });
    wal.append({ version: 1, state: makeState(1) });
    wal.append({ version: 2, state: makeState(2) });
    wal.append({ version: 3, state: makeState(3) });
    corruptWal(storage, "t3", (entries) => {
      entries[1].state.accounts[0].balance = 9999;
    });
    const wal2 = new WriteAheadLog({ storage: "localStorage", flushIntervalMs: 0, keyPrefix: "t3", storageAdapter: storage });
    expect(wal2.verify().ok).toBe(false);
    expect(wal2.verify().corrupted).toEqual([1]);
    wal.destroy();
    wal2.destroy();
  });

  it("4. prevChecksum encadenado detecta borrado de una entrada", () => {
    const { storage } = makeEnv("t4");
    const wal = new WriteAheadLog({ storage: "localStorage", flushIntervalMs: 0, keyPrefix: "t4", storageAdapter: storage });
    wal.append({ version: 1, state: makeState(1) });
    wal.append({ version: 2, state: makeState(2) });
    wal.append({ version: 3, state: makeState(3) });
    corruptWal(storage, "t4", (entries) => {
      entries.splice(1, 1);
    });
    const wal2 = new WriteAheadLog({ storage: "localStorage", flushIntervalMs: 0, keyPrefix: "t4", storageAdapter: storage });
    expect(wal2.verify().ok).toBe(false);
    expect(wal2.verify().corrupted).toContain(2);
    wal.destroy();
    wal2.destroy();
  });
});

// ─── Checkpoints ───────────────────────────────────────────────
describe("FASE 5 · CheckpointManager", () => {
  it("5. save → loadLatest → isValid", () => {
    const { storage } = makeEnv("t5");
    const cps = new CheckpointManager({ storage: "localStorage", maxHistory: 2, keyPrefix: "t5", storageAdapter: storage });
    cps.save(makeState(10), 10, 10);
    cps.save(makeState(20), 20, 20);
    const latest = cps.loadLatest();
    expect(latest.version).toBe(20);
    expect(latest.seq).toBe(20);
    expect(cps.isValid(latest)).toBe(true);
    expect(cps.loadAll()).toHaveLength(2);
  });

  it("6. checkpoint corrupto → isValid false", () => {
    const { storage } = makeEnv("t6");
    const cps = new CheckpointManager({ storage: "localStorage", maxHistory: 2, keyPrefix: "t6", storageAdapter: storage });
    cps.save(makeState(10), 10, 10);
    corruptCheckpoints(storage, "t6", (cps) => {
      cps[0].state.accounts[0].balance = 777;
    });
    const cps2 = new CheckpointManager({ storage: "localStorage", maxHistory: 2, keyPrefix: "t6", storageAdapter: storage });
    const latest = cps2.loadLatest();
    expect(cps2.isValid(latest)).toBe(false);
  });
});

// ─── Recovery ──────────────────────────────────────────────────
describe("FASE 5 · RecoveryManager", () => {
  const makeRecovery = (storage, keyPrefix) => {
    const wal = new WriteAheadLog({ storage: "localStorage", flushIntervalMs: 0, keyPrefix, storageAdapter: storage });
    const cps = new CheckpointManager({ storage: "localStorage", maxHistory: 2, keyPrefix, storageAdapter: storage });
    const recovery = new RecoveryManager(wal, cps, { autoHeal: true, maxToleratedDamage: 3 });
    return { wal, cps, recovery };
  };

  it("7. checkpoint válido + WAL posterior íntegro → reconstrucción exacta", () => {
    const { storage } = makeEnv("t7");
    const r = makeRecovery(storage, "t7");
    r.wal.append({ version: 1, state: makeState(1) });
    r.wal.append({ version: 2, state: makeState(2) });
    r.cps.save(makeState(2), 2, 1);
    r.wal.append({ version: 3, state: makeState(3) });
    r.wal.append({ version: 4, state: makeState(4) });

    const res = r.recovery.recoverOnLoad(makeState(0));
    expect(res.status).toBe("recovered");
    expect(res.state._syncVersion).toBe(4);
    expect(res.state.accounts[0].balance).toBe(104);
    expect(res.healed).toBe(true);
  });

  it("8. checkpoint inválido + WAL íntegro → reconstruye desde WAL", () => {
    const { storage } = makeEnv("t8");
    const r = makeRecovery(storage, "t8");
    r.wal.append({ version: 1, state: makeState(1) });
    r.wal.append({ version: 2, state: makeState(2) });
    r.cps.save(makeState(99), 99, 5);
    corruptCheckpoints(storage, "t8", (cps) => {
      cps[0].state.accounts[0].balance = -1;
    });
    // Re-apertura: los managers se recrean leyendo el almacenamiento corrupto.
    const r2 = makeRecovery(storage, "t8");
    const res = r2.recovery.recoverOnLoad(makeState(0));
    expect(res.status).toBe("recovered");
    expect(res.state._syncVersion).toBe(2);
  });

  it("9. sin checkpoint y WAL vacío → estado semilla", () => {
    const { storage } = makeEnv("t9");
    const r = makeRecovery(storage, "t9");
    const fallback = makeState(0);
    const res = r.recovery.recoverOnLoad(fallback);
    expect(res.status).toBe("reset");
    expect(res.state._syncVersion).toBe(0);
  });

  it("10. checkpoint válido + WAL dañado después → rollback al checkpoint", () => {
    const { storage } = makeEnv("t10");
    const r = makeRecovery(storage, "t10");
    r.wal.append({ version: 1, state: makeState(1) });
    r.cps.save(makeState(1), 1, 0);
    r.wal.append({ version: 2, state: makeState(2) });
    r.wal.append({ version: 3, state: makeState(3) });
    corruptWal(storage, "t10", (entries) => {
      entries[2].state.accounts[0].balance = 5000; // la última queda dañada
    });

    const r2 = makeRecovery(storage, "t10");
    const res = r2.recovery.recoverOnLoad(makeState(0));
    expect(res.status).toBe("recovered");
    expect(res.state._syncVersion).toBe(1); // rollback al checkpoint (versión 1)
    expect(res.droppedWalEntries).toBeGreaterThan(0);
    expect(res.healed).toBe(true);
  });

  it("11. WAL dañado sin checkpoint → última entrada válida", () => {
    const { storage } = makeEnv("t11");
    const r = makeRecovery(storage, "t11");
    r.wal.append({ version: 1, state: makeState(1) });
    r.wal.append({ version: 2, state: makeState(2) });
    corruptWal(storage, "t11", (entries) => {
      entries[1].state.accounts[0].balance = 999;
    });

    const r2 = makeRecovery(storage, "t11");
    const res = r2.recovery.recoverOnLoad(makeState(0));
    expect(res.status).toBe("recovered");
    expect(res.state._syncVersion).toBe(1);
    expect(res.droppedWalEntries).toBeGreaterThan(0);
  });

  it("12. corrupción masiva (≥ maxToleratedDamage) → reset + compactación", () => {
    const { storage } = makeEnv("t12");
    const r = makeRecovery(storage, "t12");
    r.wal.append({ version: 1, state: makeState(1) });
    r.wal.append({ version: 2, state: makeState(2) });
    r.wal.append({ version: 3, state: makeState(3) });
    r.cps.save(makeState(3), 3, 2);
    corruptWal(storage, "t12", (entries) => {
      entries.forEach((e) => { e.state.accounts[0].balance = 0; });
    });

    const r2 = makeRecovery(storage, "t12");
    const res = r2.recovery.recoverOnLoad(makeState(0));
    expect(res.status).toBe("reset");
    expect(res.state._syncVersion).toBe(0);
    expect(res.droppedWalEntries).toBe(3);
  });
});

// ─── Export / Import ───────────────────────────────────────────
describe("FASE 5 · ExportImport", () => {
  it("13. export → import: round trip íntegro con firma", async () => {
    const ei = new ExportImport({ signingKey: "test-key", verifyOnImport: true });
    const state = makeState(7, { scheduled: [{ id: "s1" }] });
    const bundle = await ei.exportState(state);
    expect(bundle.format).toBe("misfinanzas-backup");
    expect(bundle.signature).toBeTruthy();
    const res = await ei.importState(bundle);
    expect(res.ok).toBe(true);
    expect(res.state._syncVersion).toBe(7);
  });

  it("14. import con checksum roto → rechazado", async () => {
    const ei = new ExportImport({ signingKey: "test-key", verifyOnImport: true });
    const bundle = await ei.exportState(makeState(3));
    bundle.data.accounts[0].balance = 999; // manipulada tras exportar
    const res = await ei.importState(bundle);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/checksum/);
  });

  it("15. import con firma inválida → rechazado", async () => {
    const evil = new ExportImport({ signingKey: "clave-evil", verifyOnImport: false });
    const victim = new ExportImport({ signingKey: "test-key", verifyOnImport: true });
    const bundle = await evil.exportState(makeState(3));
    const res = await victim.importState(bundle);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/firma/);
  });

  it("16. import sin firma con verifyOnImport → rechazado", async () => {
    const ei = new ExportImport({ signingKey: "test-key", verifyOnImport: true });
    const bundle = await ei.exportState(makeState(3));
    delete bundle.signature;
    const res = await ei.importState(bundle);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/firma/);
  });
});

// ─── Orchestrator ──────────────────────────────────────────────
describe("FASE 5 · PersistenceOrchestrator", () => {
  const makeOrch = (keyPrefix = "t17") => {
    const env = makeEnv(keyPrefix);
    return { ...env, orch: new PersistenceOrchestrator(env.config) };
  };

  it("17. recordStateMutation → WAL; maybeCheckpoint → checkpoint", () => {
    const { orch } = makeOrch("t17");
    for (let v = 1; v <= 5; v++) orch.recordStateMutation(makeState(v));
    expect(orch.getStats().walSeq).toBe(4);
    const res = orch.maybeCheckpoint(makeState(5), 5);
    expect(res.checkpointed).toBe(true);
    expect(orch.getStats().checkpointCount).toBe(1);
    expect(orch.getStats().mutationsSinceCheckpoint).toBe(0);
    orch.destroy();
  });

  it("18. dedupe por _syncVersion (StrictMode-safe)", () => {
    const { orch } = makeOrch("t18");
    const s = makeState(1);
    orch.recordStateMutation(s);
    orch.recordStateMutation(s); // mismo estado, misma versión
    expect(orch.getStats().walSeq).toBe(0);
    orch.recordStateMutation(makeState(2));
    expect(orch.getStats().walSeq).toBe(1);
    orch.destroy();
  });

  it("19. rollbackTo(version) usa el checkpoint más reciente ≤ versión", () => {
    const { orch } = makeOrch("t19");
    for (let v = 1; v <= 5; v++) orch.recordStateMutation(makeState(v));
    orch.maybeCheckpoint(makeState(5), 5);
    for (let v = 6; v <= 10; v++) orch.recordStateMutation(makeState(v));
    orch.maybeCheckpoint(makeState(10), 10);
    const res = orch.rollbackTo(7);
    expect(res.ok).toBe(true);
    expect(res.version).toBe(5);
    expect(res.state._syncVersion).toBe(5);
    orch.destroy();
  });

  it("20. rollbackTo cae al WAL cuando no hay checkpoint ≤ versión", () => {
    const { orch } = makeOrch("t20");
    for (let v = 1; v <= 3; v++) orch.recordStateMutation(makeState(v));
    const res = orch.rollbackTo(2);
    expect(res.ok).toBe(true);
    expect(res.version).toBe(2);
    orch.destroy();
  });

  it("21. E2E crash → recovery reconstruye el estado exacto", () => {
    const env = makeEnv("t21");
    const a = new PersistenceOrchestrator(env.config);
    let last;
    for (let v = 1; v <= 20; v++) {
      last = makeState(v);
      a.recordStateMutation(last);
      if (v % 5 === 0) a.maybeCheckpoint(last, v);
    }
    a.destroy(); // crash: no se hace flush extra, solo lo ya persistido

    const b = new PersistenceOrchestrator(env.config); // mismo almacenamiento
    const res = b.recoverStateOnLoad(makeState(0));
    expect(res.status).toBe("recovered");
    expect(res.state._syncVersion).toBe(20);
    expect(res.state.accounts[0].balance).toBe(120);
    b.destroy();
  });

  it("22. validateState rechaza versión incoherente", () => {
    const { orch } = makeOrch("t22");
    const res = orch.maybeCheckpoint(makeState(5), 999);
    expect(res.checkpointed).toBe(false);
    expect(orch.validateState(makeState(3), 4)).toBeTruthy();
    expect(orch.validateState(makeState(3), 3)).toBeNull();
    orch.destroy();
  });

  it("23. exportState/importState del orchestrator con firma", async () => {
    const { orch } = makeOrch("t23");
    const bundle = await orch.exportState(makeState(9));
    const res = await orch.importState(bundle);
    expect(res.ok).toBe(true);
    expect(res.state._syncVersion).toBe(9);
    orch.destroy();
  });
});

// ─── Entorno / ciclo de vida ───────────────────────────────────
describe("FASE 5 · Entorno y ciclo de vida", () => {
  it("24. en Node no hay localStorage → createKeyValueStorage cae a memoria", () => {
    expect(hasLocalStorage()).toBe(false);
    const store = createKeyValueStorage("localStorage");
    store.setItem("k", "v");
    expect(store.getItem("k")).toBe("v");
    store.removeItem("k");
    expect(store.getItem("k")).toBeNull();
  });

  it("25. destroy() libera timers sin romper operaciones posteriores", async () => {
    const env = makeEnv("t25");
    env.config.orchestration.checkpointEvery.intervalMs = 50;
    const orch = new PersistenceOrchestrator(env.config);
    orch.recordStateMutation(makeState(1));
    orch.destroy();
    await sleep(120); // si el timer quedara vivo, no debe fallar ni escribir
    expect(orch.getStats().walSeq).toBe(0);
  });

  it("26. stableStringify es determinista", () => {
    const a = stableStringify({ b: 1, a: [1, { y: 2, x: 3 }], c: null });
    const b = stableStringify({ c: null, a: [1, { x: 3, y: 2 }], b: 1 });
    expect(a).toBe(b);
    expect(fnv1a(a)).toBe(fnv1a(b));
  });
});