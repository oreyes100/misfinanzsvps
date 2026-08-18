# Plan — OPERACIÓN GHOST PIPELINE (adaptado al diagnóstico real)

> Fecha: 2026-08-17 · Estado: **✅ COMPLETADO y desplegado** (commit `a6b91dd`, prod `index-gj2nFZcE.js`)
> Repo: `oreyes100/misfinanzsvps` · Rama: `main` (HEAD `a6b91dd`)

## 1. Diagnóstico verificado (Context-First, previo a código)

El wargame afirma eslabones 2-6 rotos. La verificación contra el codebase
(`store.jsx`, `review.js`, `McpMenu.jsx`, `McpNotification.jsx`, `Dashboard.jsx`,
`categoryGuard.mjs`) **refuta parcialmente el diagnóstico** (patrón ya visto en NULL HUNTER):

| Eslabón (wargame) | Realidad | Veredicto |
|---|---|---|
| 1. reviewQueue no está en SEED | `store.jsx:85` `reviewQueue: { pending: [], resolved: [], dismissed: [] }` | ✅ SANO |
| 2. reducer no maneja `mcp_*`/`review_*` | 6 casos activos: enqueue/accept/dismiss/accept_all/dismiss_all/cleanup (`store.jsx:501-517`) | ✅ SANO (parcial) |
| 3. fuentes no dispatchean | Assistant (analyze→enqueue), PhotoSelector (OCR→enqueue), voz→analyze() | ✅ SANO (2 fuentes activas) |
| 4. UI no muestra cola | McpMenu lee `reviewQueue.pending`, ReviewRow, tabs | ✅ SANO |
| 5. badge inexistente | McpNotification badge pendingCount | ✅ SANO |
| — `mcp_record` / `mcp_batch` (telemetría) | **0 ocurrencias en reducer** | 🔴 **ROTO** |
| — Auto-captura de sin-categoría/confianza baja | Server manda `_categoryConfidence` + `needsCategoryReview` (`apply.mjs:42`, `categoryGuard.mjs`), pero el **frontend nunca los convierte en items de revisión** | 🔴 **EL GHOST REAL** |
| — Diagnóstico de eslabones | No existe ninguna utilidad de health del pipeline | 🔴 **FALTA** |
| — Onboarding / primera vista | Menú vacío sin señal de qué hace | 🔴 **FALTA** |

**Conclusión**: el pipeline NO está muerto; está *silencioso*. La cola, el reducer y
las fuentes existen, pero (a) no hay auto-captura de transacciones con categoría
fallback/ausente/confianza baja que llegan vía sync (aunque el server las marca), y
(b) no hay telemetría ni visibilidad de que el pipeline funciona.

## 2. Alcance (plan adaptado — 6 fases)

Todas las fases se adaptan al esquema real (`category: string`, `reviewQueue` existente,
`_categoryConfidence`/`needsCategoryReview` del server). **No se duplica** cola/reducer/UI.

### GP-01 — `src/utils/pipelineDiagnostics.js` (nuevo)
- `diagnosePipeline(state)` → `{ eslabones: [{id, label, ok, detail}], health: "ok"|"degraded" }`
- Eslabones reales: (1) SEED.reviewQueue existe, (2) reducer maneja `review_enqueue`,
  (3) ≥1 fuente activa detectable (queue no vacía alguna vez), (4) UI McpMenu montada,
  (5) badge, (6) telemetría `mcp_record` soportada, (7) auto-captura activa, (8) syncableSlice incluye reviewQueue.
- Pura, sin side-effects, testeable.
- Test: `src/pipelineDiagnostics.test.js`.

### GP-02 — Auto-captura de revisión (el fix core)
- `src/review.js`: nuevo helper puro `buildUnreviewedItems(txs, { accounts })` →
  por cada tx con `category` vacía/null, `needsCategoryReview === true`, o
  `_categoryConfidence < 0.8` (y no `auto: true` sin categoría), genera item de revisión
  con `id: "unreviewed-"+tx.id` (dedupe por `enqueueItem`), `source: "sync"`,
  `classification` vía `classifyConfidence(confidence)`.
- `src/store.jsx`:
  - En `case "restore"`: tras `mergeByID`, correr `buildUnreviewedItems` sobre `mergedTxs`
    y encolar los items (idempotente por id).
  - En `case "add_transaction"`: si `tx.category` resulta fallback/ausente, encolar item
    de revisión para el tx recién creado (mismo `unreviewed-` prefix).
- Test: `src/pipelineE2E.test.js` (restore con txs sin categoría → pending crece; aceptar → resolved).

### GP-03 — Telemetría `mcp_record` / `mcp_batch`
- SEED: `pipelineEvents: []` (cap ~200, se trunca en `mcp_batch`/`mcp_record`).
- Reducer: `case "mcp_record"` (evento único `{ts, source, kind, detail}`) y
  `case "mcp_batch"` (array de eventos). Se unen al frente, cap 200.
- `syncableSlice`: **no** incluir `pipelineEvents` (son volátiles, no viajan al merge).
- McpMenu: sección "Actividad del pipeline" (últimos 10 eventos, icono por source).
- Assistant.jsx / PhotoSelector.jsx: disparan `mcp_record` junto a `review_enqueue`.
- Test: `src/pipelineDiagnostics.test.js` (mcp_record/batch truncado, orden).

### GP-04 — Test E2E del pipeline
- `src/pipelineE2E.test.js`:
  - restore(SEED + txs sin categoría) → pending con items `unreviewed-*`.
  - acceptItem → resolved, desaparece de pending.
  - add_transaction fallback → se encola item de revisión.
  - dedupe: restore repetido no duplica items.

### GP-05 — Widget de salud del pipeline (McpPipelineHealth)
- `src/components/McpPipelineHealth.jsx` (nuevo, ligero, sin lazy-load — es pequeño):
  - Render de `diagnosePipeline(state)` como checklist de 8 eslabones.
  - Botón "Reparar" → dispatchea `pipeline_recheck` (fuerza re-ejecución de auto-captura)
    y re-diagnostica.
- Integración: dentro de McpMenu (tab o cabecera colapsable).
- Reusa `categoryHealth()` existente como detalle.

### GP-06 — Onboarding / señal de vida
- McpMenu: si `pendingCounts.total === 0` y nunca hubo actividad, mostrar banner
  "El pipeline está listo — pide al asistente o escanea un comprobante para verlo en acción"
  con botón de demo no destructivo (encola item de ejemplo con `source: "demo"`).
- `pipeline_demo` case en reducer (item prefabricado, marcado `demo: true`).

## 3. Archivos

| Archivo | Tipo | Fase |
|---|---|---|
| `src/utils/pipelineDiagnostics.js` | nuevo | GP-01 |
| `src/pipelineDiagnostics.test.js` | nuevo | GP-01/03 |
| `src/review.js` | editar (+`buildUnreviewedItems`) | GP-02 |
| `src/store.jsx` | editar (restore, add_transaction, mcp_record/batch, pipeline_demo, pipelineEvents, pipeline_recheck) | GP-02/03/06 |
| `src/pipelineE2E.test.js` | nuevo | GP-04 |
| `src/components/McpPipelineHealth.jsx` | nuevo | GP-05 |
| `src/components/McpMenu.jsx` | editar (widget + actividad + onboarding) | GP-05/06 |
| `src/components/Assistant.jsx` | editar (mcp_record) | GP-03 |
| `src/components/PhotoSelector.jsx` | editar (mcp_record) | GP-03 |

## 4. Verificación
- `npm test` (≈334 actuales + nuevos) → 100% verde.
- `npm run build` → exitoso.
- Deploy a `/var/www/misfinanzas/` (nginx) + `chown www-data`.
- Push a `main`, alinear VPS, deploy confirmado.

## 5. Riesgos
- Riesgo: auto-captura genere ruido si muchas txs legacy sin categoría → mitigado por
  dedupe por id + umbral 0.8 + solo pendientes (nunca re-encola resueltas).
- Riesgo: `restore` con mucha cola → cap de pending al encolar (máx. N items por batch).
- Riesgo: tocar `store.jsx` sin lint → ejecutar `vault_lint.py` + build antes de commit.