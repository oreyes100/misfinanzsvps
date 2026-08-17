// export-import.ts — Backup de emergencia (MCP-05).
//
// Exporta el estado a un bundle portable:
//   - checksum FNV-1a del data (integridad/corrupción, sync)
//   - firma HMAC-SHA256 opcional vía WebCrypto (crypto.subtle): autenticidad.
//     Node 26 y navegadores exponen `globalThis.crypto.subtle`. Sin clave
//     configurada (o sin crypto.subtle) no se firma → solo checksum.
//
// `importState` valida formato, checksum y firma antes de aceptar el bundle.

import { fnv1a, stableStringify, type ExportBundle, type ImportResult } from "./persistence-types.ts";

export interface ExportImportConfig {
  signingKey?: string;
  verifyOnImport: boolean;
}

export class ExportImport {
  private readonly config: ExportImportConfig;

  constructor(config: ExportImportConfig) {
    this.config = config;
  }

  /** Serializa el estado en un bundle portable (con firma si hay clave). */
  async exportState(state: unknown): Promise<ExportBundle> {
    const bundle: ExportBundle = {
      format: "misfinanzas-backup",
      version: Number((state as { _syncVersion?: number } | null)?._syncVersion ?? 0),
      timestamp: Date.now(),
      checksum: fnv1a(stableStringify(state)),
      data: state,
    };
    if (this.config.signingKey && (await this.canSign())) {
      bundle.signature = await hmacSha256Hex(
        this.config.signingKey,
        stableStringify({ data: bundle.data, version: bundle.version, timestamp: bundle.timestamp, checksum: bundle.checksum })
      );
    }
    return bundle;
  }

  /** Valida y acepta un bundle. `verifyOnImport` + clave exige firma. */
  async importState(bundle: unknown): Promise<ImportResult> {
    if (!bundle || typeof bundle !== "object") {
      return { ok: false, error: "backup inválido: no es un objeto" };
    }
    const b = bundle as Partial<ExportBundle>;
    if (b.format !== "misfinanzas-backup") {
      return { ok: false, error: `formato desconocido: ${String(b.format)}` };
    }
    if (b.data === undefined) {
      return { ok: false, error: "backup sin data" };
    }
    const expected = fnv1a(stableStringify(b.data));
    if (expected !== b.checksum) {
      return { ok: false, error: "checksum no coincide: backup corrupto o manipulado" };
    }
    if (b.signature) {
      if (!(await this.canSign())) {
        return { ok: false, error: "firma presente pero el entorno no soporta verificación" };
      }
      const valid = await verifySignature(
        this.config.signingKey ?? "",
        b.signature,
        stableStringify({ data: b.data, version: b.version, timestamp: b.timestamp, checksum: b.checksum })
      );
      if (!valid) return { ok: false, error: "firma inválida: origen no autenticado" };
    } else if (this.config.verifyOnImport && this.config.signingKey && (await this.canSign())) {
      return { ok: false, error: "backup sin firma pero verifyOnImport exige firma" };
    }
    return { ok: true, state: b.data };
  }

  private async canSign(): Promise<boolean> {
    const g = globalThis as { crypto?: { subtle?: unknown } };
    return Boolean(g.crypto && g.crypto.subtle);
  }
}

/** HMAC-SHA256 en hex. */
async function hmacSha256Hex(key: string, message: string): Promise<string> {
  const g = globalThis as { crypto?: Crypto };
  const crypto = g.crypto;
  if (!crypto?.subtle) throw new Error("crypto.subtle no disponible");
  const enc = new TextEncoder();
  const imported = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", imported, enc.encode(message));
  return [...new Uint8Array(sig)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Verifica un HMAC-SHA256 en hex contra el mensaje. */
async function verifySignature(key: string, signature: string, message: string): Promise<boolean> {
  try {
    const expected = await hmacSha256Hex(key, message);
    return expected === signature;
  } catch {
    return false;
  }
}