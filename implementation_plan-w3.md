# W3 Photo Vault — Plan (Revisión 2026)
## Fase 0 — Recon (20 Ago 2026)
- Existe integración Google previa: `src/services/googlePhotos.js` PKCE client-side directo a `oauth2.googleapis.com/token` (violación spec), `src/services/tokenSecurity.js` AES-GCM ok, `src/services/photoScanner.js` paginado + `receiptDetector` multi-capa + `PhotoSelector.jsx` + `GooglePhotosSettings.jsx` + `server/extra.js` `/api/google-auth` (drive+photos). `receiptStorage.js` + PaddleOCR W11 OK.
- `VITE_GOOGLE_PHOTOS_CLIENT_ID` vacío, `GOOGLE_CLIENT_ID` en VPS vacío (env | grep vacío). Usuario eligió "Usar existente de Drive" → reusar `GOOGLE_CLIENT_ID` del server como fuente única (no Vite env duplicado).
- Criterio: reutilizar photoScanner/receiptStorage/PaddleOCR, no duplicar; code→tokens debe ocurrir EN SERVER (`/api/google-token`), scope `photoslibrary.readonly` únicamente.

## Fases
| Fase | Entrega | Criterio |
|---|---|---|
| 1 | OAuth PKCE server-side `POST /api/google-token` (code+verifier → tokens) + `GET /api/google-config` (expone clientId), cliente `googlePhotos.js` usa server, scope readonly | client secret nunca en bundle, PKCE S256, network no expone tokens en claro |
| 2 | Detector multi-capa `receiptDetector.js` ya tiene 3 capas (filename hint, wordHits, longitud) → añadir capa aspecto si metadata disponible | paisaje score<30 descartado |
| 3 | Escaneo progresivo `photoScanner.js:91 scanForReceipts` ya paginado 100, timeBudget, onProgress → verificar maxItems 500 documentado | progreso visible lotes |
| 4 | Tokens cifrados `tokenSecurity.js` AES-GCM PBKDF2 100k ya ok | localStorage no legible |
| 5 | Selector `PhotoSelector.jsx` ya lista candidatas, filtros, Encolar en MCP | vista previa + selección |
| 6 | Limpieza `revokeTokens` ya revoca + clearTokens + borrar blobs | desconectar borra todo |

## Archivos
- NUEVO: `server/googleToken.mjs` (handler)
- EDIT: `server/server.mjs` (rutas /api/google-token, /api/google-config), `src/services/googlePhotos.js` (cambiar exchange a server, scope readonly, fetch clientId de server), `src/services/receiptDetector.js` (añadir capa ratio si aplica)
- No duplicar photoScanner/receiptStorage.

## Riesgo
- Doble OAuth (drive vs photos) con mismo GOOGLE_CLIENT_ID → usar mismo clientId para ambos, scopes separados por flujo; photos usa PKCE sin secret.
