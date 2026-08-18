# Plan — IA de clasificación por cuenta (Drive/Photos) + Agente Telegram

> **Estado**: ✅ Implementado y desplegado (2026-08-17). El plan original contemplaba
> un webhook en Vercel; la implementación real derivó a un motor local en el VPS
> (Hermes + MCP). Ver "Lo realizado" abajo.

## Objetivo

1. **Clasificar un conjunto de imágenes** (recibos, capturas de banco, comprobantes
   de transferencia) que viven en una carpeta de **Google Drive** o **Google Photos**,
   y determinar **en qué cuenta** se debe registrar cada transacción.
2. **Agente por bot de Telegram**: alguien manda una foto de recibo al bot y este
   propone la transacción (descripción, fecha, importe, categoría, cuenta) con botones
   **✅ Registrar / ❌ Descartar**; solo se asienta tras aprobación (ver
   `BOT-TELEGRAM-CUENTAS.md`, patrón del módulo Cuentas).

## ⚠️ Desviación de arquitectura (aprobada en sesión 2026-08-17)

El plan original apuntaba a webhook de Telegram contra Vercel Functions. **No se
siguió** por un conflicto de plataforma: la app usa el mismo bot para el agente
Hermes (polling) y un webhook no puede coexistir con polling con el mismo token.
Decisión final:

| Dimensión | Plan original | Implementado |
|---|---|---|
| Dónde vive el bot | Webhook en Vercel (`api/telegram.js`) | Agente **Hermes en el VPS** (polling `getUpdates`) |
| Cómo entran las fotos | Mensaje privado al bot | **Grupo de Telegram** (privacy mode OFF para recibir fotos de grupo) |
| Pipeline de ingesta | Serverless (Blob) | **Motor local**: OCR Paddle (`127.0.0.1:8765`) + `local.mjs` + SQLite |
| Superficie HITL | Botones ✅/❌ en Telegram | Revisión humana vía **MCP Command Center** (cola review) |
| Herramienta de IA | Clasificación serverless | Tool MCP `image_process_local` expuesta al agente |

## Arquitectura

- App 100% frontend (React/Vite) + Vercel Functions + Vercel Blob (patrón de
  `api/sync.js` y `api/users.js`). CORS restringido vía `ALLOWED_ORIGINS`.
- La **nube es keyed por syncCode** (UUID). El estado vive en `sync/{id}.json`.
  - El importador *propone*; la aplicación la hace el cliente (los saldos se
    ajustan localmente y el sync existente sube el resultado).
  - El bot de Telegram sí debe escribir server-side contra `sync/{id}.json`
    (no hay navegador), replicando la lógica de `add_transaction` del reducer.

## Piezas nuevas (archivos)

### Server (`api/`)
| Archivo | Responsabilidad |
|---|---|
| `lib/blob-json.js` | readJSON/writeJSON privados sobre Vercel Blob |
| `lib/cors.js` | CORS idéntico a sync.js (origin allowlist) |
| `lib/accounts.js` | Normalización + resolución de cuentas por pista (banco, *dígitos) |
| `lib/ai.js` | Motor IA multi-proveedor (gemini / openai / anthropic) para imágenes + post-proceso a cuentas |
| `lib/state-store.js` | load/update estado sync + `addProposedTransactions` (balance-aware) |
| `api/google-import.js` | POST: lista imágenes (Drive pública / Drive API / Photos API), clasifica por lotes, guarda batch en Blob; GET: leer batch |
| `api/google-auth.js` | OAuth2 Google (Drive/Photos): generación de URL, callback de intercambio de tokens, guardado seguro por syncCode |
| `api/telegram.js` | Webhook del bot: mensaje foto/PDF → propuesta + teclado ✅/❌; callback_query → aprobar/descartar |
| `api/telegram-config.js` | Vincular chat↔syncCode+token; mensaje de prueba; registrar webhook |

### Frontend (`src/`)
| Archivo | Responsabilidad |
|---|---|
| `src/ai.js` | Metadata de proveedores IA + helpers (key/modelo por proveedor) |
| `src/components/IaImport.jsx` | Vista de importación: link Google Drive/Photos → revisar propuestas (cuenta, categoría, confianza) → registrar |
| `src/components/TelegramAgent.jsx` | Configuración del bot en Ajustes (token, chat id, sync code, webhook, prueba) |
| `src/components/Settings.jsx` | (edición) Motor de IA multi-proveedor + tarjeta TelegramAgent |
| `src/App.jsx` | (edición) Vista `importar` |
| `src/auth.js` | (edición) sección `importar` en ALL_SECTIONS |
| `src/components/BottomNav.jsx` | (edición) pestaña de importación IA |

### Docs
- `SETUP-IA-AGENTES.md` — procedimiento completo (BotFather, chat id, webhook,
  Google Cloud para Drive/Photos, comparativa de proveedores IA).
- `Wiki/IA-Importacion-Cuentas.md`, `Wiki/Bot-Telegram.md`, actualizar `MOCs/MOC-Mis-Finanzas.md`.

## Alternativas de IA (a documentar en la UI y el README)

| Proveedor | Coste | Visión | Por qué |
|---|---|---|---|
| Google Gemini (`gemini-2.5-flash`) | Gratis gratis (free tier) | ✅ | Ya integrada, clave existente en la app |
| OpenAI `gpt-4o-mini` | Pago por uso, barato | ✅ | Excelente JSON estructurado |
| Anthropic Claude Haiku | Pago por uso | ✅ | Robusto con documentos con ruido/manuscritos |
| Mindee | Prueba gratis, luego pago | (OCR recibos) | Especializada en líneas de tickets (ya referenciada en Cuentas) |
| Tesseract.js (local) | Gratis | ❌ solo OCR | Fallback sin nube (ya en la app) |

## Restricciones

- Los endpoints leen/escriben SOLO Blobs bajo prefijos propios (`ai-batches/`,
  `google-tokens/`, `telegram/`), nunca fuera.
- La clave IA **nunca se loguea**; se pasa por body (conexiones de un solo
  dispositivo) o por env `GEMINI_API_KEY`/`OPENAI_API_KEY`/`ANTHROPIC_API_KEY`.
- El webhook de Telegram exige `X-Telegram-Bot-Api-Secret-Token` (secreto por chat
  o env) y solo actúa sobre el chat vinculado con `enabled=true`.
- Aprobación humana obligatoria (bot y UI): nunca se asienta sin confirmación.
- Imágenes: solo `image/*` y PDF; límite ~6–8 MB por archivo.
- `npm test` antes de commit y `npm run build` antes de push (CLAUDE.md).

## ✅ Lo realizado (sesión 2026-08-17, commit `7ff33b7`)

### Canal de ingesta — Telegram → Hermes (VPS)
| Item | Detalle |
|---|---|
| **Privacy mode OFF** | BotFather `/setprivacy` → `can_read_all_group_messages: True` (el bot ahora ve las fotos del grupo). Antes el privacy mode ON impedía recibirlas. |
| **Polling (no webhook)** | El bot lo usa el agente Hermes con `getUpdates`; coexiste con el webhook de la app sin conflicto de token. |
| **Allowlist** | `~/.hermes/.env`: `TELEGRAM_GROUP_ALLOWED_CHATS=-4332174599` y `TELEGRAM_ALLOWED_USERS=6858669597`. |
| **Instrucción del agente** | `~/.hermes/SOUL.md`: cuando llega una foto al grupo, el agente debe procesarla como recibo y registrar la transacción. |
| **Diagnóstico revertido** | `adapter.py` restaurado limpio (0 `traceback.print_exc`) desde `adapter.py.bak-diag`. |
| **Gateway reiniciado** | Proceso Hermes recargado; conecta limpiamente al nuevo allowlist. |

### Tool MCP `image_process_local` (`server/hermes/drive-mcp.mjs`)
- Exponía 4 tools; ahora **5** (verify con `--help`).
- `imageProcessLocal(imagePath, sourceBase)`: imagen local → `processImage()`
  (OCR Paddle `127.0.0.1:8765` → parseo) → transacciones → journal `telegram_image_processed`.

### Fix parser de transferencias (`server/hermes/local.mjs`)
- `valueBelowLabel(labelIdx, threshold=120)`: cuando la etiqueta ("Cuenta origen")
  y el valor ("CTA **8298") están en líneas separadas, captura el valor por
  proximidad de `y` en vez de quedarse con la etiqueta.
- Evita capturar etiquetas de monto/referencia/folio/clave como valores de cuenta.

### Git + deploy
- `npm test` (329) y `npm run build` OK.
- Merge `main` (Photo Vault + MCP Command Center) en `master`: resolvió conflictos
  en `drive-mcp.mjs`, `local.mjs`, `config.json.example`, `server/package.json`
  (conservando ambos lados: tool MCP nuevo + retry/backoff de ingesta).
- Push a GitHub vía SSH (deploy key `vps-demo-n2` en `oreyes100/misfinanzsvps`):
  `e82306b..7ff33b7 master -> main`.
- Producción: `sudo cp -r dist/* /var/www/misfinanzas/` → HTTPS
  `https://dineroorganizado.duckdns.org/` sirve `index-WZbYTpJT.js`; `server.mjs`
  (PID 783) activo; nginx OK.
- `.gitignore`: `server/mis-finazas-respaldo-*.json`.

### Pendiente / hallazgo (no bug)
- Comprobantes Banorte de transferencia no resuelven cuenta: el recibo dice
  "Banorte Digital mía" que **no existe** como cuenta en Mis Finanzas →
  `processImage` devuelve error de transferencia no resuelta (revisión humana
  esperada). Opciones: crear la cuenta o mapearla en `bankAccountMap`.

---

## ✅ OPERACIÓN NULL HUNTER (2026-08-17, commits `0c10ee3` + `c7ebbde`)

Eliminó las transacciones sin categoría (null) del pipeline de ingesta.

### Diagnóstico real (refuta el wargame)
- El wargame asumía **71% null** en 7 fuentes; la realidad era **8.1% (50 de 618)**
  y **una sola fuente**: la ingesta automática por Hermes (server), no la UI.
- Tras el fix: **null = 0** en ambas sync docs.

### Piezas nuevas
| Archivo | Responsabilidad |
|---|---|
| `server/hermes/categoryGuard.mjs` | Port de keywords `DEFAULT_CATEGORIES` + `resolveCategory`/`ensureCategory` (server-side) |
| `server/backfill-null-categories.mjs` | Backfill idempotente (getSyncDoc/putSyncDoc): corrigió las 50 nulas |
| `src/selectors.js` → `categoryHealth()` | Métrica de salud de categorización (umbrales 5%/10%, excluye Transferencia) |
| `src/components/CategoryHealthCard` (en `Dashboard.jsx`) | Widget de salud + detalle en el dashboard |
| `ReviewRow` (en `McpMenu.jsx`) | Sugerencia de categoría por keywords + botón "Aplicar" |

### Guardianes (defensa en profundidad)
- `apply.mjs addTransaction`: punto único con `ensureCategory` → cubre `processor` + `review`.
- Frontend `categorize()` nunca devuelve null (ya blindado).

### Verificación
- Tests: `src/categoryHealth.test.js` (5) + `server/hermes/categoryGuard.test.mjs` (9, node:test).
- `npm test` (334), `npm run build` OK, deploy `index-B7iMyjkg.js`.
- Backup DB: `server/data/misfinanzas.db.bak-null-hunter`.

---

## ✅ OPERACIÓN GHOST PIPELINE (2026-08-17, commits `a6b91dd` + `b3c896b`)

El pipeline MCP existía pero era **silencioso**: el server marcaba cada transacción
con `_categoryConfidence`/`needsCategoryReview` pero el frontend nunca las convertía
en revisión humana, y no había telemetría. Fix completo en
`implementation_plan-ghost-pipeline.md`.

### Diagnóstico real (refuta el wargame)
- Eslabones 1-5 (SEED.reviewQueue, reducer `review_*`, fuentes, UI, badge) **ya estaban sanos**.
- Los huecos reales: auto-captura de revisión inexistente + sin telemetría + sin onboarding.

### Piezas nuevas
| Archivo | Responsabilidad |
|---|---|
| `src/utils/pipelineDiagnostics.js` | `diagnosePipeline()`: checklist de 5 eslabones + health + `pushPipelineEvents()` (cap 200) |
| `src/review.js` → `buildUnreviewedItems()` | Auto-captura: txs sin categoría / `needsCategoryReview` / confianza <0.8 → items de revisión (dedupe por id, respeta ya resueltas, cap 50/batch) |
| `src/components/McpPipelineHealth.jsx` | Widget de salud del pipeline + actividad reciente + botón "Reparar" (re-check) |
| `src/pipelineDiagnostics.test.js` + `src/pipelineE2E.test.js` | 21 tests nuevos |

### Cambios en `store.jsx`
- Auto-captura en `restore` (post-merge) y `add_transaction`.
- Casos nuevos: `mcp_record`, `mcp_batch` (telemetría), `pipeline_recheck` (reparación),
  `pipeline_demo` (onboarding con item de ejemplo no destructivo).
- `pipelineEvents` en SEED + `hydrate`; **excluido** de `syncableSlice` (volátil).

### Fuentes con telemetría
- `Assistant.jsx` y `PhotoSelector.jsx` emiten `mcp_record`/`mcp_batch` junto a `review_enqueue`.
- `McpMenu`: widget `McpPipelineHealth` + banner de onboarding cuando no hay actividad.

### Verificación
- `npm test` (**355**, +21), `npm run build` OK, 9 tests server OK.
- Deploy `index-gj2nFZcE.js` → `/var/www/misfinanzas/`, HTTPS 200, backend `server.mjs` activo.
- Git: `a6b91dd` (feature) + `b3c896b` (docs) → `main`; VPS alineado en `b3c896b`.