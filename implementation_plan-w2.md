# Wargame 2 — MCP Command Center (Revisión 2026)

## Verdict
Fases 1-5 ya implementadas y en producción. Solo falta Fase 6 (accesibilidad WCAG 2.2 del dialog) + tests de la Fase 2 (lógica acoplada).

### Fase 0 — Reconocimiento (completado)
| Fase | Estado real | Evidencia |
|------|-------------|-----------|
| 1 · Virtual scroll + paginación | ✅ EXISTE | `useVirtualScroll` (src/hooks/useVirtualScroll.js) usado en McpMenu.jsx:100; batch `PAGE_SIZE` + "Cargar más" (McpMenu.jsx:12,135,383) |
| 2 · Coalescencia notificaciones | ✅ EXISTE (UI) / ⚠️ SIN tests | McpNotification.jsx: DEBOUNCE_MS 5s, coalescencia si visible, supresión `inMcp`, 5/día, 30s min |
| 3 · Cleanup automático | ✅ EXISTE + tests | `cleanupReviewQueue` (review.js:176, 30d/7d/1000cap); `review_cleanup` en boot + setInterval 60min (store.jsx:1146-1147); tests en review.test.js:136 |
| 4 · Optimistic locking | ✅ EXISTE | `isStillPending` + estado `conflict` (McpMenu.jsx:140,482,502-507) |
| 5 · Single source of truth | ✅ EXISTE | McpMenu sin estado propio, lee/dispatchea del store (McpMenu.jsx:34,38) |
| 6 · Accesibilidad WCAG 2.2 | ⚠️ PARCIAL | tabs ARIA + aria-live + labels + useReducedMotion EXISTEN. FALTA: focus trap en EditPanel, tecla Esc, devolución de foco |

### Gaps a implementar (sin duplicar)
1. **Fase 6**: focus trap + Esc + focus return en `EditPanel` (dialog). Cumple WCAG 2.2 2.1.1 (teclado), 2.4.3 (orden de foco), 2.4.7 (focus visible).
2. **Fase 2 · tests**: extraer lógica pura de decisión de notificación a `src/notificationPolicy.js` → testeable (patrón del proyecto: lógica pura, sin jsdom).

### Archivos
- `src/notificationPolicy.js` (NUEVO) — lógica pura de política de notificación
- `src/notificationPolicy.test.js` (NUEVO) — tests
- `src/components/McpNotification.jsx` (EDIT) — usar la política pura
- `src/components/McpMenu.jsx` (EDIT) — EditPanel: focus trap + Esc + focus return

### Fuera de alcance
- server.mjs, nginx (prohibido por el usuario)
- No añadir jsdom/@testing-library (no existe en el proyecto; patrón = lógica pura)

## Commits
Commit único al final: `W2 · MCP Command Center: Fase 6 accesibilidad + tests Fase 2`

## Riesgo
- El focus trap depende de querySelector sobre el dialog; si cambia el DOM interno de EditPanel, puede romperse. Mitigación: focusables filtrados por disabled, fallback a `preventDefault` si no hay elementos.