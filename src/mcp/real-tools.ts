// real-tools.ts — Registro de las herramientas REALES del proyecto en el
// DynamicToolRegistry. Cada handler delega en data-services.js (state-store,
// OCR, drive-mcp): sin datos mock.

import { DynamicToolRegistry, type SecureToolDefinition } from "./tool-registry.ts";
import {
  getBalance,
  addTransaction,
  transferFunds,
  scanReceipt,
  scanTransfer,
  driveStatus,
  driveSync,
  drivePending,
} from "./data-services.js";
import type { McpScope } from "./capability-types.ts";

const str = (description: string, sensitive = false) => ({
  type: "string",
  description,
  ...(sensitive ? { sensitivity: "high" } : {}),
});

/** Registra todas las herramientas reales de Mis Finanzas. */
export function registerRealTools(registry: DynamicToolRegistry): DynamicToolRegistry {
  const tools: SecureToolDefinition[] = [
    {
      name: "get_balance",
      description: "Obtiene el balance de una cuenta (o de todas) de un usuario por syncCode.",
      inputSchema: {
        type: "object",
        properties: {
          syncCode: str("Código de sincronización del usuario", true),
          accountId: str("ID de la cuenta (opcional; sin él devuelve todas)"),
        },
        required: ["syncCode"],
      },
      handler: (p: any) => getBalance(p),
      requiredScopes: ["read"],
      sensitivity: "medium",
      requiresIdempotency: false,
      requiresHumanApproval: false,
      rateLimitPerMinute: 60,
    },
    {
      name: "add_transaction",
      description: "Registra una nueva transacción y ajusta el balance de la cuenta.",
      inputSchema: {
        type: "object",
        properties: {
          syncCode: str("Código de sincronización del usuario", true),
          accountId: str("ID de la cuenta destino"),
          amount: { type: "number", description: "Importe (positivo ingreso, negativo gasto)" },
          description: str("Descripción de la transacción"),
          category: str("Categoría (opcional)"),
          date: str("Fecha ISO YYYY-MM-DD (opcional)"),
        },
        required: ["syncCode", "accountId", "amount", "description"],
      },
      handler: (p: any) => addTransaction(p),
      requiredScopes: ["read", "write"],
      sensitivity: "medium",
      requiresIdempotency: true,
      requiresHumanApproval: false,
      rateLimitPerMinute: 30,
    },
    {
      name: "transfer_funds",
      description: "Transfiere fondos entre cuentas (con FX si la divisa difiere). Requiere aprobación humana.",
      inputSchema: {
        type: "object",
        properties: {
          syncCode: str("Código de sincronización del usuario", true),
          fromAccountId: str("Cuenta origen"),
          toAccountId: str("Cuenta destino"),
          amount: { type: "number", description: "Importe en la divisa de la cuenta origen" },
          notes: str("Nota (opcional)"),
        },
        required: ["syncCode", "fromAccountId", "toAccountId", "amount"],
      },
      handler: (p: any) => transferFunds(p),
      requiredScopes: ["read", "write", "finance"],
      sensitivity: "critical",
      requiresIdempotency: true,
      requiresHumanApproval: true,
      rateLimitPerMinute: 10,
    },
    {
      name: "scan_receipt",
      description: "Parsea un recibo desde texto o imagen (OCR Tesseract): merchant, total, fecha, ítems clasificados.",
      inputSchema: {
        type: "object",
        properties: {
          text: str("Texto extraído del recibo (o vacío si se manda imagen)"),
          imageBase64: str("Imagen del recibo en base64 (alternativa a text)"),
          categories: { type: "array", description: "Categorías del usuario (opcional)" },
          categoryAliases: { type: "object", description: "Alias aprendidos (opcional)" },
        },
      },
      handler: (p: any) => scanReceipt(p),
      requiredScopes: ["read", "ocr"],
      sensitivity: "low",
      requiresIdempotency: false,
      requiresHumanApproval: false,
      rateLimitPerMinute: 20,
    },
    {
      name: "parse_transfer",
      description: "Parsea una captura de transferencia bancaria a { amount, from, to } usando el motor OCR/aliases.",
      inputSchema: {
        type: "object",
        properties: {
          text: str("Texto de la captura de transferencia"),
          accounts: { type: "array", description: "Cuentas del usuario (opcional)" },
          transferAliases: { type: "object", description: "Alias aprendidos (opcional)" },
        },
        required: ["text"],
      },
      handler: (p: any) => scanTransfer(p),
      requiredScopes: ["read", "ocr"],
      sensitivity: "low",
      requiresIdempotency: false,
      requiresHumanApproval: false,
      rateLimitPerMinute: 20,
    },
    {
      name: "drive_status",
      description: "Estado del pipeline Google Drive → Hermes: procesados, fallidos y errores.",
      inputSchema: { type: "object", properties: {} },
      handler: () => driveStatus(),
      requiredScopes: ["read", "drive"],
      sensitivity: "medium",
      requiresIdempotency: false,
      requiresHumanApproval: false,
      rateLimitPerMinute: 20,
    },
    {
      name: "drive_pending",
      description: "Lista los archivos de imagen pendientes de procesar en la carpeta pública de Drive.",
      inputSchema: { type: "object", properties: {} },
      handler: () => drivePending(),
      requiredScopes: ["read", "drive"],
      sensitivity: "medium",
      requiresIdempotency: false,
      requiresHumanApproval: false,
      rateLimitPerMinute: 20,
    },
    {
      name: "drive_sync",
      description: "Ejecuta un ciclo completo de sync Drive → OCR → transacciones. Requiere aprobación humana.",
      inputSchema: { type: "object", properties: {} },
      handler: () => driveSync(),
      requiredScopes: ["read", "write", "drive"],
      sensitivity: "high",
      requiresIdempotency: true,
      requiresHumanApproval: true,
      rateLimitPerMinute: 5,
      visibleWhen: (scopes: McpScope[]) =>
        scopes.includes("write") && scopes.includes("drive"),
    },
  ];

  for (const tool of tools) registry.register(tool);
  return registry;
}
