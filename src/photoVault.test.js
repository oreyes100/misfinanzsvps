import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { scoreReceiptCandidate, isLikelyReceipt, detectReceipt } from "./services/receiptDetector.js";
import { handleGoogleToken, handleGoogleConfig } from "../server/googleToken.mjs";

function mockRes() {
  const headers = {};
  let status = 200;
  let body = "";
  return {
    writeHead(s, h = {}) { status = s; Object.assign(headers, h); },
    end(b) { body = b; },
    get status() { return status; },
    get body() { return body; },
    get json() { try { return JSON.parse(body); } catch { return null; } },
  };
}

describe("photoVault · detector multi-capa (Fase 2)", () => {
  it("paisaje (ratio <0.8) no es recibo", () => {
    const item = { filename: "IMG_1234.jpg", mediaMetadata: { width: 4000, height: 2000 } };
    expect(scoreReceiptCandidate(item)).toBeLessThan(30);
    expect(isLikelyReceipt(item)).toBe(false);
  });
  it("recibo vertical (ratio >1.2) es candidato", () => {
    const item = { filename: "recibo.jpg", mediaMetadata: { width: 1000, height: 2000 } };
    expect(scoreReceiptCandidate(item)).toBeGreaterThanOrEqual(30);
    expect(isLikelyReceipt(item)).toBe(true);
  });
  it("nombre con hint suma 15", () => {
    const item = { filename: "recibo_compra.jpg", mediaMetadata: {} };
    expect(scoreReceiptCandidate(item)).toBe(15);
  });
  it("detectReceipt sigue funcionando (compat)", () => {
    const d = detectReceipt("TOTAL 100.00 IVA 16%", "ticket.jpg");
    expect(d.kind).toBe("receipt");
  });
});

describe("photoVault · googleToken server (Fase 1)", () => {
  const originalEnv = { ...process.env };
  afterEach(() => { process.env = { ...originalEnv }; vi.restoreAllMocks(); });

  it("400 si faltan code/verifier", async () => {
    const req = { method: "POST", headers: {} };
    const res = mockRes();
    await handleGoogleToken(req, res, {});
    expect(res.status).toBe(400);
  });

  it("503 si GOOGLE_CLIENT_ID no configurado", async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    const req = { method: "POST", headers: {} };
    const res = mockRes();
    await handleGoogleToken(req, res, { code: "c", verifier: "v" });
    expect(res.status).toBe(503);
  });

  it("intercambia via server y valida scope photoslibrary.readonly", async () => {
    process.env.GOOGLE_CLIENT_ID = "test-client-id";
    const fakeFetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600, scope: "https://www.googleapis.com/auth/photoslibrary.readonly" }),
    }));
    vi.stubGlobal("fetch", fakeFetch);
    const req = { method: "POST", headers: { host: "dineroorganizado.duckdns.org", "x-forwarded-proto": "https" } };
    const res = mockRes();
    await handleGoogleToken(req, res, { code: "code123", verifier: "verifier123", redirect_uri: "https://dineroorganizado.duckdns.org/oauth/callback" });
    expect(res.status).toBe(200);
    expect(res.json.access_token).toBe("at");
    expect(fakeFetch).toHaveBeenCalledOnce();
    const body = fakeFetch.mock.calls[0][1].body;
    expect(body).toContain("code_verifier=verifier123");
    expect(body).toContain("client_id=test-client-id");
  });

  it("GET /api/google-config expone clientId y scope", async () => {
    process.env.GOOGLE_CLIENT_ID = "my-id";
    const req = { method: "GET" };
    const res = mockRes();
    await handleGoogleConfig(req, res);
    expect(res.status).toBe(200);
    expect(res.json.clientId).toBe("my-id");
    expect(res.json.scope).toContain("photoslibrary.readonly");
  });
});

describe("photoVault · client PKCE (Fase 1)", () => {
  it("startAuth usa scope readonly únicamente", async () => {
    const { PHOTOS_SCOPE } = await import("./services/googlePhotos.js");
    expect(PHOTOS_SCOPE).toBe("https://www.googleapis.com/auth/photoslibrary.readonly");
  });
});
