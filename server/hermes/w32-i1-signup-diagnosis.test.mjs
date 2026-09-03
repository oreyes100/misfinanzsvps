// w32-i1-signup-diagnosis.test.mjs — W32-I1: diagnóstico del fallo en /api/signup.
// Pinnea la causa raíz a nivel de fuente: el mensaje
// "Registro por correo no disponible en este momento." nace EXCLUSIVAMENTE de la
// guardia `if (!apiKey)` sobre `process.env.RESEND_API_KEY` en handleSignup
// (server/server.mjs:515-516), y no de ratelimit, validación ni BD.
//
// No importa server.mjs ni db.mjs: el primero abre SQLite (server/data) y bindea
// el puerto 3000 al importarse; el diagnóstico es de fuente, 100% hermético.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SERVER_MJS = join(dirname(fileURLToPath(import.meta.url)), "..", "server.mjs");
const source = readFileSync(SERVER_MJS, "utf8");
const lines = source.split("\n");
const MESSAGE = "Registro por correo no disponible en este momento.";

test("W32-I1: el mensaje de error aparece exactamente una vez en server.mjs y dentro de handleSignup", () => {
  const hits = lines
    .map((l, i) => ({ line: i + 1, text: l }))
    .filter((x) => x.text.includes(MESSAGE));
  assert.equal(hits.length, 1, "el mensaje debe tener un único origen en el repo");
  // Debe estar dentro de handleSignup (definida antes, router después).
  const fnStart = lines.findIndex((l) => l.includes("function handleSignup"));
  const fnEnd = lines.findIndex((l) => l.includes("async function readBodyAllowEmpty"));
  assert.ok(fnStart > 0, "handleSignup existe");
  assert.ok(hits[0].line > fnStart && hits[0].line < fnEnd, `el mensaje (línea ${hits[0].line}) vive dentro de handleSignup`);
});

test("W32-I1: la guardia es `if (!apiKey)` sobre process.env.RESEND_API_KEY y corta con 503", () => {
  const msgIdx = lines.findIndex((l) => l.includes(MESSAGE));
  // La línea del mensaje debe ser un return 503…
  assert.match(lines[msgIdx], /return sendJson\(res,\s*503/);
  // …inmediatamente precedida por la lectura de la env var.
  assert.match(lines[msgIdx - 1], /const apiKey = process\.env\.RESEND_API_KEY/);
  assert.match(lines[msgIdx], /if \(!apiKey\)/);
});

test("W32-I1: la clave se consume contra la API de Resend (sin key no hay email → 503)", () => {
  assert.match(source, /https:\/\/api\.resend\.com\/emails/);
  assert.match(source, /Authorization: `Bearer \$\{apiKey\}`/);
});

test("W32-I1: descartada BD — el pending se escribe ANTES de la guardia de env", () => {
  const msgIdx = lines.findIndex((l) => l.includes(MESSAGE));
  const before = lines.slice(0, msgIdx).join("\n");
  const writePendingsCalls = before.match(/writePendings\(db, pendings\)/g) || [];
  assert.ok(writePendingsCalls.length >= 1, "writePendings corre antes del 503 → la BD no es la causa");
});

test("W32-I1: descartada rate-limit y endpoint-missing — ruta despachada sin limiter", () => {
  assert.match(source, /urlPath === "\/api\/signup"\) return await handleSignup/);
  const routeIdx = lines.findIndex((l) => l.includes('urlPath === "/api/signup"'));
  const routeLine = lines[routeIdx];
  assert.ok(!/Limiter|limiter|isAllowed/.test(routeLine), "el path /api/signup no pasa por rate limiter");
  // ratelimit.mjs no genera el mensaje diagnosticado.
  const ratelimit = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "ratelimit.mjs"), "utf8");
  assert.ok(!ratelimit.includes(MESSAGE));
});

test("W32-I1: el frontend usa la ruta afectada (action:request con email+password)", () => {
  const login = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "components", "Login.jsx"), "utf8");
  assert.match(login, /action: "request", email, password/);
  assert.match(login, /\/api\/signup/);
});
