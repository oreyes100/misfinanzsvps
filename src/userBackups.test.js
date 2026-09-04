// userBackups.test.js — W33-i6: lógica de listado de respaldos en Ajustes.
// Tests con fetch inyectado (sin red) — el server nunca se toca.
import { describe, it, expect } from "vitest";
import { fetchUserBackups, formatBytes, backupLabel } from "./userBackups.js";

const jsonResponse = (body, ok = true, status = 200) => ({
  ok,
  status,
  json: async () => body,
});

describe("fetchUserBackups", () => {
  it("devuelve [] cuando el usuario aún no tiene respaldos (found:false)", async () => {
    const calls = [];
    const out = await fetchUserBackups("abc-def-1234", (url) => {
      calls.push(url);
      return jsonResponse({ found: false, syncId: "abc-def-1234", backups: [] });
    });
    expect(out).toEqual([]);
    expect(calls).toEqual(["/api/user-backups?id=abc-def-1234"]);
  });

  it("ordena los respaldos del más reciente al más antiguo", async () => {
    const out = await fetchUserBackups("abc-def-1234", () =>
      jsonResponse({
        found: true,
        syncId: "abc-def-1234",
        backups: [
          { date: "2026-09-01", bytes: 100, valid: true },
          { date: "2026-09-04", bytes: 200, valid: true },
          { date: "2026-09-02", bytes: 150, valid: false },
        ],
      })
    );
    expect(out.map((b) => b.date)).toEqual(["2026-09-04", "2026-09-02", "2026-09-01"]);
  });

  it("propaga el error del server (status no ok + mensaje del body)", async () => {
    await expect(
      fetchUserBackups("abc-def-1234", () => jsonResponse({ error: "Código de sincronización inválido." }, false, 400))
    ).rejects.toThrow("Código de sincronización inválido.");
  });

  it("usa mensaje genérico si el body de error no es parseable", async () => {
    const bad = { ok: false, status: 500, json: async () => { throw new Error("no json"); } };
    await expect(fetchUserBackups("abc-def-1234", () => bad)).rejects.toThrow("Error 500 al listar respaldos");
  });

  it("rechaza sin syncId activo y codifica el id en la URL", async () => {
    await expect(fetchUserBackups(null, () => jsonResponse({ found: false }))).rejects.toThrow(/Sincronización no activa/);
    await expect(fetchUserBackups("", () => jsonResponse({ found: false }))).rejects.toThrow(/Sincronización no activa/);

    let url = "";
    await fetchUserBackups("id con espacios/ño", (u) => { url = u; return jsonResponse({ found: false }); });
    expect(url).toBe(`/api/user-backups?id=${encodeURIComponent("id con espacios/ño")}`);
  });
});

describe("formatBytes", () => {
  it("unidades binarias y fallback para inválidos", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 kB");
    expect(formatBytes(12_615)).toBe("12.3 kB");
    expect(formatBytes(1_572_864)).toBe("1.5 MB");
    expect(formatBytes(-5)).toBe("—");
    expect(formatBytes(undefined)).toBe("—");
    expect(formatBytes("nope")).toBe("—");
  });
});

describe("backupLabel", () => {
  it("compone fecha, tamaño, versión y conteos", () => {
    expect(
      backupLabel({ date: "2026-09-04", bytes: 12_615, syncVersion: 42, counts: { accounts: 3, transactions: 120 } })
    ).toBe("2026-09-04 · 12.3 kB · v42 · 3 cuentas · 120 movs");
    expect(backupLabel({ date: "2026-09-03", bytes: null, syncVersion: null, counts: null })).toBe("2026-09-03 · —");
    expect(backupLabel(null)).toBe("respaldo");
    expect(backupLabel({})).toBe("respaldo");
  });
});
