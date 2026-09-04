// userBackups.test.mjs — Tests del motor de respaldo por usuario (W33-i2), de
// verificación + retención (W33-i4) y de restauración por usuario (W33-i5).
// Se ejecuta con: node --test server/hermes/userBackups.test.mjs
// Los tests SIEMPRE inyectan opts.root (tmpdir) y opts.getState: nunca
// leen ni escriben en server/data/**.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  backupUser,
  verifyUserBackup,
  verifyBackup,
  restoreUser,
  stateHash,
  usersBackupRoot,
  isoWeekKey,
  planRetention,
  applyRetention,
  RETENTION_DAILY,
  RETENTION_WEEKLY,
} from "./userBackups.mjs";

function tmpRoot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "w33i2-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const stateA = {
  _syncVersion: 7,
  accounts: [{ id: "acc-1", name: "BBVA", balance: 1500 }],
  transactions: [{ id: "t1", description: "Café", amount: -3.5 }],
};
const stateB = {
  _syncVersion: 3,
  accounts: [{ id: "acc-2", name: "UALA", balance: 90 }],
  transactions: [],
};

test("backupUser: exporta a backups/users/<syncId>/<fecha>.json con hash de integridad", async (t) => {
  const root = tmpRoot(t);
  const now = new Date("2026-09-04T12:00:00Z");
  const res = await backupUser("sync-a", { root, getState: () => stateA, now });

  const expectedPath = path.join(root, "backups", "users", "sync-a", "2026-09-04.json");
  assert.equal(res.ok, true);
  assert.equal(res.path, expectedPath);
  assert.ok(fs.existsSync(expectedPath));

  const doc = JSON.parse(fs.readFileSync(expectedPath, "utf8"));
  assert.equal(doc.meta.syncId, "sync-a");
  assert.equal(doc.meta.syncVersion, 7);
  assert.equal(doc.meta.backedUpAt, "2026-09-04T12:00:00.000Z");
  assert.deepEqual(doc.meta.counts, { accounts: 1, transactions: 1 });
  assert.deepEqual(doc.state, stateA);
  assert.equal(doc.integrity.algorithm, "sha256");
  assert.equal(doc.integrity.hash, stateHash(stateA));
  assert.equal(res.hash, doc.integrity.hash);
});

test("verifyUserBackup: válido si el estado no mutó, inválido si fue mutado", async (t) => {
  const root = tmpRoot(t);
  const res = await backupUser("sync-a", { root, getState: () => stateA, now: "2026-09-04T12:00:00Z" });

  assert.equal(verifyUserBackup(res.path).valid, true);
  assert.equal(verifyUserBackup(res.path).syncId, "sync-a");

  const tampered = JSON.parse(fs.readFileSync(res.path, "utf8"));
  tampered.state.accounts[0].balance = 999999;
  const tamperedPath = path.join(root, "tampered.json");
  fs.writeFileSync(tamperedPath, JSON.stringify(tampered));
  const verdict = verifyUserBackup(tamperedPath);
  assert.equal(verdict.valid, false);
  assert.equal(verdict.hash, stateHash(tampered.state));
  assert.equal(verdict.expected, stateHash(stateA));

  const noHashPath = path.join(root, "no-hash.json");
  fs.writeFileSync(noHashPath, JSON.stringify({ meta: {}, state: stateA }));
  assert.equal(verifyUserBackup(noHashPath).valid, false);
});

test("aislamiento: cada usuario escribe en su propio directorio sin mezclar datos", async (t) => {
  const root = tmpRoot(t);
  const states = { "user-a": stateA, "user-b": stateB };
  const resA = await backupUser("user-a", { root, getState: (id) => states[id], now: "2026-09-04T12:00:00Z" });
  const resB = await backupUser("user-b", { root, getState: (id) => states[id], now: "2026-09-04T12:00:00Z" });

  assert.deepEqual(fs.readdirSync(usersBackupRoot(root)).sort(), ["user-a", "user-b"]);
  const docA = JSON.parse(fs.readFileSync(resA.path, "utf8"));
  const docB = JSON.parse(fs.readFileSync(resB.path, "utf8"));
  assert.notEqual(docA.integrity.hash, docB.integrity.hash);
  assert.equal(docA.state.accounts[0].id, "acc-1");
  assert.equal(docB.state.accounts[0].id, "acc-2");
  assert.ok(!JSON.stringify(docA).includes("acc-2"));
  assert.ok(!JSON.stringify(docB).includes("acc-1"));
});

test("syncId inválido (path traversal) es rechazado y no escribe nada", async (t) => {
  const root = tmpRoot(t);
  for (const bad of ["../other", "a/b", "..", "", "usuario con espacios"]) {
    await assert.rejects(
      () => backupUser(bad, { root, getState: () => stateA }),
      /syncId inválido/
    );
  }
  assert.ok(!fs.existsSync(path.join(root, "backups")));
});

test("lanza si el sync doc del usuario no existe", async (t) => {
  const root = tmpRoot(t);
  await assert.rejects(
    () => backupUser("fantasma", { root, getState: () => null }),
    /no encontrado/
  );
});

test("re-respaldo el mismo día sobrescribe; otro día crea archivo nuevo", async (t) => {
  const root = tmpRoot(t);
  const dir = path.join(usersBackupRoot(root), "sync-a");
  await backupUser("sync-a", { root, getState: () => stateA, now: "2026-09-04T09:00:00Z" });
  const v2 = { ...stateA, _syncVersion: 8 };
  const res = await backupUser("sync-a", { root, getState: () => v2, now: "2026-09-04T18:00:00Z" });

  assert.deepEqual(fs.readdirSync(dir), ["2026-09-04.json"]);
  const doc = JSON.parse(fs.readFileSync(res.path, "utf8"));
  assert.equal(doc.meta.syncVersion, 8);
  assert.equal(doc.integrity.hash, stateHash(v2));

  await backupUser("sync-a", { root, getState: () => v2, now: "2026-09-05T10:00:00Z" });
  assert.deepEqual(fs.readdirSync(dir).sort(), ["2026-09-04.json", "2026-09-05.json"]);
});

// ── W33-i4: verifyBackup (JSON parseable + hash correcto) ─────────────────────

test("verifyBackup: veredicto válido con hash, expected, syncId y date", async (t) => {
  const root = tmpRoot(t);
  const res = await backupUser("sync-a", { root, getState: () => stateA, now: "2026-09-04T12:00:00Z" });

  const v = await verifyBackup(res.path);
  assert.equal(v.valid, true);
  assert.equal(v.reason, null);
  assert.equal(v.hash, stateHash(stateA));
  assert.equal(v.expected, stateHash(stateA));
  assert.equal(v.syncId, "sync-a");
  assert.equal(v.date, "2026-09-04");
  assert.equal(v.path, res.path);
});

test("verifyBackup: JSON corrupto → veredicto inválido SIN lanzar", async (t) => {
  const root = tmpRoot(t);
  const badPath = path.join(root, "corrupto.json");
  fs.writeFileSync(badPath, "{ esto no es JSON!!!");

  const v = await verifyBackup(badPath);
  assert.equal(v.valid, false);
  assert.match(v.reason, /JSON no parseable/);
  assert.equal(v.hash, null);
  assert.equal(v.expected, null);

  // JSON truncado a mitad de estructura: mismo camino sin lanzar
  const res = await backupUser("sync-a", { root, getState: () => stateA, now: "2026-09-04T12:00:00Z" });
  const raw = fs.readFileSync(res.path, "utf8");
  fs.writeFileSync(badPath, raw.slice(0, Math.floor(raw.length / 2)));
  const v2 = await verifyBackup(badPath);
  assert.equal(v2.valid, false);
  assert.match(v2.reason, /JSON no parseable/);
});

test("verifyBackup: estado mutado → inválido con hash ≠ expected", async (t) => {
  const root = tmpRoot(t);
  const res = await backupUser("sync-a", { root, getState: () => stateA, now: "2026-09-04T12:00:00Z" });

  const tampered = JSON.parse(fs.readFileSync(res.path, "utf8"));
  tampered.state.accounts[0].balance = 999999;
  const tamperedPath = path.join(root, "tampered.json");
  fs.writeFileSync(tamperedPath, JSON.stringify(tampered));

  const v = await verifyBackup(tamperedPath);
  assert.equal(v.valid, false);
  assert.equal(v.hash, stateHash(tampered.state));
  assert.equal(v.expected, stateHash(stateA));
  assert.match(v.reason, /mutado/);
});

test("verifyBackup: sin hash, sin state y archivo inexistente → inválido sin lanzar", async (t) => {
  const root = tmpRoot(t);

  const noHashPath = path.join(root, "no-hash.json");
  fs.writeFileSync(noHashPath, JSON.stringify({ meta: {}, state: stateA }));
  const v1 = await verifyBackup(noHashPath);
  assert.equal(v1.valid, false);
  assert.match(v1.reason, /sin hash de integridad/);

  const noStatePath = path.join(root, "no-state.json");
  fs.writeFileSync(noStatePath, JSON.stringify({ meta: { syncId: "sync-a" } }));
  const v2 = await verifyBackup(noStatePath);
  assert.equal(v2.valid, false);
  assert.match(v2.reason, /estructura/);

  const v3 = await verifyBackup(path.join(root, "fantasma.json"));
  assert.equal(v3.valid, false);
  assert.match(v3.reason, /no se pudo leer/);
});

// ── W33-i4: retención (7 diarios + 4 semanales) ───────────────────────────────

test("isoWeekKey: semanas ISO-8601 correctas y fechas inválidas → null", () => {
  assert.equal(RETENTION_DAILY, 7);
  assert.equal(RETENTION_WEEKLY, 4);
  // viernes 4-sep-2026 → W36; lunes 31-ago → W36; domingo 30-ago → W35
  assert.equal(isoWeekKey("2026-09-04"), "2026-W36");
  assert.equal(isoWeekKey("2026-08-31"), "2026-W36");
  assert.equal(isoWeekKey("2026-08-30"), "2026-W35");
  assert.equal(isoWeekKey("2026-08-24"), "2026-W35");
  assert.equal(isoWeekKey("2026-08-17"), "2026-W34");
  assert.equal(isoWeekKey("2026-08-10"), "2026-W33");
  // la semana la define su jueves: 29-dic-2025 (lunes) pertenece a W01 de 2026
  assert.equal(isoWeekKey("2026-01-01"), "2026-W01");
  assert.equal(isoWeekKey("2025-12-29"), "2026-W01");
  assert.equal(isoWeekKey("2026-02-30"), null);
  assert.equal(isoWeekKey("29092026"), null);
  assert.equal(isoWeekKey("nope"), null);
});

test("planRetention: 35 diarios → 7 dailies + 4 weeklies (más antiguos de W33..W36), resto delete", () => {
  const now = "2026-09-04T12:00:00Z";
  const dates = [];
  for (let day = 1; day <= 35; day++) {
    dates.push(new Date(Date.UTC(2026, 7, day)).toISOString().slice(0, 10)); // 2026-08-01..2026-09-04
  }

  const plan = planRetention(dates, { now });

  // 7 dailies: 08-29..09-04 + weeklies: más antiguo de W36 (08-31, ya daily),
  // W35 (08-24), W34 (08-17), W33 (08-10)
  assert.deepEqual(plan.keep, [
    "2026-08-10",
    "2026-08-17",
    "2026-08-24",
    "2026-08-29",
    "2026-08-30",
    "2026-08-31",
    "2026-09-01",
    "2026-09-02",
    "2026-09-03",
    "2026-09-04",
  ]);
  // keep ∪ delete = todas, disjuntas, delete ordenado
  assert.equal(plan.keep.length + plan.delete.length, dates.length);
  for (const d of plan.delete) assert.ok(!plan.keep.includes(d));
  assert.deepEqual(
    plan.delete,
    [...plan.delete].sort()
  );
  assert.equal(plan.delete.length, 25);
  assert.deepEqual(plan.delete.slice(0, 9), [
    "2026-08-01",
    "2026-08-02",
    "2026-08-03",
    "2026-08-04",
    "2026-08-05",
    "2026-08-06",
    "2026-08-07",
    "2026-08-08",
    "2026-08-09",
  ]);
});

test("planRetention: menos de 7 archivos → todo keep, nada delete; inválidas ignoradas", () => {
  const plan = planRetention(["2026-09-01", "2026-09-02", "2026-09-03"], { now: "2026-09-04T12:00:00Z" });
  assert.deepEqual(plan.keep, ["2026-09-01", "2026-09-02", "2026-09-03"]);
  assert.deepEqual(plan.delete, []);

  const mixed = planRetention(["nope", "2026-13-40", "2026-02-30", "2026-09-04"], { now: "2026-09-04T12:00:00Z" });
  assert.deepEqual(mixed.keep, ["2026-09-04"]);
  assert.deepEqual(mixed.delete, []);
});

test("planRetention: ventana semanal desde now — weeklies fuera de las 4 semanas se limpian", () => {
  // solo viernes: 08-07 (W32), 08-21 (W34), 08-28 (W35), 09-03 (W36), 09-04 (W36)
  const dates = ["2026-08-07", "2026-08-21", "2026-08-28", "2026-09-03", "2026-09-04"];
  const plan = planRetention(dates, { now: "2026-09-04T12:00:00Z", daily: 2, weekly: 4 });

  // dailies: 09-03, 09-04 · weeklies (W36..W33): W35→08-28, W34→08-21, W36→09-03 (ya daily)
  assert.deepEqual(plan.keep, ["2026-08-21", "2026-08-28", "2026-09-03", "2026-09-04"]);
  assert.deepEqual(plan.delete, ["2026-08-07"]); // W32, fuera de la ventana
});

test("applyRetention: limpia en disco, conserva 7+4, no toca extraños ni otros usuarios, kept pasa verifyBackup", async (t) => {
  const root = tmpRoot(t);
  const dir = path.join(usersBackupRoot(root), "sync-a");
  // 12 respaldos diarios: 2026-08-24..2026-09-04
  for (let day = 24; day <= 35; day++) {
    const date = new Date(Date.UTC(2026, day > 31 ? 8 : 7, day > 31 ? day - 31 : day));
    const state = { ...stateA, _syncVersion: day };
    await backupUser("sync-a", { root, getState: () => state, now: `${date.toISOString().slice(0, 10)}T10:00:00Z` });
  }
  // archivos ajenos al patrón: jamás se tocan
  fs.writeFileSync(path.join(dir, "notas.txt"), "manual");
  fs.writeFileSync(path.join(dir, "2026-09-99.json"), "{}");
  // otro usuario en su propio árbol
  await backupUser("user-b", { root, getState: () => stateB, now: "2026-09-01T10:00:00Z" });

  const res = await applyRetention("sync-a", { root, now: "2026-09-04T23:00:00Z" });

  assert.equal(res.ok, true);
  assert.deepEqual(res.errors, []);
  // dailies 08-29..09-04 + weekly W35 (más antiguo: 08-24); W36 oldest 08-31 ya daily
  assert.deepEqual(res.kept, [
    "2026-08-24",
    "2026-08-29",
    "2026-08-30",
    "2026-08-31",
    "2026-09-01",
    "2026-09-02",
    "2026-09-03",
    "2026-09-04",
  ]);
  assert.deepEqual(res.deleted, ["2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28"]);
  assert.deepEqual(fs.readdirSync(dir).sort(), [...res.kept.map((d) => `${d}.json`), "2026-09-99.json", "notas.txt"].sort());

  // cada respaldo conservado pasa la verificación (verificación + retención juntas)
  for (const date of res.kept) {
    const v = await verifyBackup(path.join(dir, `${date}.json`));
    assert.equal(v.valid, true, `${date} debería verificar: ${v.reason}`);
  }
  // aislamiento: user-b intacto
  assert.deepEqual(fs.readdirSync(path.join(usersBackupRoot(root), "user-b")), ["2026-09-01.json"]);
});

test("applyRetention: syncId inválido lanza; directorio inexistente → ok sin borrados", async (t) => {
  const root = tmpRoot(t);
  await assert.rejects(() => applyRetention("../other", { root }), /syncId inválido/);
  await assert.rejects(() => applyRetention("", { root }), /syncId inválido/);

  const res = await applyRetention("fantasma", { root, now: "2026-09-04T12:00:00Z" });
  assert.equal(res.ok, true);
  assert.deepEqual(res.kept, []);
  assert.deepEqual(res.deleted, []);
  assert.deepEqual(res.errors, []);
});

// ── W33-i5: restauración por usuario ──────────────────────────────────────────

// Store en memoria (inyectable) que simula el motor de sync: putState/getState.
function memoryStore(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    getState: async (id) => store.get(id) ?? null,
    putState: async (id, state) => {
      store.set(id, state);
    },
  };
}

test("restoreUser: restaura con confirmación y verifica hash post-restore (estado == respaldo)", async (t) => {
  const root = tmpRoot(t);
  await backupUser("sync-a", { root, getState: () => stateA, now: "2026-09-01T10:00:00Z" });
  // drift posterior: el usuario avanzó a otro estado
  const drifted = {
    _syncVersion: 99,
    accounts: [{ id: "acc-9", name: "Nueva", balance: 1 }],
    transactions: [{ id: "t9", description: "drift", amount: -50 }],
  };
  const ms = memoryStore({ "sync-a": drifted });

  const res = await restoreUser("sync-a", "2026-09-01", { root, ...ms, confirm: true, now: "2026-09-04T12:00:00Z" });

  assert.equal(res.ok, true);
  assert.equal(res.verified, true);
  assert.equal(res.syncId, "sync-a");
  assert.equal(res.date, "2026-09-01");
  assert.equal(res.hash, stateHash(stateA));
  assert.equal(res.syncVersion, 7);
  assert.deepEqual(res.counts, { accounts: 1, transactions: 1 });
  assert.equal(res.restoredAt, "2026-09-04T12:00:00.000Z");
  assert.equal(res.overwritten.syncVersion, 99); // auditoría: qué había antes
  assert.deepEqual(res.overwritten.counts, { accounts: 1, transactions: 1 });

  // criterio central: hash del estado restaurado == hash del respaldo
  const after = ms.store.get("sync-a");
  assert.deepEqual(after, stateA); // drift eliminado, sin mezclas
  assert.equal(stateHash(after), stateHash(stateA));
});

test("restoreUser: sin confirm NO toca nada (needsConfirmation + preview); con confirm ejecuta", async (t) => {
  const root = tmpRoot(t);
  await backupUser("sync-a", { root, getState: () => stateA, now: "2026-09-01T10:00:00Z" });
  const drifted = { ...stateA, _syncVersion: 50, transactions: [{ id: "t2", description: "nueva", amount: -1 }] };
  const ms = memoryStore({ "sync-a": drifted });

  const pending = await restoreUser("sync-a", "2026-09-01", { root, ...ms, now: "2026-09-04T12:00:00Z" });

  assert.equal(pending.ok, false);
  assert.equal(pending.needsConfirmation, true);
  assert.match(pending.reason, /confirmación/);
  // preview: material del respaldo + estado actual
  assert.equal(pending.preview.hash, stateHash(stateA));
  assert.equal(pending.preview.syncVersion, 7);
  assert.deepEqual(pending.preview.counts, { accounts: 1, transactions: 1 });
  assert.equal(pending.preview.backedUpAt, "2026-09-01T10:00:00.000Z");
  assert.equal(pending.preview.current.syncVersion, 50);
  // nada cambió
  assert.deepEqual(ms.store.get("sync-a"), drifted);

  // human-in-the-loop: el usuario aprueba → ahora sí
  const done = await restoreUser("sync-a", "2026-09-01", { root, ...ms, confirm: true, now: "2026-09-04T12:01:00Z" });
  assert.equal(done.ok, true);
  assert.equal(done.verified, true);
  assert.deepEqual(ms.store.get("sync-a"), stateA);
});

test("restoreUser: rechaza respaldo corrupto (hash inválido) sin tocar el estado", async (t) => {
  const root = tmpRoot(t);
  const res = await backupUser("sync-a", { root, getState: () => stateA, now: "2026-09-01T10:00:00Z" });
  const tampered = JSON.parse(fs.readFileSync(res.path, "utf8"));
  tampered.state.accounts[0].balance = 999999;
  fs.writeFileSync(res.path, JSON.stringify(tampered));
  const ms = memoryStore({ "sync-a": stateB });

  const out = await restoreUser("sync-a", "2026-09-01", { root, ...ms, confirm: true });

  assert.equal(out.ok, false);
  assert.equal(out.needsConfirmation, false);
  assert.match(out.reason, /mutado/);
  assert.deepEqual(ms.store.get("sync-a"), stateB); // intacto: jamás restaura un respaldo inválido
});

test("restoreUser: aislamiento — respaldo de otro usuario (meta.syncId ≠ syncId) se rechaza", async (t) => {
  const root = tmpRoot(t);
  await backupUser("user-a", { root, getState: () => stateA, now: "2026-09-01T10:00:00Z" });
  // intento de cruce: el respaldo de user-a copiado al árbol de user-b
  const dstDir = path.join(usersBackupRoot(root), "user-b");
  fs.mkdirSync(dstDir, { recursive: true });
  fs.copyFileSync(
    path.join(usersBackupRoot(root), "user-a", "2026-09-01.json"),
    path.join(dstDir, "2026-09-01.json")
  );
  const ms = memoryStore({ "user-b": stateB });

  const out = await restoreUser("user-b", "2026-09-01", { root, ...ms, confirm: true });

  assert.equal(out.ok, false);
  assert.match(out.reason, /otro usuario/);
  assert.deepEqual(ms.store.get("user-b"), stateB); // sin mezcla ni exposición

  // user-a con SU propio respaldo sigue funcionando
  const own = await restoreUser("user-a", "2026-09-01", { root, ...memoryStore({ "user-a": stateB }), confirm: true });
  assert.equal(own.ok, true);
  assert.equal(own.hash, stateHash(stateA));
});

test("restoreUser: syncId/fecha inválidos lanzan (path-traversal); fecha sin respaldo → ok:false", async (t) => {
  const root = tmpRoot(t);
  const ms = memoryStore({});
  await assert.rejects(() => restoreUser("../other", "2026-09-01", { root, ...ms }), /syncId inválido/);
  await assert.rejects(() => restoreUser("sync-a", "01-09-2026", { root, ...ms }), /fecha inválida/);
  await assert.rejects(() => restoreUser("sync-a", "../../etc", { root, ...ms }), /fecha inválida/);
  await assert.rejects(() => restoreUser("sync-a", "", { root, ...ms }), /fecha inválida/);

  const out = await restoreUser("sync-a", "2026-09-01", { root, ...ms, confirm: true });
  assert.equal(out.ok, false);
  assert.match(out.reason, /no se pudo leer/);
});

test("restoreUser: si el estado escrito no verifica (hash ≠ respaldo) → ok:false, verified:false", async (t) => {
  const root = tmpRoot(t);
  await backupUser("sync-a", { root, getState: () => stateA, now: "2026-09-01T10:00:00Z" });
  // store que corrompe el write (simula un motor de sync que muta el estado)
  const broken = { store: new Map() };
  broken.putState = async (id, state) => {
    broken.store.set(id, { ...state, accounts: [{ ...stateA.accounts[0], balance: 42 }] });
  };
  broken.getState = async (id) => broken.store.get(id) ?? null;

  const out = await restoreUser("sync-a", "2026-09-01", { root, ...broken, confirm: true });

  assert.equal(out.ok, false);
  assert.equal(out.verified, false);
  assert.match(out.reason, /verificación post-restore/);
  assert.equal(out.hash, stateHash(stateA));
  assert.deepEqual(out.overwritten, null); // no había estado previo
});

test("restoreUser: putState sin getState (o viceversa) lanza — la verificación post-restore es obligatoria", async (t) => {
  const root = tmpRoot(t);
  await backupUser("sync-a", { root, getState: () => stateA, now: "2026-09-01T10:00:00Z" });
  await assert.rejects(
    () => restoreUser("sync-a", "2026-09-01", { root, putState: async () => {}, confirm: true }),
    /getState/
  );
  await assert.rejects(
    () => restoreUser("sync-a", "2026-09-01", { root, getState: async () => stateA, confirm: true }),
    /putState/
  );
});

// ── W33-i6: notificaciones + visibilidad ──────────────────────────────────────
// El aviso Telegram SIEMPRE se inyecta (opts.notify): los tests no tocan red
// ni server/data/**.

import { listUserBackups, backupSummaryMessage, notifyBackupResults, runDailyUserBackups } from "./userBackups.mjs";

test("listUserBackups: found:false sin respaldos; lista ascendente con metadatos y veredicto", async (t) => {
  const root = tmpRoot(t);

  const empty = await listUserBackups("sync-a", { root });
  assert.equal(empty.found, false);
  assert.deepEqual(empty.backups, []);

  await backupUser("sync-a", { root, getState: () => stateA, now: "2026-09-01T10:00:00Z" });
  await backupUser("sync-a", { root, getState: () => ({ ...stateA, _syncVersion: 8 }), now: "2026-09-02T10:00:00Z" });
  // extraño fuera del patrón: jamás aparece en el listado
  fs.writeFileSync(path.join(usersBackupRoot(root), "sync-a", "notas.txt"), "x");

  const out = await listUserBackups("sync-a", { root });
  assert.equal(out.found, true);
  assert.equal(out.syncId, "sync-a");
  assert.deepEqual(out.backups.map((b) => b.date), ["2026-09-01", "2026-09-02"]);
  const [b1, b2] = out.backups;
  assert.equal(b1.valid, true);
  assert.equal(b1.hash, stateHash(stateA));
  assert.equal(b1.syncVersion, 7);
  assert.equal(b1.backedUpAt, "2026-09-01T10:00:00.000Z");
  assert.deepEqual(b1.counts, { accounts: 1, transactions: 1 });
  assert.equal(b1.bytes, fs.statSync(b1.path).size);
  assert.equal(b1.reason, null);
  assert.equal(b2.syncVersion, 8);

  // tampereado: veredicto corrupto con motivo
  const tampered = JSON.parse(fs.readFileSync(b1.path, "utf8"));
  tampered.state.accounts[0].balance = 999999;
  fs.writeFileSync(b1.path, JSON.stringify(tampered));
  const after = await listUserBackups("sync-a", { root });
  assert.equal(after.backups[0].valid, false);
  assert.match(after.backups[0].reason, /mutado/);
  assert.equal(after.backups[1].valid, true); // los demás intactos
});

test("listUserBackups: aislamiento — solo el árbol del syncId pedido; syncId inválido lanza", async (t) => {
  const root = tmpRoot(t);
  await backupUser("user-a", { root, getState: () => stateA, now: "2026-09-01T10:00:00Z" });
  await backupUser("user-b", { root, getState: () => stateB, now: "2026-09-01T10:00:00Z" });

  const a = await listUserBackups("user-a", { root });
  assert.equal(a.backups.length, 1);
  assert.equal(a.backups[0].hash, stateHash(stateA));
  // jamás filtra el contenido/hash del otro usuario
  assert.ok(!JSON.stringify(a).includes(stateHash(stateB)));

  for (const bad of ["../other", "a/b", "", "usuario con espacios"]) {
    await assert.rejects(() => listUserBackups(bad, { root }), /syncId inválido/);
  }
});

test("backupSummaryMessage: resumen puro con éxito/fallo, lote vacío y truncado", () => {
  const ok1 = { ok: true, syncId: "user-a", counts: { accounts: 3, transactions: 120 }, syncVersion: 42, bytes: 12615, retentionDeleted: 2 };
  const ok2 = { ok: true, syncId: "user-b", counts: { accounts: 1, transactions: 0 }, syncVersion: 3, bytes: 900 };
  const fail = { ok: false, syncId: "user-c", reason: "sync doc user-c no encontrado" };

  const text = backupSummaryMessage([ok1, ok2, fail], new Date("2026-09-04T12:00:00Z"));
  assert.match(text, /🗂 Respaldo por usuario — 2026-09-04/);
  assert.match(text, /✅ 2 con éxito · ❌ 1 con fallo/);
  assert.match(text, /✅ user-a · 3 cuentas · 120 movs · v42 · 12\.3 kB · retención: -2/);
  assert.match(text, /✅ user-b · 1 cuentas · 0 movs · v3 · 900 B/);
  assert.match(text, /❌ user-c · sync doc user-c no encontrado/);

  const empty = backupSummaryMessage([], new Date("2026-09-04T12:00:00Z"));
  assert.match(empty, /Sin usuarios con sync activo/);

  const many = Array.from({ length: 500 }, (_, i) => ({ ok: false, syncId: `user-${i}`, reason: "x".repeat(120) }));
  assert.ok(backupSummaryMessage(many).length <= 3500);
});

test("notifyBackupResults: envía el texto exacto con el stub inyectado; fallo del canal → null sin lanzar", async () => {
  const results = [{ ok: true, syncId: "user-a", counts: { accounts: 1, transactions: 1 }, syncVersion: 7, bytes: 500 }];
  const sent = [];
  const text = await notifyBackupResults(results, { notify: async (t) => sent.push(t), now: "2026-09-04T12:00:00Z" });
  assert.deepEqual(sent, [text]);
  assert.match(text, /✅ 1 con éxito · ❌ 0 con fallo/);

  const nullOut = await notifyBackupResults(results, {
    notify: async () => { throw new Error("telegram caído"); },
    now: "2026-09-04T12:00:00Z",
  });
  assert.equal(nullOut, null); // el canal no rompe el job
});

test("runDailyUserBackups: respalda a todos + retención + UN aviso con éxito/fallo", async (t) => {
  const root = tmpRoot(t);
  // 9 respaldos previos de user-b (26-ago..03-sep) → la retención borra 2 (7 diarios)
  for (let d = 9; d >= 1; d--) {
    const date = new Date(Date.UTC(2026, 8, 4) - d * 86_400_000).toISOString().slice(0, 10);
    await backupUser("user-b", { root, getState: () => stateB, now: `${date}T10:00:00Z` });
  }
  const states = { "user-a": stateA, "user-b": stateB, "user-c": null };
  const sent = [];
  const out = await runDailyUserBackups(["user-a", "user-b", "user-c", "user-a"], {
    root,
    getState: (id) => states[id] ?? null,
    now: "2026-09-04T23:00:00Z",
    notify: async (t) => sent.push(t),
  });

  assert.equal(out.ok, false); // user-c falló (sin sync doc)
  assert.equal(out.results.length, 3); // user-a duplicado se deduplica
  const byId = Object.fromEntries(out.results.map((r) => [r.syncId, r]));
  assert.equal(byId["user-a"].ok, true);
  assert.equal(byId["user-b"].ok, true);
  assert.equal(byId["user-b"].retentionDeleted, 2); // 9 archivos → 7 diarios
  assert.equal(byId["user-c"].ok, false);
  assert.match(byId["user-c"].reason, /no encontrado/);

  assert.equal(sent.length, 1); // UN aviso al completar el lote
  assert.match(out.notified, /✅ 2 con éxito · ❌ 1 con fallo/);
  assert.match(out.notified, /❌ user-c · sync doc user-c no encontrado/);
  assert.equal(out.notified, sent[0]);
});

test("runDailyUserBackups: notify:false no envía; stub que lanza → notified null y resultados intactos", async (t) => {
  const root = tmpRoot(t);
  let calls = 0;
  const off = await runDailyUserBackups(["user-a"], {
    root, getState: () => stateA, now: "2026-09-04T23:00:00Z", notify: false,
  });
  assert.equal(off.ok, true);
  assert.equal(off.notified, null);
  assert.equal(calls, 0);

  const sent = [];
  const out = await runDailyUserBackups(["user-a"], {
    root,
    getState: () => stateA,
    now: "2026-09-04T23:30:00Z",
    notify: async () => { calls++; sent.push("x"); throw new Error("canal roto"); },
  });
  assert.equal(out.ok, true); // el respaldo OK aunque el aviso falle
  assert.equal(out.results.length, 1);
  assert.equal(out.results[0].ok, true);
  assert.equal(out.notified, null);
  assert.equal(calls, 1);
  assert.equal(sent.length, 1);
});
