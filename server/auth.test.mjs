// auth.test.mjs — w32-i3: sesiones por cookie (registro paso único).
// Unit tests sin red: reqs falsos con header cookie.

import test from "node:test";
import assert from "node:assert/strict";
import { SESSION_COOKIE, createSession, parseCookieHeader, sessionCookie, sessionUsername } from "./auth.mjs";

function fakeReq(cookieHeader) {
  return { headers: cookieHeader === undefined ? {} : { cookie: cookieHeader } };
}

test("auth: createSession + sessionUsername roundtrip", () => {
  const token = createSession("alice");
  assert.equal(typeof token, "string");
  assert.ok(token.length >= 64, "token de 32 bytes hex");
  const req = fakeReq(`${SESSION_COOKIE}=${token}`);
  assert.equal(sessionUsername(req), "alice");
});

test("auth: la cookie emitida es HttpOnly + SameSite=Lax + Path=/", () => {
  const token = createSession("bob");
  const cookie = sessionCookie(token);
  assert.ok(cookie.startsWith(`${SESSION_COOKIE}=`));
  assert.ok(cookie.includes("HttpOnly"), "HttpOnly (no accesible por JS)");
  assert.ok(cookie.includes("SameSite=Lax"));
  assert.ok(cookie.includes("Path=/"));
  // roundtrip a través del header real
  assert.equal(sessionUsername(fakeReq(cookie)), "bob");
});

test("auth: cookies inválidas o ausentes → null", () => {
  assert.equal(sessionUsername(fakeReq(undefined)), null, "sin header cookie");
  assert.equal(sessionUsername(fakeReq("")), null, "header vacío");
  assert.equal(sessionUsername(fakeReq("other=1; foo=bar")), null, "sin la cookie de sesión");
  assert.equal(sessionUsername(fakeReq(`${SESSION_COOKIE}=deadbeef`)), null, "token desconocido");
  assert.equal(sessionUsername(fakeReq(`${SESSION_COOKIE}=${"x".repeat(5000)}`)), null, "token basura gigante");
});

test("auth: parseCookieHeader tolera formatos reales", () => {
  assert.deepEqual(parseCookieHeader("a=1; b=two%20words"), { a: "1", b: "two words" });
  assert.deepEqual(parseCookieHeader("novalue"), {});
  assert.deepEqual(parseCookieHeader(null), {});
  assert.deepEqual(parseCookieHeader("a=1;;b=2"), { a: "1", b: "2" });
});

test("auth: el store de sesiones acota memoria (evict FIFO al superar el tope)", () => {
  // El tope real es 1000; verifying eviction con el propio mapa vía roundtrip:
  // creamos 1200 sesiones y comprobamos que la más vieja ya no resuelve.
  const oldest = createSession("first");
  for (let i = 0; i < 1200; i++) createSession(`bulk-${i}`);
  assert.equal(sessionUsername(fakeReq(`${SESSION_COOKIE}=${oldest}`)), null, "sesión vieja evictada");
  const last = createSession("last");
  assert.equal(sessionUsername(fakeReq(`${SESSION_COOKIE}=${last}`)), "last", "sesión reciente viva");
});
