// userBackups.test.mjs — Tests del motor de respaldo por usuario (W33-i2) y de
// verificación + retención (W33-i4).
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
