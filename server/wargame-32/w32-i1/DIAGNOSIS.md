# W32-I1 — Diagnóstico: fallo en el registro de nuevas cuentas (POST /api/signup)

> **Fecha**: 2026-09-03 · **Branch**: `wargame-32/w32-i1` · **Tipo**: solo diagnóstico (no fix)
> **Veredicto**: la causa raíz es la **ausencia de `RESEND_API_KEY` en el entorno del proceso del servidor**, detectada por la guardia de `server/server.mjs:515-516`, que corta el flujo de signup con HTTP 503 antes de intentar enviar el correo de verificación.

## 1. Síntoma

El endpoint `POST /api/signup` (paso `action:"request"`, el que usa el frontend en
`src/components/Login.jsx:72-75`) devuelve:

```
{"error":"Registro por correo no disponible en este momento."}   (HTTP 503)
```

Evidencia en vivo (servidor corriendo en :3000, PID 84374, iniciado 2026-09-03 20:53):

```
$ curl -s -X POST http://localhost:3000/api/signup -H "Content-Type: application/json" \
    -d '{"action":"request","email":"diag_...@example.com","password":"P@ssw0rd123"}'
{"error":"Registro por correo no disponible en este momento."}
```

## 2. Causa raíz (línea pinpoint)

`server/server.mjs` — dentro de `handleSignup()`, rama `action === "request"`:

```js
// server.mjs:515
const apiKey = process.env.RESEND_API_KEY;
// server.mjs:516
if (!apiKey) return sendJson(res, 503, { error: "Registro por correo no disponible en este momento." });
```

- **515**: se lee `process.env.RESEND_API_KEY` (envío de correo vía Resend, consumido en 518-523 contra `https://api.resend.com/emails`).
- **516**: si la variable no está definida → 503 con el mensaje exacto del síntoma. Es el único lugar de todo el repo que genera ese mensaje (verificado con grep en `server/`).

### Por qué la guardia dispara

1. **No hay `.env`**: no existe `.env` ni `server/.env` en el working tree (verificado con `ls -la .env* server/.env*`).
2. **El proceso no carga dotenv**: `server.mjs` no importa `dotenv` y `server/package.json` arranca con `node server.mjs` puro; la única fuente de env es el entorno del proceso.
3. **El entorno del proceso no tiene la clave**: `tr '\0' '\n' < /proc/84374/environ | grep RESEND` → 0 coincidencias (tampoco `RESEND_FROM`).
4. Comentario en la cabecera de `server.mjs:5` lo declara opcional: `Env: PORT (3000), HOST (127.0.0.1), ALLOWED_ORIGINS, RESEND_API_KEY (opcional)` — el flujo de email queda funcionalmente deshabilitado cuando falta.

### Importante: la guardia NO es lo primero que falla en el flujo

Antes de la guardia, el request ya pasó por:
- 502-503: validación de email/password (mensajes distintos: "Correo inválido.", "Contraseña muy corta…").
- 505-508: chequeo de usuario existente (409 "Ese correo ya tiene una cuenta.").
- 509-514: generación de código de 6 dígitos + PBKDF2 + **escritura exitosa del pending en SQLite** (`signup_pending`, tabla creada en `db.mjs:77`).

Es decir: **la BD y los permisos no son el problema** — el pending se persiste correctamente y recién entonces la guardia de env corta con 503 (efecto secundario: filas huérfanas en `signup_pending` que expiran solas).

## 3. Hallazgo secundario (discrepancia del curl del criterio AC1)

El curl literal del criterio de aceptación (sin `action`) obtiene otra respuesta en esta branch:

```
$ curl -s -X POST http://localhost:3000/api/signup -d '{"email":"...","password":"..."}'
{"error":"Acción no reconocida."}   (HTTP 400, server.mjs:569)
```

Causa: en esta branch (`w32-i1` @ 53063bf) `handleSignup` **exige** `action: "request" | "verify"`;
el path de registro directo (email+password sin `action`) fue añadido después en el commit
`0a497a7` de la branch `wargame-32/w32-i3`. El servidor en vivo (iniciado 20:53, anterior a ese
commit de 22:37) tampoco lo tiene. El mensaje "Registro por correo no disponible…" solo aparece
por la ruta `action:"request"`, que es exactamente la que usa `Login.jsx` — por eso el usuario
real sí ve el mensaje diagnosticado.

## 4. Hipótesis descartadas

| Hipótesis | Veredicto | Evidencia |
|---|---|---|
| Endpoint no existe | **Descartada** | Router lo despacha: `server.mjs:647` (`if (urlPath === "/api/signup") return await handleSignup(...)`) y CORS en 623 |
| Rate limit (`ratelimit.mjs`) | **Descartada** | El path `/api/signup` no tiene limiter (solo snapshot/categorize/learn/ai-test); el mensaje 429 es otro ("Demasiadas peticiones…") |
| Fallo silencioso de validación | **Descartada** | Las validaciones (502-503) retornan mensajes propios; se llega a la guardia con datos válidos |
| Permisos BD / SQLite (`signup_pending`) | **Descartada** | `writePendings` (514) corre ANTES de la guardia y no lanza; el 503 ocurre después |
| `auth.mjs` | **Descartada** | `server/auth.mjs` no contiene el mensaje ni lógica de signup (solo `checkLearnAuth`); grep sin coincidencias |

## 5. Verificación de criterios de aceptación

- **AC1** — el endpoint sigue devolviendo el error actual antes de cualquier cambio: ✅ verificado en vivo
  con el flujo real del frontend (`action:"request"`) → mensaje exacto. (Nota: el curl literal del AC,
  sin `action`, devuelve "Acción no reconocida." en esta branch — ver §3.)
- **AC2** — sección de código responsable identificada: ✅ `server/server.mjs:515-516` (guardia sobre
  `process.env.RESEND_API_KEY`); único generador del mensaje en el repo.
  `grep -n "signup" server/server.mjs` → 647 (dispatch), 516 (mensaje).

## 6. Fix recomendado (fuera de alcance de este issue)

Cualquiera de: (a) proveer `RESEND_API_KEY` al proceso (`export RESEND_API_KEY=…` antes de
`node server.mjs` / systemd env), o (b) implementar el registro directo sin email (ya prototipado en
w32-i3), o (c) devolver el código por otra vía cuando la clave no exista. Diagnóstico terminado —
no se modificó lógica de autenticación.
