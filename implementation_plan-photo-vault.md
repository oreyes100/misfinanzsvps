# Plan: MCP Command Center — Menú de revisión + notificación de contador

## Problema
El HITL vive en `Assistant.jsx` como un preview inline efímero (`pending`):
se aprueba o descarta en el momento y no queda rastro ni cola. Cuando el MCP
procesa muchos items (OCR/IA), no hay una superficie de revisión persistente,
ni notificación no-invasiva, ni manejo de listas largas, ni protección contra
editar datos stale.

## Decisión de arquitectura (aprobada por el usuario)
- **La cola de revisión es STAGING**: el Command Center absorbe el HITL de
  Assistant. `analyze()` encola un item pendiente con su acción; aprobar/corregir/
  descartar se hace desde el menú MCP. La cola NO es post-hoc.
- **Single source of truth** (fase 5): la cola vive en `store.jsx`; el menú
  solo lee y dispatchea. Correcciones = `add_transaction`/`update_transaction` +
  `review_accept` → Dashboard/Charts se actualizan solos.
- `reviewQueue` es local (no entra en `syncableSlice`, no viaja a la nube).

## Modelo de datos
```js
reviewQueue: { pending: ReviewItem[], resolved: ReviewItem[], dismissed: ReviewItem[] }

ReviewItem = {
  id, batchId, source,            // source: "assistant" | "ocr" | "ai" | "manual"
  classification,                 // "needs_fix" | "needs_review" | "auto_ok"
  confidence, createdAt,          // 0..1
  action,                         // acción staged a dispatchear (add_transaction/transfer/…)
  preview: { description, amount, currency, date, category, categoryId, accountId, subcategory },
  resolvedAt?, dismissedAt?
}
```

## Cambios
| Archivo | Cambio |
|---|---|
| `src/review.js` (NUEVO) | Lógica pura: `classifyConfidence(c)`, `enqueueItem`, `acceptItem`, `dismissItem`, `acceptAllReviewable`, `dismissAll`, `cleanupReviewQueue` (resolved>30d, dismissed>7d), `buildStagedAction(intent, account)` |
| `src/store.jsx` | `SEED.reviewQueue`; reducer cases `review_enqueue`, `review_accept`, `review_dismiss`, `review_accept_all`, `review_dismiss_all`, `review_cleanup`; efecto de cleanup al montar; `reviewQueue` ya queda durable vía `durableSnapshot` |
| `src/hooks/useVirtualScroll.js` (NUEVO) | Hook de virtual scrolling (fase 3): itemHeight, overscan, containerHeight; calcula `visibleRange`/`offsetY`/`totalHeight` |
| `src/components/McpMenu.jsx` (NUEVO) | Command Center: tabs Pendientes/Resueltas/Descartadas, filtros (severidad/fuente/fecha/cuenta), ordenación, agrupación por batch, paginación + virtual scroll en listas largas, acciones batch, `EditPanel` con optimistic locking (fase 4), WCAG (tabs/focus/aria-live) (fase 6) |
| `src/components/McpNotification.jsx` (NUEVO) | Notificación coalescente (fase 2): debounce 5s, contador acumula sin re-animar, auto-close 5s, suprime si tab==="mcp", máx 5/día (localStorage), solo badge si se excede. Exporta `McpNavBadge` |
| `src/components/BottomNav.jsx` | Nuevo tab `mcp` con `McpNavBadge` (cuenta de pending), respeta `canAccess` |
| `src/App.jsx` | `VIEWS.mcp → McpMenu` (lazy), render `McpNotification` con `tab`/`setTab` |
| `src/components/Assistant.jsx` | `analyze()` encola `review_enqueue` (staged) en vez de `setPending`; mensaje dirige al Command Center; se elimina preview inline approve/reject (absorbido por la cola) |
| `src/__tests__/review-queue.test.js` (NUEVO) | Tests `.js` de `review.js`: clasificación, encolado/dedupe, aceptar/descartar (moves), accept_all (solo needs_review), cleanup por antigüedad |

## Fases del wargame → diseño
| Fase | Mitigación | Dónde |
|---|---|---|
| 1 Inundación | Agrupación por batch + filtros + paginación | `McpMenu.jsx` |
| 2 Notificación spam | Debounce 5s + coalescencia + límite 5/día + supresión contextual | `McpNotification.jsx` |
| 3 Rendimiento | Virtual scroll (20 nodos) + cleanup auto | `useVirtualScroll.js` + `review_cleanup` |
| 4 Conflictos | Optimistic locking (`_updatedAt` / item removido) + modal Sobrescribir/Recargar | `McpMenu.jsx` EditPanel |
| 5 Consistencia | SSOT vía store + dispatch | `store.jsx` + McpMenu sin estado duplicado |
| 6 Accesibilidad | tabs/focus/aria-live/reduced-motion/labels | `McpMenu.jsx` + `McpNotification.jsx` |

## Decisiones de adaptación al codebase
- `canAccess(session, "mcp")`: admin y `sections === "all"` lo ven por defecto;
  usuarios con `sections` explícitas necesitan `"mcp"` en su lista.
- Design system: usar tokens existentes (`glass`, `text-ink-dim`, `text-accent-soft`,
  `bg-accent/20`, `pressable`, `Btn/Glass/Money/Field`) — NO Tailwind genérico.
- Assistant pierde el approve/reject inline; el historial de log (`mis-finazas-assistant-log`)
  se mantiene.
- `reviewQueue` no entra en `syncableSlice` (local-only, sin churn de nube).

## Verificación
1. `npx vitest run src/__tests__/review-queue.test.js`
2. `npm test` (sin regresiones)
3. `npx tsc --noEmit` (0 errores en archivos tocados; los 33 preexistentes de reducer.ts/utils.ts quedan igual)
4. `npm run build`
5. Smoke manual: Assistant encola → badge/notificación → aceptar/corregir/descartar → Dashboard refleja el cambio.