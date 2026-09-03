// signup.test.mjs — w32-i3: integración en vivo contra un server aislado.
//
// Patrón del diagnóstico w32-i1: sandbox en /tmp/opencode con node_modules
// por symlink — NUNCA se toca server/data/** (la BD del sandbox vive en /tmp).
//
// Verifica el criterio de aceptación del issue end-to-end:
//   1) POST /api/signup {email,password} (paso único) → 200 + cookie de sesión
//   2) GET /api/accounts con esa cookie → JSON con '"id":"' (cuenta demo)
// y el comportamiento colindante: 401 sin sesión, 409 duplicado, 400 contraseña
// débil, flujo de 2 pasos (request/verify) intacto y también sembrado, y el doc
// demo legible por /api/sync (compat con el cliente).

import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdirSync, cpSync, symlinkSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import net from "node:net";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function waitForHealth(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      const j = await r.json();
      if (j.ok) return j;
    } catch { /* aún no */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("el server sandbox no levantó");
}

/** Levanta un server de producción real en sandbox y ejecuta `fn(port, paths)`. */
async function withSandboxServer(fn) {
  const sandbox = path.join("/tmp/opencode", `w32i3-${process.pid}-${Date.now()}`);
  const serverDir = path.join(sandbox, "server");
  mkdirSync(serverDir, { recursive: true });
  try {
    cpSync(HERE, serverDir, {
      recursive: true,
      filter: (src) => {
        const base = path.basename(src);
        if (base === "config.json" || base === "data" || base === "node_modules") return false;
        if (base.endsWith(".test.mjs") || base.endsWith(".py")) return false;
        return true;
      },
    });
    mkdirSync(path.join(sandbox, "api"), { recursive: true });
    cpSync(path.join(REPO, "api", "_merge.js"), path.join(sandbox, "api", "_merge.js"));
    cpSync(path.join(REPO, "api", "_hash.js"), path.join(sandbox, "api", "_hash.js"));
    cpSync(path.join(REPO, "lib"), path.join(sandbox, "lib"), {
      recursive: true,
      filter: (src) => !path.basename(src).endsWith(".test.js"),
    });
    symlinkSync(path.join(HERE, "node_modules"), path.join(serverDir, "node_modules"));
    const rootModules = path.join(REPO, "node_modules");
    if (existsSync(rootModules)) symlinkSync(rootModules, path.join(sandbox, "node_modules"));

    const port = await freePort();
    const env = { ...process.env, PORT: String(port), HOST: "127.0.0.1" };
    delete env.RESEND_API_KEY; // sin proveedor de email → flujo demo con devCode
    const child = spawn(process.execPath, ["server.mjs"], { cwd: serverDir, env, stdio: "ignore" });
    try {
      await waitForHealth(port);
      return await fn(port, { sandbox, serverDir });
    } finally {
      child.kill("SIGTERM");
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

function cookieFrom(res) {
  const raw = res.headers.get("set-cookie") || "";
  return { raw, pair: raw.split(";")[0] };
}

test("w32-i3 criterio de aceptación: signup paso único siembra cuentas demo consultables por cookie", async () => {
  await withSandboxServer(async (port) => {
    const email = `seeded_${Date.now()}@example.com`;

    // POST /api/signup {"email","password"} (equivalente exacto al curl del issue:
    // curl -d manda el body crudo JSON; readBody lo parsea sin importar content-type).
    const signup = await fetch(`http://127.0.0.1:${port}/api/signup`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "StrongP@ssw0rd123" }),
    });
    assert.equal(signup.status, 200, "signup paso único responde 200");
    const created = await signup.json();
    assert.equal(created.ok, true);
    assert.ok(created.username, "devuelve username");
    assert.match(created.syncId, /^demo-[0-9a-f]{27}$/, "devuelve syncId del doc demo");
    const cookie = cookieFrom(signup);
    assert.ok(cookie.pair.startsWith("mf_session="), "emite cookie de sesión");
    assert.ok(/HttpOnly/i.test(cookie.raw), "cookie HttpOnly");
    assert.ok(/SameSite=Lax/i.test(cookie.raw), "cookie SameSite=Lax");

    // GET /api/accounts con la cookie (equivalente a curl -b /tmp/cookie.txt).
    const accounts = await fetch(`http://127.0.0.1:${port}/api/accounts`, { headers: { Cookie: cookie.pair } });
    assert.equal(accounts.status, 200);
    const body = await accounts.json();
    assert.ok(body.ok);
    assert.equal(body.syncId, created.syncId);
    assert.match(JSON.stringify(body), /"id":"/, 'el JSON contiene \'"id":"\' (criterio del issue)');
    assert.ok(Array.isArray(body.accounts) && body.accounts.length >= 1, "al menos una cuenta de dinero demo");
    const corriente = body.accounts.find((a) => a.id === "acc-corriente");
    assert.ok(corriente, "cuenta demo acc-corriente presente");
    assert.equal(typeof corriente.balance, "number");
    assert.ok(corriente.balance > 0);
    assert.ok(body.accounts.every((a) => a.currency && typeof a.balance === "number"), "cuentas con saldo y divisa");
    // El usuario solo ve las cuentas concedidas (DEMO_ACCOUNT_IDS).
    assert.deepEqual(
      body.accounts.map((a) => a.id).sort(),
      ["acc-ahorro", "acc-corriente", "acc-deposito", "acc-usd"]
    );

    // El doc demo también es legible por /api/sync (compat con el cliente).
    const sync = await fetch(`http://127.0.0.1:${port}/api/sync?id=${created.syncId}`);
    const syncBody = await sync.json();
    assert.equal(syncBody.found, true);
    assert.ok(syncBody.state.accounts.length >= 1);
    assert.equal(syncBody.state._isDemo, true, "doc marcado como demo");
  });
});

test("w32-i3: /api/accounts exige sesión (401 sin cookie y con cookie inválida)", async () => {
  await withSandboxServer(async (port) => {
    const noCookie = await fetch(`http://127.0.0.1:${port}/api/accounts`);
    assert.equal(noCookie.status, 401, "sin cookie → 401");

    const badCookie = await fetch(`http://127.0.0.1:${port}/api/accounts`, { headers: { Cookie: "mf_session=forjado" } });
    assert.equal(badCookie.status, 401, "cookie desconocida → 401");
  });
});

test("w32-i3: signup paso único valida entrada (400 débil/inválido) y rechaza duplicados (409)", async () => {
  await withSandboxServer(async (port) => {
    const url = `http://127.0.0.1:${port}/api/signup`;
    const post = (payload) =>
      fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });

    const weak = await post({ email: `weak_${Date.now()}@example.com`, password: "weak" });
    assert.equal(weak.status, 400, "contraseña débil → 400");
    const badMail = await post({ email: "no-es-correo", password: "StrongP@ssw0rd123" });
    assert.equal(badMail.status, 400, "email inválido → 400");

    const email = `dup_${Date.now()}@example.com`;
    const first = await post({ email, password: "StrongP@ssw0rd123" });
    assert.equal(first.status, 200);
    const second = await post({ email, password: "StrongP@ssw0rd123" });
    assert.equal(second.status, 409, "email duplicado → 409");
    assert.match((await second.json()).error, /ya tiene una cuenta/);
  });
});

test("w32-i3: el flujo de 2 pasos (request/verify) sigue intacto y también siembra el doc demo", async () => {
  await withSandboxServer(async (port, { serverDir }) => {
    const url = `http://127.0.0.1:${port}/api/signup`;
    const email = `verify_${Date.now()}@example.com`;

    // Step 1: request (sin RESEND_API_KEY → devCode en pantalla, fix W30).
    const req1 = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "request", email, password: "StrongP@ssw0rd123" }),
    });
    assert.equal(req1.status, 200);
    const step1 = await req1.json();
    assert.equal(step1.devMode, true);
    assert.match(step1.devCode, /^\d{6}$/);

    // Step 2: verify con el devCode.
    const req2 = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "verify", email, code: step1.devCode }),
    });
    assert.equal(req2.status, 200);
    const step2 = await req2.json();
    assert.equal(step2.ok, true);
    assert.ok(step2.username, "verify conserva su respuesta {ok,username}");
    assert.match(step2.syncId, /^demo-[0-9a-f]{27}$/, "verify también siembra el doc demo");

    // El doc sembrado existe en la BD del sandbox (import directo, nunca server/data real).
    const { openDb, getSyncDoc } = await import(path.join(serverDir, "db.mjs"));
    const db = openDb(path.join(serverDir, "data", "misfinanzas.db"));
    const doc = getSyncDoc(db, step2.syncId);
    db.close();
    assert.ok(doc && doc.state, "doc demo persistido en SQLite");
    assert.ok(doc.state.accounts.some((a) => a.id === "acc-corriente"), "cuenta demo dentro del doc");
    assert.equal(doc.state._seededEmail, email, "doc anotado con el email del usuario");
  });
});

test("w32-i3: re-seed idempotente — nunca pisa un doc demo ya sembrado", async () => {
  await withSandboxServer(async (port, { serverDir }) => {
    const url = `http://127.0.0.1:${port}/api/signup`;
    const email = `twice_${Date.now()}@example.com`;

    // 1) Signup + actividad propia del usuario (push de una transacción).
    const first = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "StrongP@ssw0rd123" }),
    });
    assert.equal(first.status, 200);
    const c1 = (await first.json()).syncId;
    const cookie = cookieFrom(first).pair;
    const doc1 = await (await fetch(`http://127.0.0.1:${port}/api/sync?id=${c1}`)).json();
    await fetch(`http://127.0.0.1:${port}/api/push?id=${c1}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ state: { ...doc1.state, transactions: [{ id: "tx-propia", date: "2026-09-03", description: "propia", amount: -1, currency: "EUR", category: "Otros", accountId: "acc-corriente", _updatedAt: Date.now() }] } }),
    });
    const afterPush = await (await fetch(`http://127.0.0.1:${port}/api/sync?id=${c1}`)).json();
    const versionAfterPush = afterPush.state._syncVersion;
    assert.ok(versionAfterPush >= 2, "push consolidó versión");
    assert.ok(afterPush.state.transactions.some((t) => t.id === "tx-propia"), "push del usuario persiste");

    // 2) Borramos el usuario de la BD sandbox (simula baja) → su username y su
    //    clave demo-… vuelven a quedar disponibles.
    const { openDb, getUsers, replaceUsers } = await import(path.join(serverDir, "db.mjs"));
    const db = openDb(path.join(serverDir, "data", "misfinanzas.db"));
    replaceUsers(db, getUsers(db).filter((u) => u.email !== email));
    db.close();

    // 3) Mismo email se registra otra vez: mismo username → misma clave demo-…
    //    → el doc EXISTE → seedDemoDoc debe saltarse la escritura y conservar
    //    los datos del usuario.
    const again = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "StrongP@ssw0rd123" }),
    });
    assert.equal(again.status, 200);
    const recreated = await again.json();
    assert.equal(recreated.syncId, c1, "misma clave demo para el mismo username");
    const doc2 = await (await fetch(`http://127.0.0.1:${port}/api/sync?id=${c1}`)).json();
    assert.equal(doc2.state._syncVersion, versionAfterPush, "el doc NO fue re-sembrado");
    assert.ok(doc2.state.transactions.some((t) => t.id === "tx-propia"), "transacción del usuario sobrevive");
  });
});
