# Plan: FASE 4 — MCP-04 Cortafuegos de Semántica

## Problema
Un MCP server comprometido (o un cliente malicioso) puede:
1. Enviar schemas envenenados (schema poisoning) para inyectar parámetros.
2. Colar SQL/command/prompt injection vía strings de herramientas.
3. Ejecutar sin límite de tiempo/recursos.
4. Ejecutar acciones financieras sin aprobación humana auditable.

## Cambios
| Archivo | Cambio |
|---|---|
| `src/mcp/security/security-types.ts` | Tipos: validación, registry, sandbox, HITL, supply chain, eventos. Reusa `SensitivityLevel` (minúsculas) de capability-types |
| `src/mcp/security/schema-validator.ts` | Validación JSON Schema + patrones de inyección + límites; `valid = errors.length === 0` |
| `src/mcp/security/schema-registry.ts` | Registry con SHA-256 (canonical JSON) + firma Ed25519 reales (`node:crypto`) |
| `src/mcp/security/sandbox.ts` | Timeout con cleanup de timer, allowlist de red, límites tamaño/profundidad |
| `src/mcp/security/human-in-the-loop.ts` | Gate HITL: umbral HIGH, 2FA CRITICAL, firma SHA-256, audit log, `destroy()` |
| `src/mcp/security/security-orchestrator.ts` | Flujo 5 pasos: supply chain → validación → tamaño/profundidad → HITL → sandbox |
| `src/mcp/security-integration.ts` | `createSecurityOrchestrator()` + schemas reales (real-tools.ts) + `runToolWithSecurity` (sin datos mock) |
| `src/mcp/security/__tests__/schema-poisoning.test.js` | Simulación Red Team (JS, sin TS) |
| `src/mcp/server.ts` | Handler envuelto: `runToolWithSecurity(security, tool, args, ctx, inner=runToolWithRetry)` |

## Decisiones de adaptación (vs propuesta)
- **Sin enums ni parameter properties**: `as const`/unions y campos explícitos (Node strip-only).
- **Crypto real** (`node:crypto`): sha256 + Ed25519, no hashes simplificados.
- **Schemas registrados = inputSchemas reales** (real-tools.ts), no inventados; `get_balance` usa `syncCode`, no `accountId`.
- **Sin wrappers mock** (`secureTransfer`/`secureOcrScan`/`secureDriveRead`): integración envuelve handlers reales vía `runToolWithSecurity`; sin datos simulados en producción.
- **Sanitización no escapa strings**: la validación ya RECHAZA inyecciones (fatal → bloqueado); escapar corrompería descripciones almacenadas. Sanitizar = filtrar propiedades declaradas conservando valores.
- **Timeout de sandbox por tool** desde `SchemaPermissions.maxExecutionTimeMs` (drive_sync=200s; global 30s por defecto). Memoria = presupuesto declarativo (aislamiento real requeriría worker_threads, fuera de MVP, documentado).
- **HITL en servidor stdio**: auth layer ya emite PENDING_APPROVAL antes (e2e intacto); el gate de seguridad es defensa en profundidad con `onApprovalRequired → false` (sin UI). El gate se ejercita por tests y por integración frontend futura.
- **Tests en `.js`** sin sintaxis TS (Vitest solo incluye `*.test.{js,jsx}`).

## Verificación
`npm test` (238 + nuevos) + `npx tsc --noEmit` (0 errores en src/mcp) + `npm run build` + `node src/mcp/server.ts` (strip-only OK).