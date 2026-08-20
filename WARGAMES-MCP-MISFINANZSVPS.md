# 🎮 MCP WARGAMES - MISFINANZSVPS
> **Proyecto**: [misfinanzsvps](https://github.com/oreyes100/misfinanzsvps)  
> **Producción VPS**: https://dineroorganizado.duckdns.org  
> **Producción Vercel**: https://mis-finazas-gold.vercel.app  
> **VPS**: `192.168.1.250` · Usuario: `devops`  
> **Fecha**: 20 de agosto de 2026  
> **Versión del documento**: **7.5.0** — Plan original COMPLETADO (21/21 wargames)  
> **Commits incluidos**: hasta `a0b3301`

---

## 📊 RESUMEN EJECUTIVO

### Métricas finales

| Métrica | Valor |
|---|---|
| **Wargames aplicados** | **21 de 21** (100%) ✅ |
| **Tests** | **502** passing |
| **Pipeline MCP** | 6/6 eslabones OK |
| **Null%** | 0.6% (<2% objetivo) |
| **Otros%** | 1.8% (<5% objetivo) |
| **Deploy** | VPS + Vercel ✅ |

### Estado por wargame (orden de aplicación en esta sesión)

| # | Wargame | Commit | Estado |
|---|---|---|---|
| 15 | ⚡ Motor idempotente | `cd37d3a` | ✅ Prod |
| 16 | 🔄 Reconciliación BD | `981121b` | ✅ Completo |
| 17 | 📊 Split bulks | `4fcadeb` | ✅ Prod |
| 18 | 🌐 Snapshot + resync | desplegado | ✅ Prod |
| 19 | 📈 Copilot Parity | `ee6ae4a` | ✅ Prod |
| 20 | 📄 PDF Worker (nginx) | `a9c0d73` | ✅ Prod (infra) |
| 20.5 | 📄 PDF Worker Hardened | `d34f624` | ✅ Prod |
| 2 | 🖥️ MCP Command Center (rev 2026) | `b752438` | ✅ Prod |
| 1 | 🏰 MCP Fortress | `31c45ca`, `a5f8483` | ✅ Prod |
| 4 | 🔍 Null Hunter | `a71d6da` | ✅ Prod |
| 3 | 📷 Photo Vault | `a0b3301` | ✅ Prod |

---

# 🏰 WARGAME 1: OPERACIÓN MCP FORTRESS ✅
> **Estado**: ✅ **Prod** · **Commits**: `31c45ca`, `a5f8483` · **Tests**: 472

## Fases implementadas

| Fase | Entrega | Estado |
|---|---|---|
| 1 | Auth+RBAC | `/api/learn` y `/api/telegram` con token; `/api/categorize` sin auth (cliente no lo envía) |
| 2 | Rate limit + circuit breaker | 30 req/min categorize/learn; Gemini fallback tras 3 fallos |
| 3 | Retry + idempotencia | Backoff exponencial; dedup de `update_id` y reglas aprendidas |
| 4 | Schema validation | text≤500, categories≤50; 400 en inputs inválidos |
| 5 | WAL + backups | journal_mode=wal; backup diario 7d; integrity_check 24h |

## Archivos nuevos

- `server/auth.mjs`: `checkLearnAuth` (Bearer token)
- `server/ratelimit.mjs`: `makeRateLimiter` + `checkWindow`
- `server/circuit.mjs`: `makeCircuitBreaker` (CLOSED→OPEN)
- `server/retry.mjs`: `retryWithBackoff` + `getRetryDelay`
- `server/idempotency.mjs`: `makeUpdateIdStore` + `learnDedupKey`
- `server/validate.mjs`: `validateCategorizePayload` + `validateLearnPayload`

## Decisión crítica (Fase 1)

**`/api/categorize` y `/api/snapshot` sin auth** porque el cliente no envía `Authorization`. Protegidos con rate limiting (30/60 req/min) en su lugar. Auth reservada para endpoints sensibles (`/api/learn`, `/api/telegram`).

## Lección #19 (permanente)

En reverse proxy (nginx), Node ve `127.0.0.1` como IP origen. NUNCA usar IP para decisiones de auth — usar solo tokens/headers firmados.

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

# 📷 WARGAME 3: OPERACIÓN PHOTO VAULT ✅
> **Estado**: ✅ **Prod** · **Commit**: `a0b3301` · **Tests**: 502

## Fases implementadas

| Fase | Entrega | Estado |
|---|---|---|
| 0 | Reconocimiento | PKCE ya existía pero client-side (violaba spec) |
| 1 | OAuth PKCE server-side | `/api/google-token` intercambia code+verifier en server, nunca en bundle |
| 2 | Detector multi-capa | `scoreReceiptCandidate` con ratio h/w + filename hints |
| 3 | Escaneo progresivo | `scanForReceipts` con paginado 100/página + timeBudget + onProgress |
| 4 | Tokens cifrados | AES-256-GCM PBKDF2 100k en localStorage (fuera de syncableSlice) |
| 5 | Selector guiado | `PhotoSelector` con vista previa + filtros |
| 6 | Limpieza al desconectar | Revoca acceso + borra tokens + blobs |

## Archivos clave

- `server/googleToken.mjs`: endpoint `/api/google-token` + `/api/google-config`
- `src/services/googlePhotos.js`: `startAuth` → `/api/google-token` (no directo a Google)
- `src/services/receiptDetector.js`: `scoreReceiptCandidate` + `isLikelyReceipt`
- `src/services/tokenSecurity.js`: `encryptTokens` AES-256-GCM

## Lección #21 (permanente)

**Nunca intercambiar code por tokens en el cliente.** El flujo PKCE completo debe ocurrir en el servidor (`/api/google-token`), donde el client secret está protegido. El cliente solo recibe el access token ya intercambiado.

## Decisión de diseño

**Reuso de `GOOGLE_CLIENT_ID`** de Drive (no duplicar env). Scope = `photoslibrary.readonly` únicamente.

---

# 🔍 WARGAME 4: OPERACIÓN NULL HUNTER ✅
> **Estado**: ✅ **Prod** · **Commit**: `a71d6da` · **Tests**: 493

## Baseline real (Fase 0)

| Métrica | Estimado | Real |
|---|---|---|
| Null% | 71% | **0.6%** (7 de 1,238 tx) |
| Otros% | 21% | **1.8%** (22 tx) |
| Categorizadas | 8% | **97.6%** (1,209 tx) |

## Fases implementadas

| Fase | Entrega | Estado |
|---|---|---|
| 1 | Guardianes de categoría | `resolveCategory` con fallback a "Otros"; `ensureCategory` en reducer |
| 2 | Migración en lotes | `migrateNullCategories` lotes de 100 + pausa 1s (no bloquea) |
| 3 | Reclasificación de "Otros" | `analyzeOthers` agrupa por merchant, count≥3, sugiere categoría |
| 4 | Monitoreo continuo | `categoryHealth` en Dashboard + eslabón en McpPipelineHealth |

## Archivos nuevos

- `src/categoryGuard.ts`: `resolveCategory` + `ensureCategory`
- `src/nullMigrator.ts`: `migrateNullCategories` con onProgress
- `src/othersAnalyzer.ts`: `analyzeOthers` + `normMerchant`

## Lección #20 (permanente)

**Nunca confiar en estimaciones de porcentaje sin verificar con datos reales.** Ejecutar queries de baseline antes de diseñar migraciones masivas.

---

# 🧠 LECCIONES APRENDIDAS (21 PERMANENTES)

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

## De Fortress (W1)
19. **NUNCA usar IP para auth en reverse proxy**: Node ve `127.0.0.1` como IP origen; usar solo tokens/headers firmados

## De Null Hunter (W4)
20. **Verificar baseline real antes de migraciones masivas**: ejecutar queries de baseline antes de diseñar migraciones

## De Photo Vault (W3)
21. **OAuth PKCE server-side**: nunca intercambiar code por tokens en el cliente; el exchange ocurre en `/api/google-token` donde el client secret está protegido

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
| Google OAuth | `/api/google-token` (server-side) | Exchange directo en cliente |

## Prohibiciones estrictas

```
❌ NO asumir nombres de archivos sin `ls`
❌ NO asumir símbolos sin `grep`
❌ NO aplicar scripts de otro agente sin reconciliación
❌ NO confiar en "debería tener X" → SIEMPRE "tiene X"
❌ NO editar múltiples archivos sin backup
❌ NO intercambiar OAuth tokens en cliente
❌ NO usar IP para auth en reverse proxy
```

---

# 📋 PRÓXIMOS PASOS (POST-PLAN ORIGINAL)

El plan original está **100% completado**. Opciones para futuras sesiones:

## Opción 1: Mantenimiento
- Monitoreo continuo de `categoryHealth` y `pipelineHealth`
- Limpieza periódica de assets en `/var/www/misfinanzas/assets/`
- Actualización de dependencias (React, Vite, pdfjs-dist)
- Backups y disaster recovery drills

## Opción 2: Features nuevas
- **Exportación de datos**: CSV/Excel/PDF de transacciones y reportes
- **Predicción de gastos**: ML para predecir gastos futuros basado en patrones
- **Integración con más bancos**: Plaid API para sync automático
- **Multi-usuario**: soporte para familias/parejas con cuentas compartidas
- **Alertas inteligentes**: notificaciones proactivas de gastos inusuales

## Opción 3: Optimización
- **Code splitting**: lazy loading de Reports, Auditoría, Settings
- **Bundle size**: reducir de 624KB a <300KB con manual chunks
- **Performance**: virtual scrolling en todas las listas grandes
- **PWA**: service worker + offline mode

## Opción 4: Documentación
- **Guías de usuario**: tutoriales para features principales
- **API docs**: OpenAPI/Swagger para endpoints
- **Arquitectura técnica**: diagramas de flujo, decisiones de diseño
- **Runbooks**: procedimientos de deploy, rollback, troubleshooting

---

# 🎯 LOGRO HISTÓRICO

**21 de 21 wargames completados** con:
- ✅ 502 tests pasando
- ✅ VPS + Vercel en producción estable
- ✅ Defensa en profundidad (seguridad + calidad + sync + UX + IA + privacidad)
- ✅ 21 lecciones aprendidas documentadas
- ✅ Reglas de engage para futuros agentes

**El proyecto está listo para producción con calidad enterprise.**

---

> **Documento**: `WARGAMES-MCP-MISFINANZSVPS.md`  
> **Versión**: **7.5.0** — Plan original COMPLETADO (21/21 wargames)  
> **Commits**: hasta `a0b3301`  
> **Tests**: 502 passing  
> **Estado**: 100% completado · Producción estable · Listo para mantenimiento/features nuevas
