---
title: IA - Importación de Cuentas (Drive/Photos)
tags: [ia, importacion, drive, photos, blob, oauth]
source: api/google-import.js + api/google-auth.js + src/components/IaImport.jsx
---

# IA — Importación de Imágenes y Asignación a Cuentas

Importa un lote de recibos/capturas desde una carpeta de Google Drive o un álbum
de Google Photos, los clasifica con visión por IA (multi-proveedor) y deja que el
usuario **revise y registre** cada transacción en su cuenta.

## Flujo

1. El cliente (`IaImport.jsx`) hace `POST /api/google-import` con `syncCode`,
   `source` (drive-public | drive-api | photos) y la referencia de la carpeta/álbum.
2. En la primera llamada el servidor **lista** los archivos y guarda el batch en
   Blob (`ai-batches/{syncCode}/{batchId}.json`); en las siguientes procesa el
   bloque `[start, start+limit)` (por defecto 6, máximo 8) por el timeout del
   plan Hobby.
3. Cada imagen se descarga (≤ 8 MB, `image/*` o PDF) y se clasifica con
   `classifyImage()` → JSON: `type`, `merchant`, `date`, `currency`, `total`,
   `transactions[]`, `accountHints`, `confidence`.
4. `suggestAccountForImage()` resuelve banco/tarjeta/dígitos → cuenta del usuario
   (`accountId` + `accountName` + `accountConfident`), igual que el `resolveAccount`
   de `src/ocr.js`, y aprende alias al registrar.
5. El cliente muestra cada transacción con cuenta/categoría/fecha/importe editables
   y un botón **Registrar N seleccionadas** que despacha `add_transaction` y
   `learn_transfer_aliases` (y hace `sync.forcePush`).

## Fuentes

- **drive-public**: sin OAuth. Lista con `embeddedfolderview` y descarga vía
  `drive.usercontent.google.com` (requiere carpeta «Cualquiera con el enlace»).
- **drive-api**: OAuth2 + Drive REST API (`'<folderId>' in parents`, filtro por
  mime y `trashed=false`).
- **photos**: OAuth2 + Photos Library `mediaItems:search` con paginación.

Los tokens OAuth viven en `google-tokens/{syncCode}.json` (Blob privado) y se
renuevan solos con `refresh_token` (`ensureGoogleTokens`). El OAuth se inicia en
`api/google-auth.js` (`authUrl` para el popup; el callback guarda los tokens y
cierra la ventana).

## Proveedores IA

`api/lib/ai.js` soporta `gemini` (gratis), `openai` (gpt-4o-mini) y `anthropic`
(claude-3-5-haiku-latest), elegibles en la UI. Errores normalizados:
`invalid_key`, `forbidden`, `quota`, `model_missing`, `overloaded`, `network`,
`no_key`. La key puede venir del body (Ajustes) o de env del servidor.

## Seguridad y límites

- CORS restringido por `ALLOWED_ORIGINS` (igual que `api/sync.js`).
- El `syncCode` es la llave de propiedad: solo quien lo posee lee/escribe su batch.
- Máx. 8 MB por archivo, 200 por lote; bloques de 6 para caber en el timeout Hobby.

> Fuente: `api/google-import.js`, `api/google-auth.js`, `api/lib/ai.js`, `api/lib/accounts.js`, `src/components/IaImport.jsx`
