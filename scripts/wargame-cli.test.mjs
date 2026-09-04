// wargame-cli.test.mjs — W34-I1: contrato del CLI del loop.
// 1) sync-code desde ~/.config/misfinanzas/sync-code (600, auto-aprieta, graceful)
// 2) header `Authorization: W1 <sync-code>`
// 3) e2e: cada comando imprime SIEMPRE un envelope JSON en stdout con las
//    claves canónicas ("status", "issues") — es lo que grep-a el review-loop.
import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readSyncCode, authHeader, syncCodePath, baseUrl } from "./wargame-cli.mjs";

const CLI = new URL("./wargame-cli.mjs", import.meta.url).pathname;

function tmpSyncCode(code, mode = 0o600) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "w34i1-"));
  const file = path.join(dir, "sync-code");
  fs.writeFileSync(file, `${code}\n`, { mode });
  fs.chmodSync(file, mode);
  return file;
}

function runCli(args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, ...env } });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

// Mock de la API wargame: registra el Authorization recibido y responde JSON.
const seen = { auth: [], bodies: [] };
const server = http.createServer((req, res) => {
  seen.auth.push(req.headers.authorization || null);
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.bodies.push(body);
    const json = (code, payload) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (req.url === "/api/wargame/status") return json(200, { ok: true, total: 3, byState: { todo: 3 } });
    if (req.url === "/api/wargame/spec") return json(200, { ok: true, ids: ["w34-i9", "w34-i10"] });
    return json(404, { ok: false, error: "no encontrado" });
  });
});
// Puerto efímero real + otro garantizado cerrado (para probar server caído).
const mockUrl = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`)));
const deadServer = http.createServer();
const deadUrl = await new Promise((resolve) => deadServer.listen(0, "127.0.0.1", () => {
  const url = `http://127.0.0.1:${deadServer.address().port}`;
  deadServer.close(() => resolve(url));
}));
afterAll(() => server.close());

describe("w34-i1: sync-code en ~/.config/misfinanzas/sync-code", () => {
  it("la ruta por defecto es ~/.config/misfinanzas/sync-code", () => {
    expect(syncCodePath()).toBe(path.join(os.homedir(), ".config", "misfinanzas", "sync-code"));
  });

  it("lee el sync-code (trim) de un fichero con 600", () => {
    const file = tmpSyncCode("test-sync-code-123");
    expect(readSyncCode(file)).toEqual({ ok: true, code: "test-sync-code-123" });
  });

  it("aprieta a 600 los permisos más abiertos (644) y sigue leyendo", () => {
    const file = tmpSyncCode("mf-loose", 0o644);
    expect(readSyncCode(file).ok).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("fichero ausente → {ok:false} graceful, sin lanzar", () => {
    const r = readSyncCode(path.join(os.tmpdir(), "w34i1-noexiste-sync-code"));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/No existe/);
  });
});

describe("w34-i1: header de auth W1", () => {
  it('Authorization: "W1 <sync-code>"', () => {
    expect(authHeader("mf-abc")).toEqual({ Authorization: "W1 mf-abc" });
  });
  it("sin code → sin header (no rompe endpoints públicos)", () => {
    expect(authHeader(null)).toEqual({});
  });
});

describe("w34-i1: CLI e2e — envelope JSON en stdout, exit 0", () => {
  const codeFile = tmpSyncCode("mf-test-code");
  const env = { WARGAME_API: mockUrl, WARGAME_SYNC_CODE_FILE: codeFile };

  it("status imprime JSON con \"status\": y los datos del server, enviando W1", async () => {
    const { code, out } = await runCli(["status"], env);
    expect(code).toBe(0);
    const doc = JSON.parse(out);
    expect(doc.status).toBe(200);
    expect(doc.ok).toBe(true);
    expect(doc.total).toBe(3);
    expect(doc.byState).toEqual({ todo: 3 });
    expect(seen.auth.at(-1)).toBe("W1 mf-test-code");
  });

  it("spec imprime JSON con \"issues\": (ids del server) y \"status\":", async () => {
    const { code, out } = await runCli(["spec"], env);
    expect(code).toBe(0);
    const doc = JSON.parse(out);
    expect(doc.status).toBe(200);
    expect(doc.issues).toEqual(["w34-i9", "w34-i10"]);
  });

  it("spec con fichero manda el body parseado al endpoint", async () => {
    const specFile = tmpSyncCode('{"wargame":34,"idea":"x","answers":["1","2","3","4","5","6","simple"]}');
    const { code, out } = await runCli(["spec", specFile], env);
    expect(code).toBe(0);
    expect(JSON.parse(seen.bodies.at(-1)).wargame).toBe(34);
    expect(JSON.parse(out).issues).toEqual(["w34-i9", "w34-i10"]);
  });

  it("sin sync-code → igual JSON (warning, sin header), exit 0", async () => {
    const { code, out } = await runCli(["status"], { WARGAME_API: mockUrl, WARGAME_SYNC_CODE_FILE: "/tmp/w34i1-nope" });
    expect(code).toBe(0);
    const doc = JSON.parse(out);
    expect(doc.status).toBe(200);
    expect(doc.warning).toMatch(/No existe/);
    expect(seen.auth.at(-1)).toBeNull();
  });

  it("server caído → JSON con status:null y ok:false, exit 0 (el pipe del check no se rompe)", async () => {
    const { code, out } = await runCli(["status"], { WARGAME_API: deadUrl, WARGAME_SYNC_CODE_FILE: codeFile });
    expect(code).toBe(0);
    const doc = JSON.parse(out);
    expect(doc.status).toBeNull();
    expect(doc.ok).toBe(false);
    expect(doc.error).toMatch(/sin conexión/);
  });

  it("HTTP error del server (404) → envelope con status y ok:false, exit 0", async () => {
    const { code, out } = await runCli(["resume"], { ...env, WARGAME_API: mockUrl });
    expect(code).toBe(1); // resume sin id = error de uso
    const { code: c2, out: o2 } = await runCli(["resume", "w34-i9"], env);
    expect(c2).toBe(0);
    const doc = JSON.parse(o2);
    expect(doc.status).toBe(404);
    expect(doc.ok).toBe(false);
  });
});

describe("w34-i1: defaults", () => {
  it("baseUrl default = http://localhost:3000", () => {
    const prev = process.env.WARGAME_API;
    delete process.env.WARGAME_API;
    try { expect(baseUrl()).toBe("http://localhost:3000"); }
    finally { if (prev === undefined) delete process.env.WARGAME_API; else process.env.WARGAME_API = prev; }
  });
});
