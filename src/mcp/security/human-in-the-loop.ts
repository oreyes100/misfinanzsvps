// human-in-the-loop.ts — Gate de aprobación humana (MCP-04).
//
// Flujo:
//   1. Tool call sensible detectado (sensibilidad ≥ umbral)
//   2. ApprovalRequest con previsualización (descripción, impacto, recursos)
//   3. Aprobación (button/voice/biometric/pin) con 2FA para CRITICAL
//   4. Firma digital de la aprobación (SHA-256, no repudio)
//   5. Ejecutar solo si está aprobado
//
// Niveles: low/medium → auto-ejecutar; high → previsualizar + aprobar;
// critical → previsualizar + aprobar + 2FA.

import { createHash } from "node:crypto";
import type { ApprovalRequest, HumanInTheLoopConfig, SecurityEvent, SensitivityLevel } from "./security-types.ts";

const THRESHOLD_ORDER: SensitivityLevel[] = ["low", "medium", "high", "critical"];

export class HumanInTheLoopGate {
  private readonly config: HumanInTheLoopConfig;
  private pendingApprovals = new Map<string, ApprovalRequest>();
  private auditLog: ApprovalRequest[] = [];
  private eventHandler?: (event: SecurityEvent) => void;
  private approvalCallbacks = new Map<string, (approved: boolean) => void>();
  private timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(config: HumanInTheLoopConfig, eventHandler?: (event: SecurityEvent) => void) {
    this.config = config;
    this.eventHandler = eventHandler;
  }

  private levelIndex(level: SensitivityLevel): number {
    const idx = THRESHOLD_ORDER.indexOf(level);
    return idx === -1 ? 0 : idx;
  }

  /** ¿Requiere aprobación? Sensibilidad ≥ approvalThreshold. */
  requiresApproval(sensitivity: SensitivityLevel): boolean {
    if (!this.config.enabled) return false;
    return this.levelIndex(sensitivity) >= this.levelIndex(this.config.approvalThreshold);
  }

  /** ¿Requiere 2FA? Sensibilidad ≥ twoFactorThreshold. */
  requiresTwoFactor(sensitivity: SensitivityLevel): boolean {
    if (!this.config.enabled) return false;
    return this.levelIndex(sensitivity) >= this.levelIndex(this.config.twoFactorThreshold);
  }

  /** ═══ CORE: Crear una solicitud de aprobación ═══ */
  createApprovalRequest(params: {
    toolName: string;
    toolParams: Record<string, unknown>;
    sensitivity: SensitivityLevel;
    requestedBy: string;
    preview: { description: string; impact: string; reversible: boolean; affectedResources: string[] };
  }): ApprovalRequest {
    const id = `approval_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();

    const request: ApprovalRequest = {
      id,
      toolName: params.toolName,
      params: params.toolParams,
      sensitivity: params.sensitivity,
      requestedBy: params.requestedBy,
      requestedAt: now,
      expiresAt: now + this.config.approvalTimeoutMs,
      preview: params.preview,
      status: "pending",
    };

    this.pendingApprovals.set(id, request);
    this.eventHandler?.({
      type: "approval_requested",
      tool: params.toolName,
      requestId: id,
      sensitivity: params.sensitivity,
    });

    console.log(
      `[HITL] Aprobación solicitada: ${params.toolName} ` +
      `(sensibilidad: ${params.sensitivity}, expira en ${this.config.approvalTimeoutMs / 1000}s)`
    );

    return request;
  }

  /** ═══ CORE: Aprobar una solicitud ═══ */
  approve(
    requestId: string,
    approvedBy: string,
    method: string,
    twoFactorVerified = false
  ): { success: boolean; reason?: string; signature?: string } {
    const request = this.pendingApprovals.get(requestId);

    if (!request) return { success: false, reason: "Solicitud de aprobación no encontrada" };
    if (request.status !== "pending") return { success: false, reason: `Solicitud ya está ${request.status}` };

    if (Date.now() > request.expiresAt) {
      request.status = "expired";
      this.eventHandler?.({ type: "approval_expired", tool: request.toolName, requestId });
      return { success: false, reason: "Solicitud de aprobación expirada" };
    }

    if (this.requiresTwoFactor(request.sensitivity) && !twoFactorVerified) {
      return { success: false, reason: "Se requiere verificación de dos factores para esta operación" };
    }

    if (!this.config.approvalMethods.includes(method as HumanInTheLoopConfig["approvalMethods"][number])) {
      return { success: false, reason: `Método de aprobación '${method}' no está permitido` };
    }

    const signature = this.signApproval(request, approvedBy, method);

    request.status = "approved";
    request.approval = {
      approvedBy,
      approvedAt: Date.now(),
      method,
      signature,
      twoFactorVerified,
    };

    this.auditLog.push(request);
    this.pendingApprovals.delete(requestId);

    this.eventHandler?.({ type: "approval_granted", tool: request.toolName, requestId, approvedBy });

    const callback = this.approvalCallbacks.get(requestId);
    if (callback) {
      callback(true);
      this.approvalCallbacks.delete(requestId);
    }

    console.log(`[HITL] Aprobación concedida: ${request.toolName} por ${approvedBy} (método: ${method}, 2FA: ${twoFactorVerified})`);

    return { success: true, signature };
  }

  /** ═══ CORE: Rechazar una solicitud ═══ */
  reject(requestId: string, rejectedBy: string): { success: boolean } {
    const request = this.pendingApprovals.get(requestId);
    if (!request) return { success: false };

    request.status = "rejected";
    this.auditLog.push(request);
    this.pendingApprovals.delete(requestId);

    this.eventHandler?.({ type: "approval_rejected", tool: request.toolName, requestId, rejectedBy });

    const callback = this.approvalCallbacks.get(requestId);
    if (callback) {
      callback(false);
      this.approvalCallbacks.delete(requestId);
    }

    console.log(`[HITL] Aprobación rechazada: ${request.toolName} por ${rejectedBy}`);
    return { success: true };
  }

  /** Esperar aprobación (flujos síncronos). Resuelve por callback o expiración. */
  waitForApproval(requestId: string): Promise<boolean> {
    return new Promise((resolve) => {
      const request = this.pendingApprovals.get(requestId);
      if (!request) {
        const audited = this.auditLog.find((r) => r.id === requestId);
        resolve(audited ? audited.status === "approved" : false);
        return;
      }
      if (request.status === "approved") { resolve(true); return; }
      if (request.status === "rejected") { resolve(false); return; }

      this.approvalCallbacks.set(requestId, resolve);

      const timer = setTimeout(() => {
        this.timers.delete(timer);
        const req = this.pendingApprovals.get(requestId);
        if (req && req.status === "pending") {
          req.status = "expired";
          this.eventHandler?.({ type: "approval_expired", tool: req.toolName, requestId });
          const cb = this.approvalCallbacks.get(requestId);
          if (cb) {
            cb(false);
            this.approvalCallbacks.delete(requestId);
          }
        }
      }, this.config.approvalTimeoutMs);
      this.timers.add(timer);
    });
  }

  getPendingApprovals(): ApprovalRequest[] {
    return Array.from(this.pendingApprovals.values());
  }

  getAuditLog(limit = 100): ApprovalRequest[] {
    return this.auditLog.slice(-Math.min(limit, this.config.auditLog.maxEntries));
  }

  /** Firma SHA-256 del payload de aprobación (no repudio). */
  private signApproval(request: ApprovalRequest, approvedBy: string, method: string): string {
    const payload = JSON.stringify({
      requestId: request.id,
      toolName: request.toolName,
      approvedBy,
      method,
      timestamp: Date.now(),
    });
    return `approval_sig_${createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 32)}`;
  }

  /** Liberar timers pendientes (onclose del servidor). */
  destroy(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.approvalCallbacks.clear();
  }
}