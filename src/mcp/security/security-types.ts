// security-types.ts — Tipos del sistema de seguridad MCP-04 (Cortafuegos de
// Semántica): Schema Validation, Sandboxing, Human-in-the-Loop, Supply Chain.
//
// IMPORTANTE: se reutiliza `SensitivityLevel` (minúsculas: "low".."critical")
// de capability-types.ts para alinearse con las tools reales. Sin enums ni
// parameter properties (Node 26 strip-only no los soporta).

import type { SensitivityLevel } from "../capability-types.ts";

export type { SensitivityLevel };

// ─── Resultado de validación de schema ────────────────────────
export interface SchemaValidationError {
  path: string;
  code: string;
  message: string;
  severity: "error" | "fatal";
}

export interface SchemaValidationWarning {
  path: string;
  code: string;
  message: string;
  suggestion?: string;
}

export interface SchemaValidationResult {
  valid: boolean;
  errors: SchemaValidationError[];
  warnings: SchemaValidationWarning[];
  sanitizedParams?: Record<string, unknown>;
  metadata: {
    validationTimeMs: number;
    schemaVersion: string;
    schemaHash: string;
    rulesApplied: number;
  };
}

// ─── Definición de schema registrado ──────────────────────────
export interface SchemaPermissions {
  requiredScopes: string[];
  networkAccess: string[];
  fileSystemAccess: "none" | "read" | "write" | "readwrite";
  maxExecutionTimeMs: number;
  maxMemoryBytes: number;
  requiresHumanApproval: boolean;
  allowedEnvironments: ("dev" | "staging" | "production")[];
}

export interface RegisteredSchema {
  toolName: string;
  version: string;
  schema: Record<string, unknown>;
  canonicalHash: string;
  signature: string;
  registeredAt: number;
  registeredBy: string;
  sensitivity: SensitivityLevel;
  status: "active" | "deprecated" | "revoked";
  permissions: SchemaPermissions;
}

// ─── Configuración del sandbox ────────────────────────────────
export interface SandboxConfig {
  maxExecutionTimeMs: number;
  maxMemoryBytes: number;
  networkAllowlist: string[];
  allowFileSystem: boolean;
  allowedDirectories: string[];
  isolateGlobalContext: boolean;
  maxObjectDepth: number;
  maxParamsSizeBytes: number;
}

// ─── Configuración de Human-in-the-Loop ───────────────────────
export interface HumanInTheLoopConfig {
  enabled: boolean;
  approvalThreshold: SensitivityLevel;
  twoFactorThreshold: SensitivityLevel;
  approvalTimeoutMs: number;
  requireSignature: boolean;
  approvalMethods: ("button" | "voice" | "biometric" | "pin")[];
  auditLog: {
    enabled: boolean;
    storage: "memory" | "localStorage" | "server";
    maxEntries: number;
  };
}

// ─── Configuración de supply chain integrity ──────────────────
export interface SupplyChainConfig {
  enabled: boolean;
  hashAlgorithm: "sha256" | "sha512";
  signatureAlgorithm: "ed25519" | "rsa-pss";
  registryPublicKey?: string;
  allowUnregisteredInDev: boolean;
  reVerificationIntervalMs: number;
  onVerificationFailure: "reject" | "quarantine" | "alert_only";
}

// ─── Configuración global de seguridad ────────────────────────
export interface SecurityConfig {
  schemaValidation: {
    strictMode: boolean;
    rejectAdditionalProperties: boolean;
    maxParamStringLength: number;
    maxArrayLength: number;
    detectInjectionPatterns: boolean;
  };
  sandbox: SandboxConfig;
  humanInTheLoop: HumanInTheLoopConfig;
  supplyChain: SupplyChainConfig;
  logging: {
    level: "debug" | "info" | "warn" | "error";
    logAllValidations: boolean;
    logBlockedRequests: boolean;
    logApprovals: boolean;
    redactSensitiveData: boolean;
  };
}

// ─── Solicitud de aprobación (para HITL) ──────────────────────
export interface ApprovalRequest {
  id: string;
  toolName: string;
  params: Record<string, unknown>;
  sensitivity: SensitivityLevel;
  requestedBy: string;
  requestedAt: number;
  expiresAt: number;
  preview: {
    description: string;
    impact: string;
    reversible: boolean;
    affectedResources: string[];
  };
  status: "pending" | "approved" | "rejected" | "expired";
  approval?: {
    approvedBy: string;
    approvedAt: number;
    method: string;
    signature: string;
    twoFactorVerified: boolean;
  };
}

// ─── Eventos de seguridad ─────────────────────────────────────
export type SecurityEvent =
  | { type: "schema_validation_failed"; tool: string; errors: SchemaValidationError[] }
  | { type: "schema_validation_passed"; tool: string; validationTimeMs: number }
  | { type: "injection_detected"; tool: string; paramPath: string; pattern: string }
  | { type: "sandbox_timeout"; tool: string; executionTimeMs: number }
  | { type: "sandbox_memory_exceeded"; tool: string; memoryBytes: number }
  | { type: "network_blocked"; tool: string; domain: string }
  | { type: "approval_requested"; tool: string; requestId: string; sensitivity: SensitivityLevel }
  | { type: "approval_granted"; tool: string; requestId: string; approvedBy: string }
  | { type: "approval_rejected"; tool: string; requestId: string; rejectedBy: string }
  | { type: "approval_expired"; tool: string; requestId: string }
  | { type: "unregistered_schema"; tool: string; schemaHash: string }
  | { type: "schema_tampered"; tool: string; expectedHash: string; actualHash: string }
  | { type: "supply_chain_alert"; tool: string; reason: string };
