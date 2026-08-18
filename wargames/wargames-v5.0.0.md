# 🎮 MCP WARGAMES - MISFINANZSVPS
> **Proyecto**: [misfinanzsvps](https://github.com/oreyes100/misfinanzsvps)
> **Fecha**: 18 de agosto de 2026
> **Stack**: React 19 · Tailwind CSS v4 · Framer Motion · Vite 6 · TypeScript
> **Producción**: https://dineroorganizado.duckdns.org (antes mis-finazas-gold.vercel.app)
> **Versión del documento**: 5.0.1 (reconciliado con estado real de prod por OpenCode)

> **Nota de reconciliación**: esta versión corrige el estado de despliegue del
> documento original v5.0.0. El commit `4de0f19` quedó atrás: tras la ejecución
> del Wargame 8 se desplegaron `a4d16d5` y `971965e`, y el modelo de embeddings
> correcto es `gemini-embedding-001` (no `text-embedding-004`, que no existe en
> la API v1beta de Gemini).

---

## 📑 ÍNDICE

- [Wargame 1: Operación MCP Fortress](#wargame-1-operación-mcp-fortress)
- [Wargame 2: Operación MCP Command Center](#wargame-2-operación-mcp-command-center)
- [Wargame 3: Operación Photo Vault](#wargame-3-operación-photo-vault)
- [Wargame 4: Operación Null Hunter](#wargame-4-operación-null-hunter)
- [Wargame 5: Operación Ghost Pipeline](#wargame-5-operación-ghost-pipeline)
- [Wargame 6: Operación Receipt Vision](#wargame-6-operación-receipt-vision)
- [Wargame 7: Top of Mind (Embeddings + Oro)](#wargame-7-top-of-mind)
- [Wargame 8: Operación Ground Truth (Meta-Wargame)](#wargame-8-operación-ground-truth)
- [Resumen Global](#resumen-global)
- [Plan de Integración Priorizado v5.0](#plan-de-integración-priorizado-v50)
- [Reglas de Engage para Futuros Agentes](#reglas-de-engage-para-futuros-agentes)

---

# 🏰 WARGAME 1: OPERACIÓN MCP FORTRESS
> **HP del Sistema**: 100 · **5 fases** · **Score Final**: 85/100 · **Rango**: ARQUITECTO MCP ÉLITE

| Fase | Ataque | HP sin | HP con |
|---|---|---|---|
| 1 | Capability Negotiation | -20 | -2 |
| 2 | Circuit Breaker + Rate Limiting | -30 | -5 |
| 3 | Retry Backoff + Idempotencia | -25 | -3 |
| 4 | Schema Poisoning (5 capas) | -35 | -4 |
| 5 | State Corruption (WAL + Checkpoints) | -20 | -1 |

**Archivos clave**: `src/mcp/resilience/`, `src/mcp/security/`, `src/mcp/persistence/`

---

# 🖥️ WARGAME 2: OPERACIÓN MCP COMMAND CENTER
> **UX Score**: 100 · **6 fases** · **Score Final**: 89/100 · **Rango**: UX ARCHITECT ELITE

| Fase | Ataque | UX sin | UX con |
|---|---|---|---|
| 1 | Inundación del menú (200 items) | -25 | -3 |
| 2 | Notificación spam | -20 | -2 |
| 3 | Rendimiento 5K items | -25 | -3 |
| 4 | Conflictos de edición | -20 | -2 |
| 5 | Estado desincronizado | -15 | -1 |
| 6 | Accesibilidad WCAG 2.2 | -10 | -0 |

**Acceso MCP**: Bottom Nav 🤖 MCP (primario) + Notificación + Widget Dashboard + Asistente IA

---

# 📷 WARGAME 3: OPERACIÓN PHOTO VAULT
> **Trust Score**: 100 · **6 fases** · **Score Final**: 87/100 · **Rango**: PRIVACY ARCHITECT ELITE

| Fase | Ataque | Trust sin | Trust con |
|---|---|---|---|
| 1 | Acceso excesivo a fotos | -30 | -3 |
| 2 | Detección falsa de recibos | -25 | -3 |
| 3 | Rendimiento 50K fotos | -25 | -3 |
| 4 | Tokens OAuth inseguros | -30 | -2 |
| 5 | UX de selección abrumadora | -15 | -2 |
| 6 | Datos residuales | -10 | -0 |

**Archivos clave**: `src/services/googlePhotos.js`, `receiptDetector.js`, `tokenSecurity.js`

---

# 🔍 WARGAME 4: OPERACIÓN NULL HUNTER
> **Data Quality Score**: 100 · **6 fases** · **Score Final**: 84/100 · **Rango**: DATA QUALITY ARCHITECT ELITE

| Métrica | ANTES | DESPUÉS |
|---|---|---|
| null | 71% | < 2% |
| Otros | 21% | < 10% |
| Categorizadas | 8% | > 88% |

**Archivos clave**: `src/utils/nullCategoryAudit.js`, `categoryGuard.js`, `categoryHealthMonitor.js`

---

# 👻 WARGAME 5: OPERACIÓN GHOST PIPELINE
> **Pipeline Health Score**: 100 · **6 fases** · **Score Final**: 86/100 · **Rango**: PIPELINE SURGEON ELITE

**Problema**: El menú MCP mostraba "🎉 No hay pendientes" pero el pipeline estaba muerto por dentro.
**Solución**: 8 eslabones trazados → store conectado → fuentes cableadas → test E2E → health check automático.

**Estado actual**: ✅ **Pipeline saludable** - 5/5 eslabones OK verificado en prod.

---

# 👁️ WARGAME 6: OPERACIÓN RECEIPT VISION
> **Vision Score**: 100 · **6 fases** · **Score Final**: 90/100 · **Rango**: RECEIPT VISION ARCHITECT ELITE

**Estado actual**: ✅ **DESARROLLADO Y DESPLEGADO** (commits `fab1faa`, `4665215`, `854399c` en main).

**Implementación real en el código**:
- Editor real: `EditPanel` en `McpMenu.jsx` (NO `TransactionEditor.jsx`)
- Transferencias: `counterpartId` + signo de `amount` (NO `type:"transfer"`)
- `src/transfers.js`: `findTransferPair`, `buildTransferPair`, `applyPairBalances`, `editTransferPair`, `convertToTransfer`, `convertFromTransfer`
- `receiptStorage.js` (IndexedDB), `ReceiptPreview.jsx`, `useReceiptImage.js`
- 14 tests en `receiptVision.test.js` (suite verde 369 tests)

---

# 🧠 WARGAME 7: TOP OF MIND (Embeddings + Oro Real)
> **Implementación Score**: 100 · **Estado**: ✅ **DESARROLLADO Y DESPLEGADO** (commit `7beb787` + `52ddc8d`)

## Pendiente A: Categorización Semántica vía Hermes Agent

- **Endpoint**: `POST /api/categorize` en `server/server.mjs`
- **Modelo**: `gemini-embedding-001` (Gemini) vía Hermes agent (Nous Research). `text-embedding-004` NO existe en API v1beta (404) — corregido en `52ddc8d`
- **Algoritmo**: k-NN con cosine similarity
- **Función**: `embedText`/`cosineSimilarity` en `server/hermes/gemini.mjs`
- **Cliente**: `categorizeSemanticAsync` en `src/utils.ts` con fallback a `categorize()` (reglas)
- **UI**: `Modals.jsx` y `McpMenu.jsx` con sugerencia semántica async

## Pendiente B: Precio de Oro Real

- **Fuente**: `https://api.gold-api.com/price/XAU` (USD/onza troy → EUR/gramo)
- **Cliente**: `src/useFX.js` con fetch cada 30 min + `goldUsdPerOzToEurPerGram`
- **Reducer**: `update_fx` acepta `action.goldPriceEUR` (push a `priceHistory.GOLD`)
- **Tests**: `src/useFX.test.js` + bloque en `reducer.test.js`

**Estado en prod**: ✅ `/api/categorize` devuelve `semantic:true` · Bundle contiene `gold-api.com/price/XAU`

---

# 🎯 WARGAME 8: OPERACIÓN GROUND TRUTH (Meta-Wargame)
> **Tipo**: Reconciliación · **Score**: N/A · **Rango**: REALITY CHECK MASTER

## 🚨 Contexto del incidente

Un agente de IA externo generó un script de integración basado en un **modelo equivocado** del proyecto. El script:
- ❌ Creaba `TransactionEditor.jsx` (NO existe en el repo real)
- ❌ Referenciaba `recordId`, `review_item_resolved`, `review_item_dismissed` (NO existen)
- ❌ Usaba `type:"expense"/"income"/"transfer"` (NO existe; el tipo se deriva del signo + `counterpartId`)
- ❌ Corrompió `McpMenu.jsx` y `store.jsx` al intentar aplicar estos símbolos inexistentes

## ✅ Resolución por OpenCode

1. Detección del vocabulario falso
2. Restauración de `McpMenu.jsx` al commit `4de0f19` (estado limpio)
3. Verificación de que el código real está en prod:
   - Bundle: `index-CQVbUyQk.js` (200 OK)
   - Chunk: `McpMenu-BMjglP0n.js` (200 OK)
   - `/api/categorize` → `semantic:true`

## 📋 7 Fases del Meta-Wargame

| Fase | Acción | Criterio de éxito |
|---|---|---|
| 0 | Reconciliación final (`git status`, `grep` de vocabulario) | McpMenu.jsx limpio |
| 1 | Badge `⚠️ Corregir` clickeable (span → button) | Test + deploy |
| 2 | Toggle transferencia en EditPanel | Test de toggle |
| 3 | Recibo visible en EditPanel (`ReceiptThumbnail`) | Thumbnail + viewer |
| 4 | Sugerencia semántica destacada en UI | Badge verde con "Aplicar" |
| 5 | Validación atómica de transferencias (swap b→c) | Test de swap |
| 6 | Deploy + verificación de chunks en prod | Hash prod == hash local |
| 7 | Cierre (commit + push + VPS alineado) | Suite verde + docs |

## ✅ Ejecución registrada

- Fase 1: badge `⚠️ Corregir`/`👁️ Revisar` convertido de `<span>` a `<button>` que
  abre el `EditPanel` (commit `a4d16d5`).
- Fase 2: toggle transferencia YA existía (verificado, sin cambios).
- Fase 3: recibo YA visible con `ReceiptThumbnail`/`ReceiptViewer` (verificado).
- Fase 4: sugerencia semántica ahora es badge verde visible "✨ IA sugiere X (N%
  confianza)" con botón "Aplicar"; antes se aplicaba silenciosamente (commit `a4d16d5`).
- Fase 5: swap atómico YA testado en `receiptVision.test.js` (editTransferPair b→c).
- Fase 6: deploy + verificación de chunks en prod (hash prod == hash local).
- Fase 7: commit `a4d16d5` (feature) + `971965e` (docs) → main; VPS alineado en `971965e`.

## 🎯 Lecciones aprendidas (permanentes)

| # | Lección | Regla para futuros agentes |
|---|---|---|
| 1 | Modelo mental ≠ código real | Verificar vocabulario con `grep` ANTES de editar |
| 2 | Símbolos inventados corrompen código | Nunca usar nombres sin confirmar que existen |
| 3 | `git status` limpio es prerrequisito | Todo cambio parte de baseline verificado |
| 4 | Cada cambio requiere Fase 0 | Reconocimiento → Edición → Verificación |
| 5 | Deploy debe verificar chunks por hash | No confiar solo en build exitoso |

---

# 📊 RESUMEN GLOBAL

## Los 7 Wargames + 1 Meta-Wargame

| # | Wargame | Fases | Score Final | Rango | Estado |
|---|---|---|---|---|---|
| 1 | 🏰 MCP Fortress | 5 | 85/100 HP | MCP ELITE | 📋 Plan |
| 2 | 🖥️ MCP Command Center | 6 | 89/100 UX | UX ELITE | 📋 Plan |
| 3 | 📷 Photo Vault | 6 | 87/100 Trust | PRIVACY ELITE | 📋 Plan |
| 4 | 🔍 Null Hunter | 6 | 84/100 DQ | DQ ELITE | 📋 Plan |
| 5 | 👻 Ghost Pipeline | 6 | 86/100 PH | SURGEON ELITE | ✅ Prod |
| 6 | 👁️ Receipt Vision | 6 | 90/100 VS | VISION ELITE | ✅ Prod |
| 7 | 🧠 Top of Mind | 2 | 100/100 | INTEGRATION ELITE | ✅ Prod |
| 8 | 🎯 Ground Truth | 8 | N/A | REALITY MASTER | ✅ **Ejecutado** |

## Estado de despliegue actual en prod (reconciliado 2026-08-18)

| Componente | Estado | Commit | Chunk |
|---|---|---|---|
| Bundle principal | ✅ OK | `a4d16d5` | `index-CQVbUyQk.js` |
| McpMenu (EditPanel + semántica visible) | ✅ OK | `a4d16d5` | `McpMenu-BMjglP0n.js` |
| `/api/categorize` | ✅ `semantic:true` | `7beb787` + `52ddc8d` | server.mjs |
| `/api/health` | ✅ OK | — | — |
| Oro real (`gold-api.com`) | ✅ Activo | `7beb787` | `index-CQVbUyQk.js` |
| Receipt Vision | ✅ Completo | `854399c` | — |

---

# 📋 PLAN DE INTEGRACIÓN PRIORIZADO v5.0

## ⚠️ REGLA DE ORO (post-Ground Truth)

**CUALQUIER cambio futuro DEBE pasar por la Fase 0 del Wargame 8 antes de implementar**:
1. `git status` limpio
2. `grep` para confirmar símbolos reales
3. Solo entonces: editar → test → build → deploy → verificar hash

## Diagrama de dependencias

```
Wargame 8 (Ground Truth) ← PRERREQUISITO PERMANENTE
        │
        ├──▶ Wargame 1: MCP Fortress (Sprint 2, 5)
        ├──▶ Wargame 2: MCP Command Center (Sprint 1, 3)
        ├──▶ Wargame 3: Photo Vault (Sprint 4)
        ├──▶ Wargame 4: Null Hunter (Sprint 1, 3)
        ├──▶ Wargame 5: Ghost Pipeline ✅ COMPLETADO
        ├──▶ Wargame 6: Receipt Vision ✅ COMPLETADO
        └──▶ Wargame 7: Top of Mind ✅ COMPLETADO
```

## Sprints pendientes

| Sprint | Wargame | Duración | Bloqueado por |
|---|---|---|---|
| Sprint 1 | MCP Command Center + Null Hunter | 2 sem | Fase 0 Ground Truth |
| Sprint 2 | MCP Security Core (Fortress F2-F4) | 2-3 sem | Fase 0 Ground Truth |
| Sprint 3 | Data Quality + Monitoring | 1-2 sem | Sprint 1 |
| Sprint 4 | Google Photos Integration | 2-3 sem | Sprint 1 |
| Sprint 5 | Persistence + Polish | 1-2 sem | Sprint 2 |

---

# 🛡️ REGLAS DE ENGAJE PARA FUTUROS AGENTES

## 🚨 Prohibiciones estrictas

```
1. NO asumir nombres de archivos: verificar con `ls` antes de crear/editar.
2. NO asumir nombres de funciones/variables: verificar con `grep` antes de usar.
3. NO aplicar scripts de otro agente sin reconciliación previa (Fase 0).
4. NO confiar en "el código debería tener X" → SIEMPRE verificar "el código TIENE X".
5. NO editar múltiples archivos sin backup (`cp archivo archivo.bak.$(date +%s)`).
```

## ✅ Checklist obligatorio antes de cada cambio

```bash
# 1. Estado del repo
git status
git log --oneline -3 src/components/[archivo-a-editar]

# 2. Vocabulario real
grep -n "símbolo_esperado" src/components/[archivo-a-editar]
# Si no aparece → el símbolo NO existe → NO usar

# 3. Backup
cp src/components/[archivo] src/components/[archivo].bak.$(date +%s)

# 4. Edición + tests + build + deploy + verificación
```

## 🎯 Símbolos REALES confirmados del proyecto

| Concepto | Símbolo real | NO usar |
|---|---|---|
| Editor de transacciones | `EditPanel` en `McpMenu.jsx` | `TransactionEditor.jsx` |
| Tipo de transacción | Derivado de signo `amount` + `counterpartId` | `type:"expense"/"transfer"` |
| ID de registro | `transaction.id` | `item.recordId` |
| Acciones de review | `review_accept` / `review_dismiss` (sin sufijo `_item_*`) | `review_item_resolved`, etc. |
| Categoría IA semántica | `categorizeSemanticAsync` vía `/api/categorize` (modelo `gemini-embedding-001`) | Reglas por substring |
| Precio del oro | `gold-api.com/price/XAU` en `useFX.js` | Valor fijo `68.4 €/g` |

---

> **Documento generado**: 18 de agosto de 2026
> **Proyecto**: misfinanzsvps
> **Versión**: 5.0.1 (reconciliado)
> **Wargames incluidos**: 7 wargames + 1 meta-wargame (Ground Truth)
> **Estado actual**: Receipt Vision, Ghost Pipeline, Top of Mind y Wargame 8
> desplegados en prod. Repo en `971965e`, VPS alineado.
> **Cambio crítico**: Wargame 8 (Ground Truth) como prerrequisito permanente para
> cualquier cambio futuro + reglas de engage estrictas.
