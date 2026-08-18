# Plan: OPERACIÓN NULL HUNTER (adaptado al esquema real)

> **Plan First** (CLAUDE.md): >3 archivos → plan obligatorio. El wargame original
> asumía un esquema `categoryId` que NO existe en el codebase. Este plan reescribe
> las 6 fases al esquema real: `Transaction.category: string` + `DEFAULT_CATEGORIES`
> con keywords.

## Diagnóstico verificado (DB SQLite VPS, sync `mf-60ec529050f44bfab1`)

- 618 transacciones, **50 null = 8.1%** (no 71% como asumía el wargame).
- Las 50 null son **100% auto=1** con notes "Ingresado por Hermes desde estado
  de cuenta" / "Detectado en auditoría del extracto".
- **Causa raíz única**: `local.mjs parseStatement()` fija `category: null`;
  `processor.mjs:212` y `review.mjs:119/56` insertan `category: m.category || null`
  sin fallback; `apply.mjs:34` `category: t.category || null`.
- El frontend ya está blindado: `categorize()` nunca devuelve null (fallback
  "Otros"), `transfer`→"Transferencia", `accrue`→"Intereses", `delete_category`→
  reasigna "Otros". **Las 7 fuentes del wargame son en su mayoría falsas.**
- El Dashboard cuenta `byCat[t.category]` (Reports.jsx:84): null aparece como
  categoría "null", inflando meses con pocas txs.

## Alcance (adaptación de las 6 fases)

| Fase | Wargame | Adaptación real |
|---|---|---|
| 1 Autopsia | 7 fuentes | ✅ 1 fuente (ingesta Hermes) — ya diagnosticada |
| 2 Guardianes | categoryId obligatorio | Categorizar en el server: `categoryGuard` con keywords |
| 3 Migración | 200→MCP batch | Backfill de los 50 null en la DB |
| 4 Corrección batch MCP | UI en McpMenu | Reusar review queue existente (McpMenu ya tiene batch) |
| 5 Descomponer "Otros" | reclasificar | Re-categorizar por keywords en backfill |
| 6 Monitoreo | widget DQ | Selector de salud de categorías + alerta |

## Cambios

### Server (VPS, `server/hermes/`) — Fases 2, 3, 5
| Archivo | Cambio |
|---|---|
| `categoryGuard.mjs` (NUEVO) | `resolveCategory(desc, amount, fallback)` con las keywords de `DEFAULT_CATEGORIES` (port a Node): devuelve `{ category, confidence, source }`. Sin categoría → "Otros" + flag `needsCategoryReview`. |
| `apply.mjs` | `addTransaction`: `category: t.category || resolveCategory(t.description).category` |
| `processor.mjs` | `handleStatement`: `category: m.category || resolveCategory(m.description).category` |
| `review.mjs` | `reviewStatement` (56) y `reviewStatementLocal` (119): idem |
| `backfill-null-categories.mjs` (NUEVO, script 1×) | Lee DB, para cada tx null aplica `resolveCategory` y `UPDATE transactions SET category=?, extra_json=...` + actualiza `state_json` en `sync_docs` con `_syncVersion+1` |

### Frontend — Fases 4, 6
| Archivo | Cambio |
|---|---|
| `src/selectors.js` | NUEVO selector `categoryHealth(state)`: `{ nullCount, nullPct, otrosPct, categorizedPct, alerts[] }` excluyendo "Transferencia" y auto-ingesta sin categoría (report parity con Reports.jsx) |
| `src/components/Dashboard.jsx` | Widget compacto "Calidad de categorías" (solo admin/owner): null% + otros% + alerta si null>5% o otros>10%. Reusa tokens `glass`/`text-accent-soft`. |
| `src/components/McpMenu.jsx` | Al expandir batch con items `needsCategory`, sugerencia de categoría por keywords + botón "Aplicar a N" (reusa `review_batch_fix_applied` si existe; si no, dispatch `update_transaction` por item) |

### Tests
| Archivo | Cambio |
|---|---|
| `src/__tests__/categoryHealth.test.js` (NUEVO) | Selector: cálculo de null%/otros%, exclusión de Transferencia, umbrales de alerta |
| `server/hermes/categoryGuard.test.mjs` (NUEVO) | `resolveCategory`: keywords hit, fallback "Otros", transferencia, ingreso |

## Reglas / decisiones
- El server NO tiene acceso a `state.categories` (vacío en la DB) → `categoryGuard`
  embebe las keywords de `DEFAULT_CATEGORIES` (port manual, mismo orden).
- Backfill es **idempotente**: solo toca txs con `category IS NULL OR '' OR 'null'`,
  guarda `_categorySource` y `_categoryConfidence` en `extra_json`.
- El reporte Dashboard no cambia su lógica (las txs ya llevarán categoría).
- No se crea categoría "Transferencia" duplicada; las transferencias del server
  ya llevan esa categoría (apply.mjs:64).
- Sync: backfill escribe directo en SQLite (source of truth server) → el cliente
  pull verá el estado actualizado vía sync normal.

## Verificación
1. `npm test` (frontend, 329+nuevos)
2. Backfill en VPS: correr script, re-auditar DB → null = 0
3. `npm run build` (frontend) antes de push
4. Deploy: `sudo cp -r dist/* /var/www/misfinanzas/`
5. Push a GitHub (merge tras sync local←remote)

## Riesgo
- Backfill toca el estado vivo en SQLite: se hace con backup previo
  (`cp misfinanzas.db misfinanzas.db.bak-null-hunter`) y WAL checkpoint.