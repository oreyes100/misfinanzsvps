// googlePhotos.test.js — Tests de la integración Google Photos (Photo Vault):
// detección de recibos, escáner (URLs + queue items) y seguridad de tokens.
import { describe, expect, it } from "vitest";
import { detectReceipt, hasReceiptSignature, receiptFileNameHint } from "./services/receiptDetector.js";
import { buildMediaUrl, buildQueueItems, thumbnailUrl } from "./services/photoScanner.js";
import { clearTokens, decryptTokens, encryptTokens, hasEncryptedTokens } from "./services/tokenSecurity.js";

function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

// ─────────────────────────── Detector ───────────────────────────

describe("receiptDetector", () => {
  it("reconoce señales de recibo", () => {
    const text = "MERCADO CENTRAL\nSubtotal 45.30\nIVA 16%\nTOTAL 52.55\nEfectivo 53\nVuelto 0.45";
    const d = detectReceipt(text, "recibo_compra.jpg");
    expect(d.kind).toBe("receipt");
    expect(d.confidence).toBeGreaterThan(0.4);
    expect(hasReceiptSignature(text)).toBe(true);
  });

  it("reconoce estado de cuenta", () => {
    const text = "ESTADO DE CUENTA LIVERPOOL\nTarjeta Clasica *1234\nFecha de corte 29/05/2026\nCargo 1,250.00\nAbono 5,000.00\nSaldo actual 4,500.00\nPago minimo 450.00";
    const d = detectReceipt(text, "edc_liverpool.png");
    expect(d.kind).toBe("statement");
    expect(d.confidence).toBeGreaterThan(0.4);
  });

  it("reconoce comprobante de transferencia", () => {
    const text = "Comprobante de transferencia SPEI\nBeneficiario: Juan Perez\nCLABE 0123...\nOrdenante: Yo\nImporte 800.00\nConfirmacion OK";
    const d = detectReceipt(text, "spei_confirm.png");
    expect(d.kind).toBe("transfer");
    expect(d.confidence).toBeGreaterThan(0.4);
  });

  it("descarta texto sin firma financiera", () => {
    const text = "Atardecer en la playa con los amigos del barrio";
    const d = detectReceipt(text, "IMG_20240101_1234.jpg");
    expect(d.kind).toBeNull();
    expect(d.confidence).toBeLessThan(0.4);
  });

  it("respeta el hint de nombre de archivo", () => {
    expect(receiptFileNameHint("recibo_compra.jpg")).toBe(true);
    expect(receiptFileNameHint("factura_energia.pdf")).toBe(true);
    expect(receiptFileNameHint("IMG_2024.jpg")).toBe(false);
    expect(receiptFileNameHint("")).toBe(false);
  });

  it("vacío no es documento", () => {
    expect(hasReceiptSignature("")).toBe(false);
    expect(detectReceipt("", "foto.jpg").kind).toBeNull();
  });
});

// ─────────────────────────── Escáner ───────────────────────────

describe("photoScanner", () => {
  it("construye URLs de descarga y miniatura", () => {
    const base = "https://lh3.googleusercontent.com/ABc123";
    expect(buildMediaUrl(base, 1600)).toBe(`${base}=w1600`);
    expect(thumbnailUrl(base, 300)).toBe(`${base}=w300-h300-c`);
    expect(buildMediaUrl(null)).toBeNull();
  });

  it("convierte un recibo en un item de review (action + preview)", () => {
    const result = {
      item: { id: "m1", filename: "recibo.jpg", baseUrl: "https://x" },
      analysis: {
        kind: "receipt",
        detection: { confidence: 0.85 },
        merchant: "Mercadona",
        total: 52.55,
        date: "2026-08-01",
        category: "Supermercado",
      },
      detection: { kind: "receipt", confidence: 0.85 },
    };
    const items = buildQueueItems(result, { accounts: [{ id: "acc-1", name: "Corriente", currency: "EUR" }] });
    expect(items).toHaveLength(1);
    expect(items[0].source).toBe("ocr");
    expect(items[0].action.type).toBe("add_transaction");
    expect(items[0].action.tx.amount).toBe(-52.55);
    expect(items[0].action.tx.accountId).toBe("acc-1");
    expect(items[0].preview.description).toBe("Mercadona");
  });

  it("convierte un estado de cuenta en N movimientos", () => {
    const result = {
      item: { id: "m2", filename: "edc.png", baseUrl: "https://x" },
      analysis: {
        kind: "statement",
        detection: { confidence: 0.7 },
        movements: [
          { date: "2026-05-01", description: "Walmart", amount: 1245.5, direction: "out" },
          { date: "2026-05-05", description: "Pago recibido", amount: 5000, direction: "in" },
        ],
      },
      detection: { kind: "statement", confidence: 0.7 },
    };
    const items = buildQueueItems(result, { accounts: [{ id: "acc-1", currency: "EUR" }] });
    expect(items).toHaveLength(2);
    expect(items[0].action.tx.amount).toBe(-1245.5);
    expect(items[1].action.tx.amount).toBe(5000);
    expect(items[0].batchId).toBe(items[1].batchId);
  });

  it("convierte una transferencia en action transfer", () => {
    const result = {
      item: { id: "m3", filename: "spei.png", baseUrl: "https://x" },
      analysis: {
        kind: "transfer",
        detection: { confidence: 0.8 },
        transfer: { amount: 800, from: { id: "acc-1", name: "Corriente", currency: "EUR" }, to: { id: "acc-2", name: "Ahorro", currency: "EUR" } },
      },
      detection: { kind: "transfer", confidence: 0.8 },
    };
    const items = buildQueueItems(result, { accounts: [{ id: "acc-1", currency: "EUR" }] });
    expect(items).toHaveLength(1);
    expect(items[0].action.type).toBe("transfer");
    expect(items[0].action.fromId).toBe("acc-1");
    expect(items[0].action.toId).toBe("acc-2");
  });

  it("no genera items sin análisis o sin importe", () => {
    expect(buildQueueItems({ item: {}, detection: { kind: null, confidence: 0 } }, {})).toEqual([]);
    const receiptNoTotal = {
      item: {},
      analysis: { kind: "receipt", detection: { confidence: 0.9 }, total: null },
    };
    expect(buildQueueItems(receiptNoTotal, {})).toEqual([]);
  });

  it("clasifica por confianza (needs_fix < 0.6)", () => {
    const result = {
      item: {},
      analysis: { kind: "statement", detection: { confidence: 0.3 }, movements: [{ date: "2026-01-01", description: "Cargo", amount: 10, direction: "out" }] },
      detection: { kind: "statement", confidence: 0.3 },
    };
    const items = buildQueueItems(result, { accounts: [{ id: "a", currency: "EUR" }] });
    expect(items[0].classification).toBe("needs_fix");
  });
});

// ─────────────────────────── Seguridad de tokens ───────────────────────────

describe("tokenSecurity", () => {
  it("cifra y descifra un roundtrip correcto", async () => {
    const storage = fakeStorage();
    const payload = { access_token: "tok-abc", refresh_token: "ref-xyz", expires_at: 9999999999999 };
    await encryptTokens(payload, "admin", storage);
    expect(hasEncryptedTokens(storage)).toBe(true);
    const out = await decryptTokens("admin", storage);
    expect(out.access_token).toBe("tok-abc");
    expect(out.refresh_token).toBe("ref-xyz");
    expect(out.expires_at).toBe(9999999999999);
    // El texto en claro nunca se guarda tal cual
    expect(storage.getItem("mis-finazas-gphotos-tokens")).not.toContain("tok-abc");
  });

  it("no descifra con otra sesión (clave distinta)", async () => {
    const storage = fakeStorage();
    await encryptTokens({ access_token: "tok" }, "admin", storage);
    expect(await decryptTokens("otro", storage)).toBeNull();
  });

  it("detecta manipulación del ciphertext (MAC falla)", async () => {
    const storage = fakeStorage();
    await encryptTokens({ access_token: "tok" }, "admin", storage);
    const raw = JSON.parse(storage.getItem("mis-finazas-gphotos-tokens"));
    raw.data = raw.data.slice(0, -2) + "AA";
    storage.setItem("mis-finazas-gphotos-tokens", JSON.stringify(raw));
    expect(await decryptTokens("admin", storage)).toBeNull();
  });

  it("clearTokens elimina el blob", async () => {
    const storage = fakeStorage();
    await encryptTokens({ access_token: "tok" }, "admin", storage);
    clearTokens(storage);
    expect(hasEncryptedTokens(storage)).toBe(false);
  });

  it("sin storage o sin sesión → null", async () => {
    expect(await decryptTokens("admin", null)).toBeNull();
    const storage = fakeStorage();
    await encryptTokens({ access_token: "tok" }, "admin", storage);
    expect(await decryptTokens("", storage)).toBeNull();
  });
});