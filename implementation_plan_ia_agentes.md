# Plan — IA de clasificación por cuenta (Drive/Photos) + Agente Telegram

> **Plan First**: esta feature toca más de 3 archivos, así que se escribe el plan
> antes de tocar código. Ver `CLAUDE.md` → "Plan First".

## Objetivo

1. **Clasificar un conjunto de imágenes** (recibos, capturas de banco, comprobantes
   de transferencia) que viven en una carpeta de **Google Drive** o **Google Photos**,
   y determinar **en qué cuenta** se debe registrar cada transacción.
2. **Agente por bot de Telegram**: alguien manda una foto de recibo al bot y este
   propone la transacción (descripción, fecha, importe, categoría, cuenta) con botones
   **✅ Registrar / ❌ Descartar**; solo se asienta tras aprobación (ver
   `BOT-TELEGRAM-CUENTAS.md`, patrón del módulo Cuentas).

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
| `api/lib/blob-json.js` | readJSON/writeJSON privados sobre Vercel Blob |
| `api/lib/cors.js` | CORS idéntico a sync.js (origin allowlist) |
| `api/lib/accounts.js` | Normalización + resolución de cuentas por pista (banco, *dígitos) |
| `api/lib/ai.js` | Motor IA multi-proveedor (gemini / openai / anthropic) para imágenes + post-proceso a cuentas |
| `api/lib/state-store.js` | load/update estado sync + `addProposedTransactions` (balance-aware) |
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