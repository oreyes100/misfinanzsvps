// persistence-integration.ts — Integración de Fortaleza de Datos (MCP-05) con
// Mis Finanzas.
//
// Expone:
//   - MISFINANZAS_PERSISTENCE_CONFIG: configuración de producción (navegador).
//   - createPersistenceOrchestrator(): factory por instancia (StoreProvider y
//     servidor MCP usan cadenas WAL-checkpoint-recovery independientes).
//   - runToolWithPersistence(): envuelve el handler de una tool MCP real; si la
//     tool muta estado financiero, registra la llamada como entrada de auditoría
//     en el WAL (audit trail de MCP-05) con versión interna.

import type { PersistenceConfig } from "./persistence/persistence-types.ts";
import { PersistenceOrchestrator } from "./persistence/persistence-orchestrator.ts";
import type { SecureToolDefinition } from "./tool-registry.ts";
import type { ToolCallContext } from "./retry-integration.ts";

// ─── Configuración de persistencia para misfinanzsvps ─────────
export const MISFINANZAS_PERSISTENCE_CONFIG: PersistenceConfig = {
  wal: {
    storage: "localStorage",
    // Batch de escrituras en navegador (localStorage es síncrono y caro);
    // los tests usan 0 = flush inmediato.
    flushIntervalMs: 5_000,
    keyPrefix: "mis-finazas-persistence",
  },
  checkpoints: {
    storage: "localStorage",
    // Máximo 2 checkpoints: cubre el anterior + el actual para rollback.
    maxHistory: 2,
    keyPrefix: "mis-finazas-persistence",
  },
  recovery: {
    autoHeal: true,
    // Con más de 3 entradas de WAL dañadas no se intenta reconstruir: reset.
    maxToleratedDamage: 3,
  },
  exportImport: {
    // Sin clave por defecto: el export usa solo checksum FNV-1a. Para firma
    // HMAC-SHA256, Settings deberá configurar `signingKey`.
    verifyOnImport: true,
  },
  orchestration: {
    checkpointEvery: { mutations: 5, intervalMs: 30_000 },
    rollbackLimit: 2,
  },
};

/** Factory del orquestador de persistencia con la configuración de Mis Finanzas. */
export function createPersistenceOrchestrator(
  config: PersistenceConfig = MISFINANZAS_PERSISTENCE_CONFIG
): PersistenceOrchestrator {
  return new PersistenceOrchestrator(config);
}

// ─── Tools que mutan estado financiero (audit trail) ──────────
export const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  "add_transaction",
  "transfer_funds",
  "drive_sync",
]);

/**
 * ═══ CORE: Ejecutar una tool real con registro de persistencia ═══
 *
 * Uso en server.ts (capa más externa del chain):
 *   runToolWithPersistence(persistence, tool, args, ctx,
 *     (raw) => runToolWithSecurity(security, tool, raw, ctx,
 *       (sanitized) => runToolWithRetry(retry, tool, sanitized, ctx)))
 *
 * Las tools de solo lectura no escriben en el WAL.
 */
export async function runToolWithPersistence(
  persistence: PersistenceOrchestrator,
  tool: SecureToolDefinition,
  args: unknown,
  ctx: ToolCallContext | undefined,
  inner: (args: unknown) => Promise<unknown>
): Promise<unknown> {
  const result = await inner(args);
  if (MUTATING_TOOLS.has(tool.name)) {
    try {
      persistence.recordMutation({
        tool: tool.name,
        requestedBy: ctx?.clientId || "mcp-client",
        ok: true,
        at: Date.now(),
      });
    } catch {
      // El audit trail nunca debe romper la ejecución de la tool.
    }
  }
  return result;
}