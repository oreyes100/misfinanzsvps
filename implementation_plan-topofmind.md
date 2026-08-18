# Plan — Top of Mind: embeddings semánticos + precio de oro real (2026-08-17)

> Repo: `oreyes100/misfinanzsvps` · Rama: `main` (HEAD `854399c`)
> Alcance: 2 pendientes del Top of Mind. Plan First (>3 archivos).

## Pendiente A — Categorización IA de reglas → embedding semántico

### Diagnóstico verificado
- `categorize()` (reglas por substring) vive en `src/utils.ts:107`; se usa en
  reducer, store, OCR, Modals, McpMenu, parseIntent. Es síncrono (el reducer no
  puede ser async).
- YA existe `categorizeSemanticAsync` en `utils.ts:126` y `embedText`/
  `cosineSimilarity` en `lib/ai.js` y `server/hermes/gemini.mjs`, pero NO está
  cableado (0 callers) y `lib/ai.js` es server-only (process.env).
- Hermes (Nous Research) corre en el VPS como gateway, con motor de embeddings
  en `server/hermes/gemini.mjs` (`embedText`: ollama/openai/gemini; config tiene
  `geminiKey`). nginx proxea `/api/*` → server.mjs `:3000`.

### Decisión
Endpoint `/api/categorize` en `server.mjs` que usa `embedText` de
`server/hermes/gemini.mjs` (proveedor por env `EMBED_PROVIDER`, key por env
`GEMINI_API_KEY` o config de Hermes). Construye prototipos embeddeando
nombre+keywords+subcategorías de cada categoría; k-NN coseno. Frontend llama al
endpoint desde la UI (async) con fallback a reglas si no hay backend.

### Cambios
| Archivo | Cambio |
|---|---|
| `server/server.mjs` | Nuevo `POST /api/categorize` (body: `{text, categories}` → `{category, confidence}`) usando `embedText` de `gemini.mjs`; fallback a reglas server-side |
| `src/utils.ts` | `categorizeSemanticAsync` cableada a `/api/categorize` (fallback `categorize()`); `buildCategoryPrototypes` |
| `src/components/Modals.jsx` | TransactionModal usa sugerencia semántica async cuando hay backend |
| `src/components/McpMenu.jsx` | Preview usa sugerencia semántica async |
| `src/utils.test.js` | Tests de fallback (endpoint caído → reglas) |

El reducer conserva `categorize()` síncrono (no romper sync); la mejora semántica
se aplica en la capa de UI/human-in-the-loop donde ya hay async.

## Pendiente B — Precio de oro real en useFX

### Diagnóstico verificado
- `goldPriceEUR: 68.4` fijo en SEED (`store.jsx:84`, `reducer.ts:64`);
  `useFX.js` nunca lo toca; `priceHistory.GOLD` solo tiene la serie sintética.

### Decisión (aprobada)
`gold-api.com` sin key: `GET https://api.gold-api.com/price/XAU` → USD/onza.
Convertir a EUR/gramo: `usdPerOz / 31.1035 / fx.USD`. Fallback al valor fijo.

### Cambios
| Archivo | Cambio |
|---|---|
| `src/useFX.js` | Fetch oro junto a fiat+crypto; calcula EUR/g; dispatch `update_fx` con `goldPriceEUR` + `priceHistory.GOLD` |
| `src/reducer.ts` | `update_fx` acepta `action.goldPriceEUR` y hace push a `GOLD` |
| `src/store.jsx` | Ídem reducer |
| `src/reducer.test.js` | Test: `update_fx` con goldPriceEUR actualiza gold y GOLD history |
| `src/useFX.test.js` (nuevo) | Test conversión USD/onza → EUR/g + fallback |

## Verificación
- `npm test` (369 actuales + nuevos) → verde.
- `npm run build` OK.
- Deploy: build VPS, `cp dist/* /var/www/misfinanzas/`, chown, HTTPS 200.
- Endpoint: `curl -X POST https://dineroorganizado.duckdns.org/api/categorize` con texto de prueba.
- Push main + alinear VPS (ff-only).

## Riesgos
- Embeddings requieren GEMINI_API_KEY en el VPS (ya está en config.json de Hermes);
  si falla → fallback reglas (cero degradación).
- gold-api.com puede caer → fallback al valor fijo actual.
- No tocar el reducer síncrono con awaits.
