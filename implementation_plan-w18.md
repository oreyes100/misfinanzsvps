# W18 — Operación Sincronía Total (implementation plan)

**Objetivo**: server = única fuente de verdad; cada cliente reemplaza su estado
local cuando el hash del server difiere del suyo (conservando cambios locales
pendientes via push previo). Elimina la divergencia acumulada por el merge
per-entity (last `_updatedAt` wins) que nunca reemplaza estado stale.

## Causa raíz (Fase 0)
- El pull automático hace `restore` (merge per-entity), nunca reemplaza.
- El push `pushNow` hace GET→merge→POST; el server hace merge-on-write.
  Nada borra ni reemplaza estado divergente; el merge es idempotente-resurrector.
- Tombsones sí se aplican (W17), pero los clientes stale nunca adoptan el resto
  del estado (cuentas/inmuebles editados en cada dispositivo con `_updatedAt`).
- **Dato clave**: `snap.syncVersion >= local._syncVersion` NO converge — el
  local stale ya infló su versión a 250 (≥ server). Se reemplaza por **hash**.

## Cambios (7 archivos)
1. `src/utils.ts` — `SYNCABLE_KEYS`, `stableStringify` (claves ordenadas),
   `syncableSliceOf`, `syncableHash` (SHA-256 vía crypto.subtle).
2. `api/_hash.js` (nuevo) — idénticos helpers server-side (node:crypto).
3. `server/server.mjs` — `GET /api/snapshot` → `{ found, state, hash, syncVersion, updatedAt }`.
4. `api/snapshot.js` (nuevo) — endpoint Vercel equivalente (paridad APK).
5. `src/store.jsx` — `resyncNow()`: snapshot→hash→(push pendiente)→hydrate
   (reemplazo autoritativo, conserva fx/priceHistory/goldPriceEUR locales).
   Pull automático usa `resyncNow`; fallback legacy `/api/sync`+restore.
   Expone `sync.resync()`.
6. `src/components/Settings.jsx` — botón "Re-sincronizar server".
7. `src/hash.test.js` — determinismo, igualdad cliente↔server, exclusión volatile.

## Flujo resync (cliente, al abrir / retry / focus)
```
snap = GET /api/snapshot
if !found → legacy push
if snap.hash === localHash → convergido (nada)
else:
  if dirty (unpushed) → pushNow (merge protegido por tombstones + _updatedAt)
  re-fetch snapshot
  dispatch hydrate({ ...snap.state, fx, priceHistory, goldPriceEUR })  // reemplaza
```

## Seguridad / riesgos
- El push previo es seguro: mergeStates filtran tombstones y las entidades con
  `_updatedAt` viejo (stale) pierden contra el truth.
- `hydrate` no corre `accrueInterest` → no re-crea bulks ni doble devengo.
- Fallback a `/api/sync` si el endpoint snapshot aún no existe (deploy parcial).
- Riesgo residual: entidad editada localmente tras el truth gana en el push
  (legítimo: es un cambio real más reciente).

## Verificación
- `npm test` (402 + nuevos hash tests) y `npm run build`.
- Deploy server.mjs al VPS + resync de los 2 dispositivos; `hash` igual en ambos.