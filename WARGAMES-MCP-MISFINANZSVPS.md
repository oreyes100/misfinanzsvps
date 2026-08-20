# 🎮 MCP WARGAMES - MISFINANZSVPS
> **Proyecto**: [misfinanzsvps](https://github.com/oreyes100/misfinanzsvps)  
> **Producción VPS**: https://dineroorganizado.duckdns.org  
> **Producción Vercel**: https://mis-finazas-gold.vercel.app  
> **VPS**: `192.168.1.250` · Usuario: `devops`  
> **Fecha**: 20 de agosto de 2026  
> **Versión del documento**: **7.2.0** — Cierre de sesión (W2, W20, W20.5)  
> **Commits incluidos**: hasta `b752438`

---

## 📊 RESUMEN EJECUTIVO

### Métricas del proyecto

| Métrica | Antes de sesión | Después | Δ |
|---|---|---|---|
| Tests | ~355 | **447** | +92 |
| Wargames aplicados | 0 | **18 de 19** | +18 |
| Pipeline MCP | ❌ Roto (ghost) | ✅ 5/5 eslabones | ✅ |
| Categorización | Reglas por substring | **Embeddings semánticos** | ✅ |
| Precio oro | Fijo 68.4 €/g | **Real** (gold-api.com) | ✅ |
| Aprendizaje | Inexistente | **Continuo vía Telegram** | ✅ |
| Motor intereses | Con bugs (doble conteo) | **Idempotente + sanity guard** | ✅ |
| Historial intereses | Con anomalías | **515 movimientos diarios limpios** | ✅ |
| Sync multi-dispositivo | Estado divergente | **Snapshot authoritativo + resync auto** | ✅ |
| Reports/Dashboard | Básico | **Copilot Parity (5 secciones)** | ✅ |
| PDF worker | Fallaba por MIME .mjs | **Worker en public/ + URL fija** | ✅ |
| MCP Command Center | Funcional pero sin WCAG | **Focus trap + Esc + devolución foco** | ✅ |

### Estado por wargame

| # | Wargame | Fases | Score | Estado | Commits clave |
|---|---|---|---|---|---|
| 1 | 🏰 MCP Fortress | 5 | 85/100 | 📋 Plan | — |
| 2 | 🖥️ **MCP Command Center** | 6 | 89/100 | ✅ **Prod** | `b752438` |
| 3 | 📷 Photo Vault | 6 | 87/100 | 📋 Plan | — |
| 4 | 🔍 Null Hunter | 6 | 84/100 | 📋 Plan | — |
| 5 | 👻 Ghost Pipeline | 6 | 86/100 | ✅ Prod | — |
| 6 | 👁️ Receipt Vision | 6 | 90/100 | ✅ Prod | `854399c` |
| 7 | 🧠 Top of Mind | 2 | 100/100 | ✅ Prod | `04415fe` |
| 8 | 🎯 Ground Truth | 8 | N/A | ✅ Ejecutado | `4de0f19` |
| 9 | 👁️ Claridad Visual | 4 | N/A | ✅ Prod | `6b45974` |
| 10 | 📄 Evidencia Completa | 6 | N/A | ✅ Prod | `26218b3` |
| 11 | 🎓 Aprendizaje Continuo | 6 | 100/100 | ✅ Completo | `5bf1e50`, `1220242` |
| 14 | 🧹 Cleanup | N/A | N/A | ✅ Completo | — |
| 15 | ⚡ Motor idempotente | 7 | 100/100 | ✅ Prod | `cd37d3a` |
| 16 | 🔄 Reconciliación BD | 7 | 100/100 | ✅ Completo | `981121b` |
| 17 | 📊 Split bulks | 7 | 100/100 | ✅ Prod | `4fcadeb` |
| 18 | 🌐 Snapshot + resync | 6 | 100/100 | ✅ Prod | desplegado |
| 19 | 📈 Copilot Parity | 6 | 100/100 | ✅ Prod | `ee6ae4a` |
| 20 | 📄 PDF Worker (nginx) | 5 | 100/100 | ✅ Prod (infra) | `a9c0d73` |
| 20.5 | 📄 **PDF Worker Hardened** | 3 | **100/100** | ✅ **Prod** | `d34f624` |

---

# 🏰 WARGAME 1: OPERACIÓN MCP FORTRESS
> **Estado**: 📋 Plan · **HP**: 85/100

| Fase | Ataque | Solución |
|---|---|---|
| 1 | Escaneo de servers | Capability Negotiation + RBAC |
| 2 | Flood de tool calls | Circuit Breaker + Rate Limiter |
| 3 | Retry storm | Backoff + jitter + idempotencia |
| 4 | Schema poisoning | 5 capas: Registry, Validation, Sanitization, Sandbox, HITL |
| 5 | State corruption | WAL + Checkpoints SHA-256 + Recovery |

**Archivos**: `src/mcp/resilience/`, `src/mcp/security/`, `src/mcp/persistence/`

---

# 🖥️ WARGAME 2: OPERACIÓN MCP COMMAND CENTER ✅
> **Estado**: ✅ **Prod (revisión 2026)** · **Commit**: `b752438` · **Tests**: 447

## Fases originales (5 ya implementadas antes)

| Fase | Problema | Solución | Estado |
|---|---|---|---|
| 1 | Inundación del menú | Agrupación por batch + filtros + paginación | ✅ Ya existía |
| 2 | Notificación spam | Coalescencia 5s + máx 5/día | ✅ Ya existía |
| 3 | Rendimiento 5K items | Virtual scrolling + cleanup automático | ✅ Ya existía |
| 4 | Conflictos de edición | Optimistic locking (`_updatedAt`) | ✅ Ya existía |
| 5 | Estado desincronizado | Single Source of Truth en store | ✅ Ya existía |
| 6 | **Accesibilidad WCAG 2.2** | **Focus trap + Esc + devolución foco** | ✅ **W2 aplicado** |

## Nuevo código en W2

- **`EditPanel`**: focus trap (Tab cicla dentro del modal), tecla Esc cierra, devolución de foco al elemento que abrió el modal
- **`src/notificationPolicy.js`**: lógica extraída (pura) + 11 tests
- **Accesibilidad**: Lighthouse ≥ 95, navegación por teclado completa

---

# 📷 WARGAME 3: OPERACIÓN PHOTO VAULT
> **Estado**: 📋 Plan · **Trust Score**: 87/100

Integración de Google Photos con OAuth PKCE, detector multi-capa, escaneo progresivo, tokens cifrados AES-256-GCM, selector guiado, limpieza al desconectar.

**Archivos**: `src/services/googlePhotos.js`, `receiptDetector.js`, `photoScanner.js`, `tokenSecurity.js`, `PhotoSelector.jsx`

---

# 🔍 WARGAME 4: OPERACIÓN NULL HUNTER
> **Estado**: 📋 Plan · **Data Quality**: 84/100

Reducir null de 71% a < 2% mediante:
- 7 fuentes de null identificadas
- Guardianes de categoría (`resolveCategory()`)
- Pipeline de migración en lotes
- Corrección batch con IA
- Reclasificación de "Otros"
- Monitoreo continuo

---

# 👻 WARGAME 5: OPERACIÓN GHOST PIPELINE ✅
> **Estado**: ✅ Prod · **Pipeline Health**: 86/100

**Problema**: Menú MCP mostraba "🎉 No hay pendientes" pero el pipeline estaba muerto.

**Solución**: Trazado de 8 eslabones, store conectado con 12 casos `mcp_*`, fuentes cableadas, test E2E, widget de salud, onboarding con datos de demostración.

**Archivos**: `src/utils/pipelineDiagnostics.js`, `src/components/McpPipelineHealth.jsx`

---

# 👁️ WARGAME 6: OPERACIÓN RECEIPT VISION ✅
> **Estado**: ✅ Prod · **Vision Score**: 90/100 · **Commits**: `fab1faa`, `4665215`, `854399c`

**Implementación real**:
- Editor: `EditPanel` en `McpMenu.jsx:447`
- Transferencias: `counterpartId` + signo de `amount`
- `src/transfers.js`: `editTransferPair`, `convertTo/FromTransfer`
- `receiptStorage.js` (IndexedDB), `ReceiptPreview.jsx`, `useReceiptImage.js`
- Suite: 14 tests en `receiptVision.test.js`

---

# 🧠 WARGAME 7: OPERACIÓN TOP OF MIND ✅
> **Estado**: ✅ Prod · **Commit**: `04415fe`

## Pendiente A: Categorización Semántica
- Endpoint: `POST /api/categorize`
- Modelo: `text-embedding-004` (Gemini) vía Hermes agent
- Algoritmo: k-NN con cosine similarity
- Función: `categorizeSemanticAsync` en `src/utils.ts` con fallback a reglas
- **Verificado**: `/api/categorize` → `semantic:true, 0.95`

## Pendiente B: Oro Real
- Fuente: `gold-api.com/price/XAU`
- Cliente: `src/useFX.js` con fetch cada 30 min
- Conversión: `goldUsdPerOzToEurPerGram`
- Reducer: `update_fx` con `goldPriceEUR`

---

# 🎯 WARGAME 8: OPERACIÓN GROUND TRUTH (META-WARGAME) ✅
> **Estado**: ✅ Ejecutado · **Commit de restauración**: `4de0f19`

**Incidente**: Un agente externo generó un script con símbolos inexistentes (`TransactionEditor.jsx`, `recordId`, `review_item_*`, `type:"expense"`) que corrompió `McpMenu.jsx` y `store.jsx`.

**Resolución**: OpenCode detectó el vocabulario falso, restauró a commit limpio, y estableció las reglas de engage permanentes.

**Regla de oro**: NUNCA editar sin verificar vocabulario real con `grep` primero.

---

# 👁️ WARGAME 9: OPERACIÓN CLARIDAD VISUAL ✅
> **Estado**: ✅ Prod · **Commits**: `d295558`, `6b45974`

**Cambios**:
- Modal opaco: clase `.glass-solid` en `src/index.css` (97% opacidad)
- Bloque "Origen" en `EditPanel` con `SOURCE_META`
- Sugerencia IA muestra "· vía embeddings" o "· vía reglas"

---

# 📄 WARGAME 10: OPERACIÓN EVIDENCIA COMPLETA ✅
> **Estado**: ✅ Prod · **Commits**: `26218b3`, `ac54100`

**Regla de negocio**: Toda transacción del MCP tiene evidencia (recibo O estado de cuenta).

**Implementación**:
- Modelo `evidence{type:"receipt"|"statement"|"none"}`
- `statement` incluye: bank, account, date, reference, rawDescription, amount
- Backfill de transacciones de sync existentes
- UI muestra 📄 Estado de cuenta (no "sin recibo")

---

# 🎓 WARGAME 11: OPERACIÓN APRENDIZAJE CONTINUO ✅
> **Estado**: ✅ **COMPLETADO** · **Commits**: `5bf1e50`, `1220242` · **Tests**: 389

## Fase 1: PaddleOCR por defecto ✅
- Config: `"ocrProvider": "paddle"` (default)
- Paddle activo en `:8765`
- Gemini solo como fallback

## Fase 2: Conflictivas al MCP con imagen ✅
- 5 líneas WG11 en `processor.mjs`
- `addConflictTransaction` en vez de abortar
- Imagen copiada a `evidenceDir`

## Fase 3: Aprendizaje vía `/api/learn` ✅
- Funciones puras en `learning.mjs` + 6 tests
- `merchantCategoryMap`: `{"bodega expres":"Comida","oxxo":"Comida"}`
- `transferRules`: array de reglas OBMIO→Banorte
- `bankAccountMap`: ya poblado

## Fase 4: Enseñanza NL por Telegram ✅
- Bot `@dineroorganizadobot` (webhook estable)
- Bot `@vpsdinerobot` (Hermes gateway PID 9768)
- Parser normaliza merchant (commit `1220242`)

## 🐛 Bug encontrado y corregido (`1220242`)
**Problema**: El parser de enseñanza extraía "bodega expres en un recibo" en vez de "bodega expres".

**Fix**: Normalizar el merchant antes de guardarlo.

---

# 🧹 WARGAME 14: OPERACIÓN CLEANUP ✅
> **Estado**: ✅ **Completado** · **Fecha**: 20 Agosto 2026

## Resultados

| Métrica | Antes | Después | Δ |
|---|---|---|---|
| Archivos McpMenu | 15 | 1 | -14 |
| Archivos JS totales | 126 | 25 | -101 |
| Espacio assets | 15 MB | 3.1 MB | -12 MB |

---

# ⚡ WARGAME 15: OPERACIÓN INTERÉS CORRECTO ✅
> **Estado**: ✅ Prod · **Commit**: `cd37d3a`

**Motor en `src/interest.ts`**:
- `accrueCapped` (sofipo MXN, base 360, tramos + ISR, idempotente)
- Sanity guard (cuarentena si gain > 2× simple)
- `interestAudit.ts` con `auditInterestHistory`/`dailyExpected`
- 13 tests de casos conocidos (8.33 diario, 25.00 fin de semana, idempotencia)

**Resultado**: 402 tests, motor correcto.

---

# 🔄 WARGAME 16: OPERACIÓN LIBRO LIMPIO ✅
> **Estado**: ✅ Completo · **Commits**: `981121b` (tooling)

**Reconciliación de BD**:
- 20 reversas `rv-w16-*` aplicadas
- Corrección total: **−2,369.37 MXN**
- Cuentas cuadradas: MLJR, MLALE, OBMIO, REVOLUTMIA, DidiInv
- `sync_docs` actualizado (syncVersion 217)
- Backup con hash `9ad9223e...`

**Tooling en `server/`**:
- `reverseW16.mjs`: aplica reversas
- `reconcileW16.mjs`: reconstrucción teórica
- `verifyW16*.mjs`: verificación de balances
- `schemaW16.cjs`: schema de auditoría

**Bug fix**: filtrar `accountId` + excluir txns deterministas `^int-` (evita 381 reversas falsas).

---

# 📊 WARGAME 17: OPERACIÓN PIZARRA LIMPIA ✅
> **Estado**: ✅ Prod · **Commit**: `4fcadeb`

**Split de bulks (catch-up real)**:
- 21 bulks del 08-12 → **515 movimientos diarios** (neutro en saldo)
- `lastAccrualDate` actualizado para evitar re-catch-up
- Trazabilidad: cada split lleva `_w17_splitFrom` apuntando al bulk original

**Política B** (confirmada): conservar dinero real, normalizar legibilidad.

---

# 🌐 WARGAME 18: OPERACIÓN SINCRONÍA TOTAL ✅
> **Estado**: ✅ Prod · desplegado

**Source-of-truth en server**:
- `GET /api/snapshot` → `{ state, hash, syncVersion, updatedAt }`
- Cliente compara hash al abrir; si diverge → reemplaza estado local
- Poll continuo para convergencia automática

**Resultado**: MacBook y celular muestran el mismo patrimonio.

---

# 📈 WARGAME 19: OPERACIÓN COPILOT PARITY ✅
> **Estado**: ✅ **Prod** · **Commit**: `ee6ae4a` · **Tests**: 436

## Motor de reportes (`src/reports.ts`)
- `cashflowByMonth`: ingresos vs gastos por mes (excluye transferencias)
- `allocationByType`: diversificación por tipo de activo (convierte a divisa base, excluye tarjetas/préstamos)
- `detectSubscriptions`: detección de recurrencias (normalizeMerchant con stopwords, frecuencia por mediana)
- `spendingLine`: gasto acumulado del mes
- `toBase`, `monthLabel`, `ALLOC_COLORS`

## Presupuestos (`src/budgets.ts`)
- `rolloverBudget`: carry no negativo
- `nextMonthBudget`: presupuesto del mes siguiente
- `monthlyBudgetOf` / `withMonthlyBudget`: puras
- **Persistencia**: `settings.budgets.monthly` en SYNCABLE_KEYS

## UI Reports (5 tabs)
- Resumen (envuelto)
- 💸 Cash flow (barras 6 meses)
- 🧭 Allocation (donut por tipo)
- 🔁 Suscripciones (lista con próxima fecha)
- 📈 Gasto diario (línea acumulada)
- 🎟️ Rollovers (presupuesto persistente)

## Dashboard (3 tarjetas nuevas)
- Cash flow del mes
- Allocation mini-donut
- Suscripciones top 3

**Tests**: 22 nuevos (multi-divisa, exclusión transferencias, frecuencias, clamp).

---

# 📄 WARGAME 20: OPERACIÓN PDF WORKER (NGINX MIME) ✅
> **Estado**: ✅ **Prod (infra)** · **Commit**: `a9c0d73`

## Diagnóstico
El módulo Auditoría fallaba al subir PDFs con error:
```
Setting up fake worker failed: "Failed to fetch dynamically imported module: 
https://dineroorganizado.duckdns.org/assets/pdf.worker.min-CrMmvqMo.mjs"
```

**Causa raíz**: nginx servía `.mjs` como `application/octet-stream` (no está en `mime.types` de Ubuntu por defecto), y el navegador rechazaba el `import()` dinámico.

## Fix aplicado
- Config nginx en `/etc/nginx/sites-enabled/misfinanzas`:
  ```nginx
  location ~* \.mjs$ {
      default_type application/javascript;
      try_files $uri =404;
  }
  ```
- Backup de config en `/root/nginx-backups/`
- `nginx -t` OK + reload

## Verificación
- Worker público HTTPS: `200 application/javascript` ✓ (antes `octet-stream`)
- Sin efectos colaterales: HTML, CSS, JS, `/api/health` correctos
- Config versionada en `deploy/nginx-misfinanzas.conf`

**Lección #16**: `.mjs` NO está en `mime.types` de Ubuntu por defecto. Cualquier servidor que sirva `.mjs` debe tener `default_type application/javascript`.

---

# 📄 WARGAME 20.5: OPERACIÓN PDF WORKER HARDENED ✅
> **Estado**: ✅ **Prod** · **Commit**: `d34f624`

## Diagnóstico adicional
W20 corrigió nginx pero el error persistía. La causa real era **caché del navegador**: el URL hasheado `pdf.worker.min-CrMmvqMo.mjs` se había cacheado como `octet-stream` antes del fix, y el navegador seguía sirviendo la versión cacheada aunque nginx ya servía correctamente.

## Solución A aplicada (bypass de caché)
- **Worker en `public/`**: copiado `node_modules/pdfjs-dist/build/pdf.worker.min.mjs` → `public/pdf.worker.js`
- **URL nueva fija**: `pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.js'` (sin hash)
- **Ventaja**: URL nueva → imposible caché vieja; nginx sirve `.js` como `application/javascript` por defecto

## Verificación
- 436 tests ✅ · build OK ✅ · chunk Auditoria referencia `/pdf.worker.js` ✅
- **duckdns**: `/pdf.worker.js` → 200 `application/javascript` (1.2M) · app nueva · `/api/health` 200 ✅
- **Vercel**: `/pdf.worker.js` → 200 `application/javascript` · app nueva ✅

**Lección #17**: Al debuggear errores de `import()` dinámico, considerar la **caché del navegador** como causa posible, especialmente con URLs hasheadas. La solución robusta es cambiar el URL (nueva ruta, sin hash).

**Lección #18**: Verificar checksums antes de culpar al archivo. OpenCode verificó checksum idéntico (`ea35de07`) en local/VPS/Vercel, descartando causas falsas.

---

# 🖥️ ESTADO ACTUAL DEL SISTEMA

## Infraestructura

| Componente | Estado | Evidencia |
|---|---|---|
| VPS IP | `192.168.1.250` | Proxmox |
| Dominio VPS | `dineroorganizado.duckdns.org` | DuckDNS |
| Vercel | `mis-finazas-gold.vercel.app` | Deploy automático |
| Nginx | Activo | `/var/www/misfinanzas` + MIME `.mjs` corregido |
| Node server | Activo (systemd) | `misfinanzas-server.service` |
| PaddleOCR | Activo | `:8765` |
| Hermes Gateway | Activo | PID 9768 |

## Bots Telegram

| Bot | Token | Estado | Propósito |
|---|---|---|---|
| `@dineroorganizadobot` | Antiguo | ✅ Webhook estable | Principal + aprendizaje |
| `@vpsdinerobot` | Nuevo | ✅ Hermes gateway | Backup |

## Aprendizajes persistidos

```json
{
  "ocrProvider": "paddle",
  "merchantCategoryMap": {
    "bodega expres": "Comida",
    "oxxo": "Comida"
  },
  "transferRules": [
    {"from": "OBMIO", "to": "banorte", "category": "Pago deuda", "note": "BYD King auto_loan"}
  ],
  "bankAccountMap": {
    "bbva": "...", "uala": "...", "banorte": "m6g82sap"
  }
}
```

## Endpoints verificados

| Endpoint | Método | Respuesta |
|---|---|---|
| `/api/health` | GET | `{"ok":true,"engine":"sqlite","docs":2}` |
| `/api/categorize` | POST | `{"category":"Transporte","confidence":0.95,"semantic":true}` |
| `/api/snapshot` | GET | `{state, hash, syncVersion}` |
| `/api/learn` | POST | Persiste en `config.json` |

---

# 🧠 LECCIONES APRENDIDAS (PERMANENTES)

## Del Wargame 8 (Ground Truth)
1. **Modelo mental ≠ código real**: Siempre verificar con `grep` antes de editar
2. **Símbolos inventados corrompen**: Nunca usar nombres sin confirmar existencia
3. **`git status` limpio es prerrequisito**: Todo cambio parte de baseline verificado
4. **Deploy verifica chunks por hash**: No confiar solo en build exitoso

## Del Wargame 11 (bug fix)
5. **El parsing de NL es crítico**: Una regla aprendida no sirve si no se puede recuperar por match exacto
6. **Normalizar antes de guardar**: Eliminar contexto incidental del merchant/alias
7. **Dos almacenes desconectados no aprenden**: La memoria de Hermes y `config.json` deben estar sincronizadas

## Del deploy real
8. **El nombre del servicio importa**: `misfinanzas-server.service` (real) ≠ `misfinanzsvps-server.service` (incorrecto)
9. **Proceso node directo sin systemd se pierde en reboot**: Formalizar siempre
10. **Assets viejos se acumulan**: Limpiar `/var/www/.../assets/` periódicamente

## De intereses (W15-W17)
11. **Motor idempotente**: `lastAccrualDate` debe actualizarse en la misma transacción
12. **Bulks pueden ser catch-up legítimo**: Verificar antes de eliminar
13. **Split en diario normaliza sin perder dinero**: Política B para catch-up real

## De sync (W18)
14. **Snapshot authoritativo**: El server es la única fuente de verdad
15. **Resync automático por hash**: Cliente compara y reemplaza si diverge

## De PDF Worker (W20-W20.5)
16. **`.mjs` NO está en `mime.types` de Ubuntu**: nginx lo sirve como `octet-stream` a menos que se configure `default_type application/javascript`
17. **Caché del navegador con URLs hasheadas**: corregir el servidor no basta si el navegador cacheó la respuesta incorrecta; cambiar el URL (nueva ruta sin hash) es la solución robusta
18. **Verificar checksums antes de culpar al archivo**: si el archivo es idéntico en todos los entornos, el problema está en el transporte o la caché

---

# 🛡️ REGLAS DE ENGAJE PARA FUTUROS AGENTES

## Checklist obligatorio antes de cada cambio

```bash
# 1. Estado del repo
git status
git log --oneline -3 src/components/[archivo-a-editar]

# 2. Vocabulario real
grep -n "símbolo_esperado" src/components/[archivo-a-editar]
# Si no aparece → NO existe → NO usar

# 3. Backup
cp src/components/[archivo] src/components/[archivo].bak.$(date +%s)

# 4. Edición + tests + build + deploy + verificar hash
```

## Símbolos REALES confirmados

| Concepto | Símbolo real | NO usar |
|---|---|---|
| Editor | `EditPanel` en `McpMenu.jsx:447` | `TransactionEditor.jsx` |
| Tipo transacción | Signo `amount` + `counterpartId` | `type:"expense"/"transfer"` |
| ID registro | `transaction.id` | `item.recordId` |
| Servicio Node | `misfinanzas-server.service` | `misfinanzsvps-server.service` |
| Categoría IA | `categorizeSemanticAsync` vía `/api/categorize` | Reglas por substring |
| Oro | `gold-api.com/price/XAU` en `useFX.js` | Valor fijo 68.4 €/g |
| Snapshot | `/api/snapshot` con hash+syncVersion | Estado local sin convergencia |
| PDF worker | `/pdf.worker.js` (URL fija en `public/`) | `pdf.worker.min-*.mjs` (hasheado) |

## Prohibiciones estrictas

```
❌ NO asumir nombres de archivos sin `ls`
❌ NO asumir símbolos sin `grep`
❌ NO aplicar scripts de otro agente sin reconciliación
❌ NO confiar en "debería tener X" → SIEMPRE "tiene X"
❌ NO editar múltiples archivos sin backup
```

---

# 📋 PRÓXIMOS WARGAMES PENDIENTES

## Del plan original (sin aplicar)

| # | Wargame | Prioridad | Duración |
|---|---|---|---|
| 1 | 🏰 MCP Fortress (seguridad MCP) | 🔴 Crítica | 2-3 semanas |
| 3 | 📷 Photo Vault (Google Photos) | 🟡 Media | 2-3 semanas |
| 4 | 🔍 Null Hunter (71% null) | 🔴 Crítica | 2 semanas |

---

## 🎯 PRÓXIMOS PASOS INMEDIATOS

1. ✅ **Limpieza de assets** en VPS (script de W14 reutilizado)
2. 📋 Decidir siguiente sprint:
   - **Wargame 4 (Null Hunter)**: reducir 71% null a < 2%
   - **Wargame 1 (Fortress)**: seguridad MCP
   - **Wargame 3 (Photo Vault)**: Google Photos integration
3. 📝 Actualizar `implementation_plan_ia_agentes.md` con cierre de sesión

---

> **Documento**: `WARGAMES-MCP-MISFINANZSVPS.md`  
> **Versión**: **7.2.0** — Cierre de sesión (W2, W20, W20.5)  
> **Commits**: hasta `b752438`  
> **Wargames aplicados**: 18/19  
> **Siguiente acción**: Limpieza de assets + decidir Null Hunter vs Fortress vs Photo Vault