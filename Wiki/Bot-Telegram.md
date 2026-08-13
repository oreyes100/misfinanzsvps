---
title: Bot de Telegram (Recibos)
tags: [ia, telegram, bot, webhook, aprobacion, ocr]
source: api/telegram.js + api/telegram-config.js + src/components/TelegramAgent.jsx
---

# Bot de Telegram — Recibos con aprobación

Agente que recibe la foto de un recibo en un chat de Telegram, la clasifica con IA
y responde con la propuesta y botones **✅ Registrar / ❌ Descartar**. Nada entra en
la contabilidad sin el botón ✅ (la aprobación es obligatoria y ocurre en Telegram).

## Flujo

1. `POST /api/telegram` recibe el update firmado con
   `X-Telegram-Bot-Api-Secret-Token` (401 si no coincide con el secreto del vínculo).
2. Se busca el vínculo por `chat_id` (`telegram/bindings/{chatId}.json`). Chats sin
   vínculo (o deshabilitado) → `200` silencioso.
3. `message` con foto/documento (imagen o PDF, ≤ 8 MB):
   - `getFile` + `downloadFile` → `classifyImage()` con el proveedor del vínculo.
   - Responde la propuesta formateada + inline keyboard con `ap:<msgId>` / `rj:<msgId>`
     (key = `message_id` del mensaje entrante del usuario).
   - Guarda la propuesta pendiente en `telegram/proposals/{chatId}/{msgId}.json`.
4. `callback_query`:
   - `rj` → marca `rejected`, edita los botones.
   - `ap` → aplica `addProposedTransactions()` (ajuste de saldo idéntico al
     reducer `add_transaction`) contra `sync/{syncCode}.json` vía
     `updateSyncState` (merge por ID), aprende alias con `learnAccountAliases`,
     marca `approved` y confirma en el chat.

## Configuración

`api/telegram-config.js` (llamado desde `TelegramAgent.jsx` en Ajustes):

- `save` — guarda `{ chatId, syncCode, botToken, aiProvider, aiApiKey,
  defaultAccountId, enabled }`. Solo el dueño del `syncCode` puede leerlo.
- `test` — envía un mensaje de prueba (valida token + chat).
- `register` — genera `webhookSecret` (reutilizado si ya existe) y llama
  `setWebhook(url=/api/telegram, secret_token=…)`.
- `GET ?chatId=&syncCode=` — estado saneado (el token nunca se devuelve).

## Seguridad

- Firma del webhook por chat (secreto generado en `register`); fallback a env
  `TELEGRAM_WEBHOOK_SECRET`.
- Aprobación humana obligatoria: el bot jamás asienta sin `callback_query` ✅.
- `defaultAccountId` se usa solo cuando la IA no detecta el banco; si tampoco hay
  cuenta asignada, la propuesta queda en `error` y se avisa.

## Errores útiles

- Bot no responde → webhook sin registrar (`getWebhookInfo`) o secreto viejo.
- «Sin cuenta asignada» al aprobar → configurar cuenta por defecto o editar la imagen.
- Errores de IA normalizados (quota/forbidden/model_missing) se devuelven en el chat.

> Fuente: `api/telegram.js`, `api/telegram-config.js`, `lib/telegram.js`, `lib/state-store.js`, `src/components/TelegramAgent.jsx`
