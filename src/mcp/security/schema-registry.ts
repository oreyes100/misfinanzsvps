// schema-registry.ts — Registry de schemas autorizados con integridad de
// supply chain (MCP-04).
//
// Protección contra:
//   - Schema poisoning (schemas maliciosos inyectados por un MCP server comprometido)
//   - Tampering (modificación de schemas en tránsito)
//   - Suplantación de MCP servers
//
// Integridad REAL (no simplificada): canonical JSON → SHA-256 → firma Ed25519
// con par de claves generado por instancia (node:crypto).

import { createHash, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import type { RegisteredSchema, SupplyChainConfig, SecurityEvent, SensitivityLevel } from "./security-types.ts";

export class SchemaRegistry {
  private schemas = new Map<string, RegisteredSchema>();
  private readonly config: SupplyChainConfig;
  private eventHandler?: (event: SecurityEvent) => void;
  private privateKey: KeyObject;
  private publicKey: KeyObject;

  constructor(config: SupplyChainConfig, eventHandler?: (event: SecurityEvent) => void) {
    this.config = config;
    this.eventHandler = eventHandler;
    const pair = generateKeyPairSync("ed25519");
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
  }

  /** ═══ CORE: Registrar un schema autorizado ═══ */
  register(
    schema: Omit<RegisteredSchema, "canonicalHash" | "signature" | "registeredAt" | "status">
  ): RegisteredSchema {
    const canonicalJson = this.canonicalize(schema.schema);
    const canonicalHash = this.computeHash(canonicalJson);
    const signature = this.sign(canonicalHash);

    const registeredSchema: RegisteredSchema = {
      ...schema,
      canonicalHash,
      signature,
      registeredAt: Date.now(),
      status: "active",
    };

    this.schemas.set(schema.toolName, registeredSchema);

    console.log(
      `[SchemaRegistry] Registrado: ${schema.toolName} ` +
      `(hash: ${canonicalHash.slice(0, 12)}..., sensibilidad: ${schema.sensitivity})`
    );

    return registeredSchema;
  }

  /** ═══ CORE: Verificar un schema recibido ═══ */
  verify(toolName: string, receivedSchema: Record<string, unknown>): {
    valid: boolean;
    reason?: string;
    registeredSchema?: RegisteredSchema;
  } {
    if (!this.config.enabled) {
      return { valid: true };
    }

    const registered = this.schemas.get(toolName);

    if (!registered) {
      const isDev = this.config.allowUnregisteredInDev &&
        typeof process !== "undefined" && process.env.NODE_ENV === "development";
      if (isDev) {
        console.warn(`[SchemaRegistry] Schema no registrado para '${toolName}' (permitido en modo dev)`);
        return { valid: true };
      }

      const schemaHash = this.computeHash(this.canonicalize(receivedSchema));
      this.eventHandler?.({ type: "unregistered_schema", tool: toolName, schemaHash });

      return {
        valid: false,
        reason: `Schema para '${toolName}' no está registrado en el registry`,
      };
    }

    if (registered.status === "revoked") {
      return { valid: false, reason: `Schema para '${toolName}' ha sido revocado` };
    }

    if (registered.status === "deprecated") {
      console.warn(`[SchemaRegistry] Schema para '${toolName}' está deprecado`);
    }

    const receivedHash = this.computeHash(this.canonicalize(receivedSchema));

    if (receivedHash !== registered.canonicalHash) {
      this.eventHandler?.({
        type: "schema_tampered",
        tool: toolName,
        expectedHash: registered.canonicalHash,
        actualHash: receivedHash,
      });
      return { valid: false, reason: `Schema para '${toolName}' ha sido modificado (hash mismatch)` };
    }

    if (!this.verifySignature(registered.canonicalHash, registered.signature)) {
      this.eventHandler?.({ type: "supply_chain_alert", tool: toolName, reason: "Firma del schema inválida" });
      return { valid: false, reason: `Firma del schema para '${toolName}' es inválida` };
    }

    return { valid: true, registeredSchema: registered };
  }

  getSchema(toolName: string): RegisteredSchema | undefined {
    return this.schemas.get(toolName);
  }

  getActiveSchemas(): RegisteredSchema[] {
    return Array.from(this.schemas.values()).filter((s) => s.status === "active");
  }

  getSensitivity(toolName: string): SensitivityLevel | undefined {
    return this.schemas.get(toolName)?.sensitivity;
  }

  revoke(toolName: string, reason: string): boolean {
    const schema = this.schemas.get(toolName);
    if (!schema) return false;

    schema.status = "revoked";
    this.eventHandler?.({ type: "supply_chain_alert", tool: toolName, reason: `Schema revocado: ${reason}` });
    console.warn(`[SchemaRegistry] Revocado: ${toolName} (${reason})`);
    return true;
  }

  /** Canonicalizar un objeto JSON (ordenar claves recursivamente). */
  private canonicalize(obj: unknown): string {
    return JSON.stringify(this.sortKeys(obj));
  }

  private sortKeys(obj: unknown): unknown {
    if (obj === null || typeof obj !== "object") return obj;
    if (Array.isArray(obj)) return obj.map((item) => this.sortKeys(item));

    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(obj as Record<string, unknown>).sort();
    for (const key of keys) {
      sorted[key] = this.sortKeys((obj as Record<string, unknown>)[key]);
    }
    return sorted;
  }

  private computeHash(input: string): string {
    const algorithm = this.config.hashAlgorithm === "sha512" ? "sha512" : "sha256";
    return createHash(algorithm).update(input, "utf8").digest("hex");
  }

  private sign(hash: string): string {
    const sig = sign(null, Buffer.from(hash, "utf8"), this.privateKey);
    return sig.toString("base64");
  }

  private verifySignature(hash: string, signature: string): boolean {
    try {
      return verify(null, Buffer.from(hash, "utf8"), this.publicKey, Buffer.from(signature, "base64"));
    } catch {
      return false;
    }
  }
}