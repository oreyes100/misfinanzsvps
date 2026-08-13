# SETUP — Importación con IA (Drive/Photos) y Agente de Telegram

Guía operativa para activar en producción (Vercel) las dos capacidades nuevas de
Mis Finanzas: **importación inteligente** de recibos desde Google Drive / Google
Photos, y el **agente por Telegram** que registra movimientos con aprobación humana.

Endpoints nuevos (Vercel Functions):

| Ruta | Función |
|------|---------|
| `api/google-auth.js` | OAuth2 de Google (Drive + Photos), guarda tokens por syncCode |
| `api/google-import.js` | Lista/descarga/clasifica imágenes por lotes (batch en Blob) |
| `api/telegram.js` | Webhook del bot: foto → propuesta + botones ✅/❌ |
| `api/telegram-config.js` | Vincula chat↔syncCode, token del bot, prueba y setWebhook |

Módulos compartidos: `lib/{cors,blob-json,accounts,ai,state-store,google-tokens,telegram}.js`.

---

## 1. Variables de entorno en Vercel

En `Project → Settings → Environment Variables` (Production + Preview):

| Variable | Necesaria para | Notas |
|----------|----------------|-------|
| `GOOGLE_CLIENT_ID` | Drive API / Photos (OAuth) | Aplicación OAuth 2.0 de Google Cloud |
| `GOOGLE_CLIENT_SECRET` | Drive API / Photos (OAuth) | Mismo proyecto Google Cloud |
| `GEMINI_API_KEY` | IA en servidor (por defecto) | Opcional si el usuario pone su key en Ajustes |
| `OPENAI_API_KEY` | IA en servidor (OpenAI) | Opcional |
| `ANTHROPIC_API_KEY` | IA en servidor (Anthropic) | Opcional |
| `AI_PROVIDER` | Proveedor por defecto del servidor | `gemini` (default) / `openai` / `anthropic` |
| `ALLOWED_ORIGINS` | CORS | Default `https://mis-finazas-gold.vercel.app` |
| `TELEGRAM_WEBHOOK_SECRET` | Bot | Fallback si un vínculo no tiene secreto propio |

> La clave de IA la puede poner el usuario en **Ajustes → Motor de IA** (se guarda
> en su estado sync, no en el servidor) o el servidor por env. Las claves Google son
> solo de servidor (no se exponen al cliente).

## 2. Google Cloud (solo para Drive API / Photos)

1. Crear/abrir proyecto en https://console.cloud.google.com.
2. Habilitar **Google Drive API** y **Google Photos Library API**.
3. **OAuth consent screen** → tipo Externo, agregar scope `drive.readonly` y `photoslibrary.readonly`.
4. **Credentials → Create OAuth Client ID** → tipo *Web application*.
5. Authorized redirect URI:
   `https://<TU-DOMINIO>.vercel.app/api/google-auth`
   (`https://mis-finazas-gold.vercel.app/api/google-auth` en producción, y
   `http://localhost:5173/api/google-auth` si pruebas con `vercel dev`).
6. Copiar Client ID y Secret a las env vars y hacer redeploy.

## 3. Agente de Telegram

Pasos en la app (Ajustes → **Agente por Telegram**):

1. Crea el bot con [@BotFather](https://t.me/BotFather) y copia el **token**.
2. Consigue el **chat_id**: mensajea a `@userinfobot` (te devuelve tu ID) o, para
   grupos, usa el ID negativo que aparece en `getUpdates`.
3. Pega token + chat_id, elige proveedor/cuenta por defecto → **Vincular y guardar**.
4. **📨 Mensaje de prueba** → el bot te debe contestar en Telegram.
5. **🔗 Registrar webhook** → llama a `setWebhook` de Telegram contra
   `https://<TU-DOMINIO>.vercel.app/api/telegram` con `secret_token` propio.
6. Envía la foto de un recibo al bot → responde propuesta + botones
   **✅ Registrar / ❌ Descartar**.

Reglas de seguridad:
- El webhook firma con `X-Telegram-Bot-Api-Secret-Token`; updates sin el secreto
  correcto del chat vinculado reciben `401`.
- Nada se asienta sin el botón ✅ (la aprobación es obligatoria y ocurre en Telegram).
- La aprobación ajusta saldos **server-side** contra `sync/{syncCode}.json`
  (misma lógica que `add_transaction` del reducer) y aprende alias banco→cuenta.

## 4. Importación desde Drive/Photos

En la app: pestaña **Importar**.

- **Drive (pública, sin login)**: comparte la carpeta como «Cualquiera con el
  enlace» y pega la URL. El servidor lista vía `embeddedfolderview` y descarga
  cada imagen.
- **Drive / Photos (con tu cuenta)**: botón **Conectar Google (OAuth)** → se abre
  el flujo de Google y los tokens quedan en Blob privado
  `google-tokens/{syncCode}.json` (se renuevan solos vía `refresh_token`).
- La IA clasifica en bloques de 6 (por el timeout del plan Hobby); el cliente
  repite con `start` hasta `done`.
- Las propuestas se guardan en `ai-batches/{syncCode}/{batchId}.json` y se
  muestran para **revisar y registrar**: se confirma cuenta, categoría, fecha e
  importe antes de aplicar; los alias aprendidos se reutilizan.

Límites: imágenes/PDF ≤ 8 MB, máx. 200 archivos por importación.

## 5. Verificación

```bash
# Estado del bot (diagnóstico)
curl -s "https://mis-finazas-gold.vercel.app/api/telegram"

# Webhook registrado según Telegram (con chat vinculado)
curl -s "https://mis-finazas-gold.vercel.app/api/telegram?chatId=<CHAT_ID>&syncCode=<SYNC_CODE>"

# Diagnóstico de la importación (tokens Google + claves de IA del servidor)
curl -s "https://mis-finazas-gold.vercel.app/api/google-import?syncCode=<SYNC_CODE>&check=1"

# Conectar Google desde línea de comandos (devuelve authUrl)
curl -s "https://mis-finazas-gold.vercel.app/api/google-auth?syncCode=<SYNC_CODE>"
```

## 6. Fallos comunes

| Síntoma | Causa | Fix |
|---------|-------|-----|
| `no_creds` al conectar Google | Env sin `GOOGLE_CLIENT_ID/SECRET` | Configurar env + redeploy |
| `redirect_uri_mismatch` | URI no registrada en Google Cloud | Registrar `.../api/google-auth` |
| El bot no responde | Webhook no registrado o secreto distinto | Re-registrar; revisar `getWebhookInfo` |
| `no_key` al clasificar | Sin key de IA en cliente ni servidor | Poner key en Ajustes o env |
| `quota` / `model_missing` | Plan de la key sin cuota o modelo retirado | Cambiar de proveedor o esperar |
| Timeout en importación grande | Plan Hobby (10s) | El cliente ya procesa por bloques de 6 |
