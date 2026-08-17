# Plan: FASE 5 — MCP-05 Fortaleza de Datos

## Problema
El estado vive en `localStorage` (`mis-finazas-v1`). Un fallo de escritura a
mitad, una extensión maliciosa o un parseo defectuoso pueden corromper el JSON
en silencio: `load()` cae directo a `SEED` y el usuario pierde todo. No hay
Write-Ahead Log, ni checkpoints, ni rollback, ni export/import de emergencia.

## Cambios
| Archivo | Cambio |
|---|---|
| `src/mcp/persistence/persistence-types.ts` | Tipos (WalEntry, Checkpoint, RecoveryResult, ExportBundle, PersistenceConfig), almacenamiento KV (`memory`/`localStorage` + guard Node), hash FNV-1a + `stableStringify` (checksums deterministas) |
| `src/mcp/persistence/write-ahead-log.ts` | `WriteAheadLog`: append sync O(1) con checksum encadenado, flush (timer o inmediato), verify con detección de rango dañado, compact(upToSeq), `destroy()` |
| `src/mcp/persistence/checkpoint-manager.ts` | `CheckpointManager`: save/loadLatest/loadAll/isValid con historial acotado (`maxHistory`) |
| `src/mcp/persistence/recovery-manager.ts` | `RecoveryManager.recoverOnLoad`: checkpoint válido → replay WAL posterior; checkpoint dañado → reconstruir desde WAL; WAL dañado → rollback al checkpoint; `maxToleratedDamage` → SEED; auto-heal con nuevo checkpoint + compact |
| `src/mcp/persistence/export-import.ts` | `ExportImport`: exportState → `{ format, version, timestamp, checksum, signature?, data }`; importState verifica checksum y firma (HMAC-SHA256 vía WebCrypto, async) |
| `src/mcp/persistence/persistence-orchestrator.ts` | `PersistenceOrchestrator`: `recordStateMutation` (dedupe por versión), `recordMutation` (audit server), `maybeCheckpoint` (cada N mutaciones o intervalo), `rollbackTo`, `recoverStateOnLoad`, export/import, `destroy()` |
| `src/mcp/persistence-integration.ts` | Config `MISFINANZAS_PERSISTENCE_CONFIG`, factory `createPersistenceOrchestrator()`, `runToolWithPersistence` (registra mutaciones reales de tools mutadoras en el servidor) |
| `src/mcp/persistence/__tests__/state-corruption.test.js` | Red Team (JS, sin TS): ~20 escenarios de corrupción |
| `src/mcp/server.ts` | Crear `persistence` por instancia, envolver tools mutadoras con `runToolWithPersistence`, destruir en onclose, exponer en el retorno |
| `src/store.jsx` | `load()`: ante error de parseo, `recoverStateOnLoad(SEED)` en vez de SEED ciego; efecto que observa `_syncVersion` y llama `recordStateMutation` + `maybeCheckpoint` tras cada commit; flush en beforeunload |
| `src/migrations.ts` | Sin cambios funcionales: `migrate()` ya propaga errores (el fallback a SEED vive en `load()`; se intercepta ahí con recovery) |

## Decisiones de adaptación (vs propuesta)
- **Sin enums ni parameter properties**: unions/`as const` y campos explícitos (Node strip-only).
- **Hash FNV-1a 32-bit (sync) para checksums**: store.jsx corre en navegador donde `node:crypto` no existe y WebCrypto es async (rompería el append sync del reducer). La propuesta lo permite explícitamente ("Hash simplificado no criptográfico"). Es integridad/corrupción, no defensa criptográfica.
- **Firma real en export/import**: HMAC-SHA256 vía `crypto.subtle` (async, disponible en navegador y Node 26). Clave configurable (Settings); sin clave → solo checksum (documentado).
- **WAL con hash encadenado (`prev`)**: detecta entradas borradas/reordenadas en medio, no solo el byte modificado.
- **`maybeCheckpoint` compacta al seq capturado en el checkpoint** (no a `getLastSeq()` del momento): evita descartar entradas posteriores al checkpoint.
- **`recordStateMutation` NO va dentro del reducer**: React doble-invoca reducers en StrictMode (WAL duplicado). Se registra en un efecto que observa `state._syncVersion` (que solo cambia en mutaciones reales; `update_fx`/`accrue`/`hydrate` no lo incrementan).
- **`runToolWithPersistence`** registra las mutaciones REALES de `add_transaction`/`transfer_funds`/`drive_sync` al servidor (audit trail en WAL), sin datos mock. `recordMutation` usa versión audit interna (no `_syncVersion`).
- **server.ts**: la persistencia del servidor es audit (memoria en Node vía guard `process.version`); la recuperación completa de estado es responsabilidad del cliente (store.jsx, localStorage real).
- **Tests en `.js`** sin sintaxis TS (Vitest solo incluye `*.test.{js,jsx}`).

## Verificación
`npm test` (271 + ~20 nuevos) + `npx tsc --noEmit` (0 errores en src/mcp) + `npm run build` (store.jsx importa persistencia browser-safe) + `node src/mcp/server.ts` (strip-only OK, con `destroy()` de timers en onclose).