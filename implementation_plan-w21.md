# W21 Convergencia Permanente — Plan
## Fase 0 — Recon (20 Ago 2026)
- Resync hoy: `store.jsx:853 resyncNow` (snapshot hash compare, push pending, hydrate), trigger `useEffect [syncRetry,syncId]` + `focus/visibilitychange` (`store.jsx:994`) + `5min interval` (`store.jsx:1005`). No `online`/`pageshow`, poll congelado en background.
- SEED en `store.jsx:43` y `reducer.ts:20` sin `_isDemo`; loadInitial `store.jsx:766` retorna SEED si no raw; merge `store.jsx:542 mergeByID` conserva demo si _updatedAt fresco → C3/C4.
- Snapshot `server/server.mjs:537` → `{hash, syncVersion, state}`; no existe `/api/sync-version`.
- Merge por `_updatedAt` + `stripDemoAccounts` parcial, pero no descarta SEED completo.

## Fases
| Fase | Entrega | Criterio |
|---|---|---|
| 1 | Marcado `_isDemo`+`_demoSeededAt` en SEED; reducer limpia `_isDemo` al primer dato real; `resyncNow` reemplaza demo incondicional | demo+server real → reemplazo auto |
| 2 | Resync por `focus`+`visibilitychange`+`online`+`pageshow` (4 eventos) | volver de background/reconexión → resync sin recargar |
| 3 | `GET /api/sync-version` → `{syncVersion,hash}` ligero; heartbeat 60s `if version≠ → resyncNow` | convergencia ≤60s, sin descargar state |
| 4 | `src/syncHealth.ts` `diagnoseDivergence` + `lastResync` en localStorage + UI Ajustes→Sync | Ajustes muestra motivo `local_is_demo` etc |

## Archivos
- EDIT: `src/reducer.ts` (SEED _isDemo, limpiar en mutaciones), `src/store.jsx` (eventos, heartbeat, auto-repair, telemetry), `server/server.mjs` (endpoint sync-version)
- NUEVO: `src/syncHealth.ts` + tests
- No romper merge real (_updatedAt).

## Riesgo
- Demo auto-reemplazo podría borrar datos reales si _isDemo mal marcado → mitigado: solo si local `_isDemo===true` y snapshot no demo.
