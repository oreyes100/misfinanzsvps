# W4 Null Hunter — Plan
## Fase 0 — Recon (20 Ago 2026)
- VPS state (mf-60ec…): 1238 tx, 7 null (0.6%), 22 Otros (1.8%), 17 cats (Comida…Donaciones), salud `categoryHealth` ok/critical=5% ya integrado.
- Local grep: `resolveCategory` no existe, solo `categorize` (utils.ts:141) substring + `categorizeSemanticAsync` (utils.ts:160) activo y usado en Modals/McpMenu.
- `DEFAULT_CATEGORIES` 13 + 4 custom (Carbohidratos, Comer fuera, Donaciones, Personales).
- Dashboard.jsx ya tiene `CategoryHealthCard` (health.ok/warning/critical) — Fase 4 base lista.
- McpPipelineHealth sin eslabón de categorías.
- Objetivo <2% null ya cumplido, pero guardianes y pipeline preventivo faltan.

## Entregas
| Fase | Módulo | Criterio |
|---|---|---|
| 1 | `src/categoryGuard.ts` resolveCategory(description, amount, cats, semantic?) → id/null, `ensureCategory` que nunca devuelve null si existe "Otros" | Test: "Uber"→Transporte, vacía→Otros, nueva tx add_transaction sin categoría → asigna Otros. Integrar en `reducer.ts` add_transaction/update_transaction |
| 2 | `src/nullMigrator.ts` migrateNullCategories(txs,cats,{batchSize=100, concurrent=3, pauseMs=1000, resolver}) sin bloquear UI (async lotes, progreso callback) | Test: 250 nulls → 3 lotes, progreso 100/250…; mock resolver; no bloquea event loop |
| 3 | `src/othersAnalyzer.ts` analyzeOthers(txs) agrupa por merchant normalizado, sugiere categoría via categorize() | Test: 3× "OXXO" en Otros → sugiere Supermercado |
| 4 | Monitoreo: `selectors.categoryHealth` ya existe; añadir eslabón "Categorías" en `McpPipelineHealth.jsx` (null% <2% ok) y confirmar Dashboard card visible | Dashboard muestra 0.6%/1.8% verde, Pipeline 5/5 ok |

## Archivos
- NUEVO: src/categoryGuard.ts, src/nullMigrator.ts, src/othersAnalyzer.ts + tests src/categoryGuard.test.js etc.
- EDIT: src/utils.ts (re-export), src/reducer.ts (guardian), src/components/McpPipelineHealth.jsx (eslabón), src/utils/pipelineDiagnostics.js (si existe)
- No tocar server.mjs/nginx.

## Riesgo
- Resolver a "Otros" por defecto podría ocultar errores reales → mitigado con health alert warning si null>0 y otros>10%.
