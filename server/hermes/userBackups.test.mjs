// userBackups.test.mjs — Tests del motor de respaldo por usuario (W33-i2).
// Se ejecuta con: node --test server/hermes/userBackups.test.mjs
// Los tests SIEMPRE inyectan opts.root (tmpdir) y opts.getState: nunca
// leen ni escriben en server/data/**.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { backupUser, verifyUserBackup, stateHash, usersBackupRoot } from "./userBackups.mjs";

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
