import { describe, it, expect } from "vitest";
import nodeCrypto from "node:crypto";

// Réplica del hashPassword del cliente (auth.js, WebCrypto PBKDF2).
async function webHash(password, salt) {
  const key = await globalThis.crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await globalThis.crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: new TextEncoder().encode(salt), iterations: 100_000, hash: "SHA-256" }, key, 256
  );
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
// Réplica del verify del servidor (api/users.js, Node crypto).
const serverHash = (password, salt) => nodeCrypto.pbkdf2Sync(String(password), String(salt), 100_000, 32, "sha256").toString("hex");

describe("auth · paridad PBKDF2 cliente/servidor (verify en la nube)", () => {
  const salt = "c29tZXNhbHRfYmFzZTY0MTIz"; // base64 arbitrario

  it("el hash del cliente y del servidor coinciden para la misma contraseña+salt", async () => {
    expect(await webHash("010325Aj", salt)).toBe(serverHash("010325Aj", salt));
  });

  it("una contraseña incorrecta NO coincide con el hash de la correcta", async () => {
    const correcto = serverHash("010325Aj", salt);
    expect(await webHash("otraCosa1", salt)).not.toBe(correcto);
    expect(serverHash("otraCosa1", salt)).not.toBe(correcto);
  });

  it("salts distintos producen hashes distintos para la misma contraseña", () => {
    expect(serverHash("010325Aj", "saltA")).not.toBe(serverHash("010325Aj", "saltB"));
  });
});
