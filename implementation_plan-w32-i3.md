# implementation_plan-w32-i3 — Seed de datos demo para cuentas nuevas

## Objetivo
Toda cuenta creada vía `/api/signup` (paso único, sin `action`) queda poblada con
datos demo coherentes y consultables con sesión por cookie.

## Criterio de aceptación
```
EMAIL="seeded_$(date +%s)@example.com"; PASSWORD="StrongP@ssw0rd123"
curl -s -X POST http://localhost:3000/api/signup -d '{"email":"'$EMAIL'","password":"'$PASSWORD'"}' -c /tmp/cookie.txt > /dev/null
curl -s -b /tmp/cookie.txt http://localhost:3000/api/accounts | grep -q '"id":"'
```
Hoy esto falla en dos puntos: (1) signup sin `action` → 400 "Acción no
reconocida." (server.mjs:576) y (2) no existe `/api/accounts` (404).

## Estado actual (leído, byte-level)
- `handleSignup` (server.mjs:496) solo soporta `action: request|verify`.
- No hay sesión por cookie: la auth actual es sync-code en query + PBKDF2 en /api/users.
- Doc de sincronización: `sync_docs` clave `sync_code` (ID_RE `/^[a-z0-9-]{16,64}$/i`),
  estado con forma de SEED del cliente (reducer.ts:20): accounts/assets/transactions/
  categories/fx/priceHistory + `_syncVersion`.
- RBAC de vistas: `session.accounts` (array de IDs) filtra con `filterAccounts`
  (src/auth.js:320) → el usuario demo debe listar `DEMO_ACCOUNT_IDS`
  (["acc-corriente","acc-ahorro","acc-deposito","acc-usd"], utils.ts:119) y el doc
  debe contener cuentas con esos ids.
- `consolidateAndBump` (api/_merge.js:34) es la referencia W23 de consolidación;
  `putSyncDoc` (db.mjs:197) normaliza el doc a las tablas relacionales.

## Diseño

### 1. `server/seed.mjs` (nuevo, puro — sin I/O, sin deps de src/)
- `DEMO_CATEGORIES`: espejo de DEFAULT_CATEGORIES (utils.ts:129).
- `buildDemoState({ email, now })` → estado con la MISMA forma que el SEED del
  cliente (coherencia total con hydrate/useFX): settings, 4 cuentas de dinero
  (ids DEMO_ACCOUNT_IDS, saldos/tasas/accrual idénticos al SEED), assets, 7
  transacciones demo (ids deterministas tx-1..tx-7 como reducer.ts), scheduled,
  categories, aliases vacíos, fx snapshot BASE_FX (useFX lo refresca a los 30 min),
  priceHistory determinista, goldPriceEUR, `_isDemo/_demoSeededAt/_syncVersion:1`,
  deletedX, reviewQueue, pipelineEvents. Sin `Math.random` → re-seed idempotente
  y testeable.
- `demoSyncCode(username)` → `demo-` + sha256(username)[0..27] = 32 chars,
  cumple ID_RE. Clave determinista por usuario → `handleAccounts` resuelve el doc
  sin esquema nuevo ni mappings en memoria; sobrevive reinicios.
- `DEMO_ACCOUNT_IDS` re-exportado.

### 2. `server/auth.mjs` (sesiones por cookie, memoria)
- `SESSION_COOKIE = "mf_session"`, `parseCookieHeader`, `sessionCookie(token)`.
- `createSession(username)` → token de 32 bytes aleatorios (Map con tope 1000).
- `sessionUsername(req)` → resuelve cookie → username | null.

### 3. `server/server.mjs`
- Import de seed + sesión; helpers `uniqueUsername(users, base)` y
  `seedDemoDoc(db, username, email)` (putSyncDoc solo si el doc no existe —
  nunca pisa datos del usuario).
- `handleSignup`: rama de paso único cuando no hay `action`:
  validaciones (400 email/contraseña, mismas reglas), 409 email duplicado,
  crea usuario (PBKDF2, role guest, sections DEMO_SECTIONS, accounts=DEMO_ACCOUNT_IDS),
  siembra doc demo, responde `{ ok, username, syncId }` + `Set-Cookie` HttpOnly
  SameSite=Lax. La rama `verify` también siembra el doc (usuarios NUEVOS de
  ambos caminos quedan poblados; respuesta conserva `{ ok, username }`).
- `handleAccounts` (GET): sesión → usuario → doc demo → `{ ok, syncId, accounts }`;
  401 sin/ con sesión inválida; usuarios previos a esta feature (sin doc) →
  `accounts: []` (non-goal: no sembrar usuarios existentes).
- Router: `/api/accounts` antes de `/api/signup`.

### 4. Tests (node:test, sandbox /tmp/opencode — NUNCA server/data/**)
- `server/seed.test.mjs`: pureza/determinismo, cuentas de dinero válidas,
  transacciones referencian cuentas/categorías reales, flags demo,
  compatibilidad consolidateAndBump (W23).
- `server/auth.test.mjs`: roundtrip cookie→username, cookies basura, tope de sesiones.
- `server/signup.test.mjs`: server vivo en sandbox (patrón w32-i1): signup paso
  único 200+cookie, /api/accounts con cookie contiene `"id":"` y la cuenta
  acc-corriente, 401 sin cookie, 409 duplicado, 400 contraseña débil, flujo
  request/verify intacto y sembrado, doc legible vía /api/sync.
- package.json: `node --test "server/hermes/*.test.mjs" "server/seed.test.mjs" "server/auth.test.mjs" "server/signup.test.mjs"`.

## Non-goals
- No tocar frontend (Login.jsx sigue con su flujo de 2 pasos).
- No sembrar/modificar usuarios existentes.
- No tocar server/data/** (sandbox aislado); sin sudo.

## Riesgos
- El code demo derivado del username es calculable → solo expone datos seed;
  aceptable en MVP local (el flujo real del cliente usa UUID propio).
- El server vivo de la 3000 (systemd) corre código viejo hasta reinicio; la
  verificación exacta del criterio se hace contra sandbox en puerto libre.
