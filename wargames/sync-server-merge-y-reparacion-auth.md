# War-game: Merge en servidor + reparación de credenciales multi-dispositivo
> Executor: run moves in order. Before each move, read its failure signals. Check abort conditions after every move.

## Mission objective

Dos fallas persisten tras el fix cliente del 2026-07-17:

1. **Sync**: transacciones del celular (13–17 jul) siguen sin aparecer en la MacBook. Causa raíz confirmada: el celular corre un **APK Capacitor con bundle embebido** (`capacitor.config.json`: `webDir: "dist"`, sin `server.url`) — nunca recibirá el fix de push transaccional por refresh, y su push ciego sobrescribe la nube en cada debounce/flush. Además, el `flush()` de `store.jsx` (pagehide/visibilitychange) del bundle NUEVO también hace POST ciego sin merge.
2. **Auth**: nadie puede entrar desde otros dispositivos, ni con contraseña reseteada, ni en navegación privada. Causa raíz confirmada: `users/global.json` está congelado desde **2026-07-02** con un solo usuario (`jr`) y el hash de ESA fecha. Todos los cambios de contraseña posteriores fallaron con 403 silencioso (el cliente enviaba el hash NUEVO como actor y el servidor comparaba contra el VIEJO). El fix cliente del 17-jul no repara la divergencia ya existente: hash local ≠ hash nube → 403 perpetuo.

**Éxito medible:**
- POST a `/api/sync` con estado parcial NO borra datos existentes en la nube (unión, no sobrescritura) — verificado con curl sobre un blob de prueba.
- `diagnose_sync.mjs` muestra `última tx manual ≥ 2026-07-13` en el blob principal (tx del celular recuperadas).
- Login exitoso con usuario `jr` en ventana privada de otro navegador/dispositivo.
- Cambio de contraseña posterior actualiza `users/global.json` (updatedAt avanza) — verificado con `diagnose_sync.mjs`.
- 134+ tests verdes, build limpio, deploy `vercel --prod` OK.

## Recon summary

**Blobs (obtenido 2026-07-17 con `scripts/diagnose_sync.mjs`):**
- Blob activo único: `sync/6c1f6e95-3cc4-4a3d-999a-5eded8789c52.json` — 344 KB, 38 cuentas, 1688 tx (123 manuales), última tx manual **2026-07-12**, updatedAt 2026-07-17 17:17 UTC. Ambos dispositivos usan el MISMO código — no hay split-brain de sync-id.
- Otros blobs: 2 rancios de junio + 7 de prueba (`test-*`). Ignorar.
- `users/global.json`: updatedAt **2026-07-02**, un solo usuario `jr` (admin) con hash+salt de esa fecha.
- Apple: balance=40693.04, lastAccrual=2026-07-13, payoutDayOfMonth=undefined (cirugía del wargame anterior AÚN pendiente — va después de este brief).

**Arquitectura relevante:**
- `api/sync.js`: GET devuelve `{found, state, updatedAt}`; POST valida tamaño (1 MB máx) y hace `put()` directo — **sobrescritura ciega**. Aquí va el merge de servidor.
- `api/users.js`: acciones `verify` (server-side PBKDF2), `setup` (solo si nube vacía), y escritura de lista `{users, actor}` autorizada comparando `actor.hash` con el hash del admin ALMACENADO (`authorizeWrite`). Dos bugs estructurales: (a) si el hash local del actor divergió, 403 para siempre; (b) la lista escrita puede traer usuarios SIN hash/salt (el cliente cachea usuarios de nube saneados) y la escritura los guarda así → destruye credenciales de usuarios que el dispositivo emisor no tenía completos.
- `src/auth.js`: `changePassword` ya captura el hash viejo como actor (fix 17-jul, commit 9eca723) pero es inútil si local ya divergió de nube. `mergeUsers` conserva hash local si existe; usuarios solo-nube quedan sin hash localmente.
- `src/merge.js`: `mergeSyncStates(local, cloud)` pura, unión por `_updatedAt`, tombstones `deletedTransactions`/`deletedAccountIds`. **No puede importarse desde `api/`** (importa `utils.js` → `utils.ts`, TypeScript; el runtime de funciones Vercel no compila TS). El merge de servidor debe ser autocontenido.
- Convención Vercel: archivos en `api/` que empiezan con `_` NO se exponen como endpoints → `api/_merge.js` puede ser módulo compartido y testeable desde Vitest.
- IDs deterministas de intereses nuevos: `int-<accId>-t1-<fecha>-k1` / `isr-...`. Los duplicados legacy del APK viejo usan `uid()` aleatorio y categorías `Intereses`/`Impuestos` con `auto:true` — dedupe por clave compuesta `${accountId}|${date}|${description}|${amount}`.
- Blob principal 344 KB, límite 1 MB. El APK viejo agrega ~26 tx/día de interés duplicado → el dedupe de servidor frena el crecimiento.
- PBKDF2 paridad cliente/servidor: ambos usan bytes UTF-8 del salt base64, 100k iteraciones, SHA-256, 256 bits, hex. `api/users.js` `pbkdf2()` ya es idéntico a `auth.js` `hashPassword()`.
- Tests: 134 en Vitest (`npm test`). Build: `npm run build`. Deploy: `vercel deploy --prod` desde raíz. Token blob en `.env.local` (`BLOB_READ_WRITE_TOKEN`).
- Restricciones: NO tocar rama `accrual === "daily"` ni `getDepositDate`/`weekendDeposits`; NO modificar store.jsx sin build verify; NO commit sin tests; `new Date("YYYY-MM-DD")` en México = día anterior → usar `T12:00:00`.

## Moves

### Move 1: Baseline
- **Action:** `cd "Mis finazas" && npm test -- --run && npm run build`.
- **Expected observation if it worked:** `Tests 134 passed`, build `✓ built`.
- **Expected observation if it failed:** tests rojos o error de build.
- **Most likely cause of failure:** working tree sucio de sesión anterior.
- **Countermove:** `git status` + `git stash -u`, re-correr. Si sigue rojo → abort (reportar).
- **Downstream consequences:** ninguna; gate de entrada.

### Move 2: Módulo de merge compartido del servidor — `api/_merge.js`
- **Action:** crear `api/_merge.js` autocontenido (CERO imports de `src/`), exportando:
  ```js
  // api/_merge.js — merge de estados de sync en servidor. Autocontenido (no importa de src/).
  export function mergeById(a, b) {
    const list = Array.isArray(a) ? [...a] : [];
    const map = new Map(list.map((x) => [x.id, x]));
    for (const item of Array.isArray(b) ? b : []) {
      const prev = map.get(item.id);
      if (!prev || (item._updatedAt || 0) > (prev._updatedAt || 0)) map.set(item.id, item);
    }
    return [...map.values()];
  }

  // Dedupe de intereses automáticos por clave compuesta (los legacy usan id aleatorio).
  export function dedupeAutoInterest(txs) {
    const seen = new Set();
    const out = [];
    for (const t of txs) {
      const isAutoInterest = t && t.auto && (t.category === "Intereses" || t.category === "Impuestos");
      if (!isAutoInterest) { out.push(t); continue; }
      const key = `${t.accountId}|${t.date}|${t.description}|${t.amount}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
    return out;
  }

  export function mergeStates(existing, incoming) {
    if (!existing || typeof existing !== "object") return incoming;
    if (!incoming || typeof incoming !== "object") return existing;
    const deletedTransactions = { ...(existing.deletedTransactions || {}), ...(incoming.deletedTransactions || {}) };
    const deletedAccountIds = [...new Set([...(existing.deletedAccountIds || []), ...(incoming.deletedAccountIds || [])])];
    let transactions = mergeById(existing.transactions, incoming.transactions)
      .filter((t) => !deletedTransactions[t.id]);
    transactions = dedupeAutoInterest(transactions);
    const assets = incoming.assets ? {
      ...(existing.assets || {}), ...incoming.assets,
      crypto: mergeById((existing.assets || {}).crypto, (incoming.assets || {}).crypto),
      realEstate: mergeById((existing.assets || {}).realEstate, (incoming.assets || {}).realEstate),
      depreciating: mergeById((existing.assets || {}).depreciating, (incoming.assets || {}).depreciating),
    } : existing.assets;
    return {
      ...existing, ...incoming,
      _syncVersion: Math.max(existing._syncVersion || 0, incoming._syncVersion || 0),
      settings: { ...(existing.settings || {}), ...(incoming.settings || {}) },
      accounts: mergeById(existing.accounts, incoming.accounts),
      transactions, deletedTransactions, deletedAccountIds,
      scheduled: mergeById(existing.scheduled, incoming.scheduled),
      categories: mergeById(existing.categories, incoming.categories),
      transferAliases: { ...(existing.transferAliases || {}), ...(incoming.transferAliases || {}) },
      categoryAliases: { ...(existing.categoryAliases || {}), ...(incoming.categoryAliases || {}) },
      statementPatterns: { ...(existing.statementPatterns || {}), ...(incoming.statementPatterns || {}) },
      assets,
    };
  }
  ```
  Nota: las cuentas usan last-write-wins por `_updatedAt`; el APK viejo no pone `_updatedAt` en cuentas al acreditar interés viejo (`_updatedAt` solo con txs nuevos) — aceptable: el balance de cuenta se corregirá en la cirugía Apple posterior.
- **Expected observation if it worked:** archivo creado; NO aparece como endpoint (`/api/_merge` debe dar 404 tras deploy — verificar en Move 6).
- **Expected observation if it failed:** deploy expone `/api/_merge` como función.
- **Most likely cause of failure:** convención de guion bajo no aplicada por versión vieja de Vercel CLI.
- **Countermove:** mover a `api/lib/merge.js`... NO — subdirectorios en api/ también se exponen. Alternativa segura: si `_merge.js` se expone, hacer que no tenga default export (Vercel devuelve error 500 en handler ausente, no filtra datos — aceptable) o mover la lógica inline dentro de `sync.js`.
- **Downstream consequences:** si termina inline en sync.js, los tests del Move 5 importan desde `api/sync.js`... no se puede (tiene handler con imports @vercel/blob). En ese caso duplicar la lógica pura en el test (comparación por fixtures).

### Move 3: `api/sync.js` — POST con merge en servidor
- **Action:** en el handler POST, tras validar body y ANTES del `put()`:
  ```js
  import { mergeStates } from "./_merge.js";
  // dentro del POST:
  let finalState = body.state;
  try {
    const existing = await get(key, { access: "private", useCache: false });
    if (existing) {
      const prev = JSON.parse(await new Response(existing.stream).text());
      if (prev && prev.state) finalState = mergeStates(prev.state, body.state);
    }
  } catch { /* sin blob previo o error de lectura: escribir incoming tal cual */ }
  const payload = JSON.stringify({ state: finalState, updatedAt: Date.now() });
  ```
  Mantener el guard de 1 MB DESPUÉS del merge (el estado unido puede ser mayor que el entrante). Respuesta: `{ ok: true, merged: true }` (los clientes viejos solo leen `ok`).
- **Expected observation if it worked:** tests del Move 5 verdes; en Move 6 el curl de verificación muestra unión.
- **Expected observation if it failed:** POST devuelve 500, o el estado guardado pierde entidades.
- **Most likely cause of failure:** import de `_merge.js` falla en runtime Vercel (resolución ESM: usar extensión explícita `./_merge.js` — las funciones del proyecto ya usan sintaxis ESM `import`, es consistente).
- **Countermove:** inline de las tres funciones dentro de `sync.js` (sin import). Duplica código pero desbloquea.
- **Downstream consequences:** CRÍTICO — con esto, el APK viejo, el `flush()` ciego y cualquier cliente futuro dejan de poder destruir datos. Es la pieza que hace todo lo demás recuperable. Riesgo residual documentado: dos POST simultáneos (read-modify-write sin transacción) pueden perder la escritura del primero; ventana ~100 ms; el pull periódico de 5 min + próximo push del perdedor lo auto-repara. NO intentar arreglar esto con locks — Vercel Blob no da transacciones (alternativa real: Upstash Redis, fuera de alcance).

### Move 4: `api/users.js` — blindaje + acción `change_password`
- **Action:** tres cambios:
  1. **Preservar credenciales en escritura de lista**: en la rama `Array.isArray(body.users)`, antes de `writeUsers`, para cada usuario entrante SIN `hash` o `salt`, restaurar los del usuario homónimo en `existing`. Nunca almacenar un usuario sin credenciales si la nube las tenía:
     ```js
     const byName = new Map(existing.map((u) => [u.username.toLowerCase().trim(), u]));
     const healed = body.users.map((u) => {
       if (u.hash && u.salt) return u;
       const prev = byName.get(String(u.username || "").toLowerCase().trim());
       return prev && prev.hash && prev.salt ? { ...u, hash: prev.hash, salt: prev.salt } : u;
     });
     await writeUsers(healed);
     ```
  2. **Acción `change_password` autorizada por CONTRASEÑA (no por eco de hash)**:
     ```js
     if (body.action === "change_password") {
       const users = await readUsers();
       const target = users.find((u) => u.username.toLowerCase() === String(body.username || "").toLowerCase().trim());
       if (!target) return res.status(404).json({ error: "Usuario no encontrado." });
       if (!body.newPassword || String(body.newPassword).length < 6) return res.status(400).json({ error: "Contraseña muy corta." });
       // Autoriza: el propio usuario con su contraseña actual, o un admin con la suya.
       let authorized = verifyCredential(target, body.currentPassword);
       if (!authorized && body.actorUsername) {
         const admin = users.find((u) => u.username.toLowerCase() === String(body.actorUsername).toLowerCase().trim() && (u.role === "admin" || u.sections === "all"));
         authorized = admin && verifyCredential(admin, body.actorPassword);
       }
       if (!authorized) return res.status(403).json({ error: "Credenciales incorrectas." });
       target.salt = crypto.randomBytes(16).toString("base64");
       target.hash = pbkdf2(body.newPassword, target.salt);
       await writeUsers(users);
       const { hash, ...safe } = target;
       return res.status(200).json({ ok: true, user: safe });
     }
     ```
     El salt generado con `randomBytes(16).toString("base64")` es compatible: cliente y servidor usan los bytes UTF-8 del string base64.
  3. Mantener `verify`, `setup` y la escritura de lista legacy (con healing) intactos para clientes viejos.
- **Expected observation if it worked:** curl de prueba en Move 6: `change_password` con contraseña mala → 403; no probar con credenciales reales por curl (quedan en historial de shell) — la prueba real la hace el usuario en la UI.
- **Expected observation if it failed:** 500 (error de sintaxis/imports), o 403 con credenciales correctas.
- **Most likely cause of failure:** `crypto` ya está importado en users.js (`node:crypto`) — verificar; olvido de `await` en `writeUsers`.
- **Countermove:** revisar logs con `vercel inspect --logs`; el endpoint es pequeño, depurar directo.
- **Downstream consequences:** con esto `changePassword` deja de depender de que el hash local coincida con la nube → el 403 perpetuo muere. La escritura-lista con healing evita que un dispositivo con caché parcial borre credenciales ajenas.

### Move 5: Cliente — `auth.js` + `Users.jsx` usan la acción nueva; tests
- **Action:**
  1. `auth.js` — `changePassword(username, newPassword, auth)` donde `auth = { currentPassword }` o `{ actorUsername, actorPassword }`:
     - POST `{action:"change_password", username, newPassword, ...auth}`.
     - Si `ok`: actualizar caché local con `salt` devuelto y `hash = await hashPassword(newPassword, salt)`, `saveUsers`.
     - Si falla por red: error visible (NO silencioso — el silencio causó este incidente).
  2. `Users.jsx` — el editor de contraseña agrega campo "Tu contraseña de administrador" (`actorPassword`, con `autoComplete="current-password"`); `savePw` pasa `{ actorUsername: session.username, actorPassword }`. Mensaje de error del servidor mostrado tal cual.
  3. `createUser` — mantener flujo actual (lista con actor-hash) PERO como el server ahora sana credenciales y el admin puede re-sincronizar su hash tras un login cloudVerify, es aceptable. NO ampliar alcance.
  4. Tests nuevos en `src/auth.test.js` o archivo nuevo `api/_merge.test.js`... Vitest incluye solo `src/**/*.test.{js,jsx}` — crear `src/server-merge.test.js` que importe `../api/_merge.js` (ruta relativa sale de src/, funciona en Vitest). Casos mínimos: (a) merge no pierde tx exclusivas de cada lado; (b) `_updatedAt` mayor gana en cuentas; (c) tombstone elimina en unión; (d) dedupeAutoInterest colapsa duplicados de clave compuesta conservando el primero; (e) merge con existing=null devuelve incoming.
- **Expected observation if it worked:** `npm test` ≥ 139 verdes; `npm run build` limpio.
- **Expected observation if it failed:** import de `../api/_merge.js` falla en Vitest (fuera de root de test).
- **Most likely cause of failure:** config de include de Vitest no restringe imports, solo descubrimiento — el import funcionará. Si no: mover tests inline con fixtures duplicadas.
- **Countermove:** ajustar `test.include` o duplicar lógica en fixture de test (peor, aceptable).
- **Downstream consequences:** cobertura del merge de servidor queda en CI local; toda regresión futura del merge se detecta antes de deploy.

### Move 6: Deploy + verificación con blob de PRUEBA (nunca el real)
- **Action:**
  1. `npm test -- --run && npm run build` → commit (mensaje: `feat(server): merge-on-write sync + password-authorized user actions`) → `vercel deploy --prod`.
  2. Verificar merge con id de prueba `test-merge-20260717-abcdef123456`:
     ```bash
     B=https://mis-finazas-gold.vercel.app
     curl -s -X POST "$B/api/sync?id=test-merge-20260717-abcdef123456" -H 'Content-Type: application/json' \
       -d '{"state":{"transactions":[{"id":"a1","date":"2026-07-17","amount":1,"_updatedAt":1}],"accounts":[]}}'
     curl -s -X POST "$B/api/sync?id=test-merge-20260717-abcdef123456" -H 'Content-Type: application/json' \
       -d '{"state":{"transactions":[{"id":"b2","date":"2026-07-17","amount":2,"_updatedAt":2}],"accounts":[]}}'
     curl -s "$B/api/sync?id=test-merge-20260717-abcdef123456" | python3 -c "import json,sys; d=json.load(sys.stdin); print(sorted(t['id'] for t in d['state']['transactions']))"
     ```
     Esperado: `['a1', 'b2']` — el segundo POST NO borró `a1`.
  3. `curl -s -o /dev/null -w "%{http_code}" $B/api/_merge` → esperado `404`.
  4. `change_password` negativo: `curl -s -X POST "$B/api/users" -H 'Content-Type: application/json' -d '{"action":"change_password","username":"jr","currentPassword":"incorrecta","newPassword":"xxxxxx"}'` → esperado `{"error":"Credenciales incorrectas."}` con 403.
- **Expected observation if it worked:** los tres checks pasan.
- **Expected observation if it failed:** `['b2']` solo (merge no corre) → NO continuar; el deploy sigue siendo destructivo.
- **Most likely cause of failure:** `_merge.js` no resolvió en runtime (ver Move 3 countermove) — revisar `vercel inspect <url> --logs`.
- **Countermove:** inline del merge en sync.js, redeploy, repetir checks. Si `/_merge` devuelve 200 con contenido: renombrar a inline y redeploy (no dejar módulo expuesto).
- **Downstream consequences:** a partir de aquí el blob real está protegido; los moves 7–9 pueden tocar producción con seguridad.

### Move 7: Reparación del blob de usuarios
- **Action:** dos rutas — decidir con el usuario (no inventar contraseñas):
  - **Ruta A (preferida, sin cirugía):** el hash en nube es del 2026-07-02 (contraseña ORIGINAL de `jr`). Preguntar al usuario si la recuerda. Si sí: en la MacBook, abrir la app → Ajustes → Usuarios → 🔑 Contraseña de jr → poner la contraseña NUEVA deseada usando el campo "Tu contraseña de administrador" con la ORIGINAL. El server la valida contra su hash y actualiza. Listo.
  - **Ruta B (cirugía, si no recuerda la original):** crear `scripts/repair_users.mjs` (mismo patrón de token que `diagnose_sync.mjs`): lee `users/global.json`, y con `--user jr --password <temporal>` genera `salt = crypto.randomBytes(16).toString("base64")`, `hash = pbkdf2Sync(pass, salt, 100000, 32, "sha256").toString("hex")`, escribe el blob. **El USUARIO ejecuta el script con una contraseña temporal elegida por él** (el ejecutor NO la elige ni la escribe en la UI). Después el usuario entra y la cambia desde la app (flujo ya reparado).
- **Expected observation if it worked:** `node scripts/diagnose_sync.mjs` muestra `users/global.json` con updatedAt de HOY.
- **Expected observation if it failed:** updatedAt sigue 2026-07-02; login remoto sigue fallando.
- **Most likely cause of failure:** Ruta A → usuario no recuerda contraseña original (pasar a B); Ruta B → error de escritura de blob (token sin permiso de escritura — improbable, ya se usa para put en producción).
- **Countermove:** si ambas rutas fallan, verificar con curl `verify` (usuario tecleando la contraseña en un prompt local, no en historial): si `verify` da `ok:false` con la contraseña que el usuario JURA correcta → sospechar mismatch PBKDF2 cliente/servidor → abort y reportar (requiere análisis, no adivinar).
- **Downstream consequences:** tras esto, cualquier dispositivo puede hacer login vía `cloudVerify` (la navegación privada ya funcionará: no depende de localStorage). Usuarios secundarios post-2-jul NO existen en nube — recrearlos desde Ajustes → Usuarios en la Mac (el flujo lista+actor funciona una vez que el hash local de jr vuelva a coincidir con la nube, cosa que ocurre automáticamente al re-loguear o tras cloudVerify).

### Move 8: Verificación de login multi-dispositivo (acción del usuario)
- **Action:** pedir al usuario: (1) ventana privada en la Mac → login `jr` con la contraseña vigente → debe entrar; (2) en el celular (APK viejo, no importa): logout si hay sesión, login con la misma → debe entrar (usa `cloudVerify`, no requiere bundle nuevo); (3) si usa biometría en el celular, re-enrolar desde Ajustes (la credencial WebAuthn local apunta al usuario correcto, solo verificar que entra).
- **Expected observation if it worked:** dashboard visible en ambos contextos.
- **Expected observation if it failed:** "Usuario o contraseña incorrectos" en celular con la contraseña que SÍ funciona en Mac privada.
- **Most likely cause of failure:** APK viejo con `mis-finazas-users` local rancio conteniendo un `jr` con hash viejo → el paso 1 de `login()` falla local y el paso 2 `cloudVerify` lo rescata... el flujo ya contempla eso. Si aún falla: el APK apunta a otro `API_BASE` (verificar `capacitor://localhost` en CORS — ya permitido).
- **Countermove:** en el celular usar el botón "¿Olvidaste la contraseña? Resetear acceso" (borra usuarios locales + biometría, NO toca nube) → reintentar login → fuerza ruta cloudVerify limpia.
- **Downstream consequences:** ninguna estructural; confirma el fix.

### Move 9: Recuperar transacciones del celular
- **Action:** con el merge de servidor YA desplegado (Move 6 verificado): en el celular abrir la app → Ajustes → Sincronización → **"Subir ahora"** (forcePush existe en el bundle viejo). El POST ciego del APK ahora se une en servidor con lo existente. Luego en la Mac: foco a la app (dispara pull) o esperar el pull de 5 min. Verificar: `node scripts/diagnose_sync.mjs` → `última tx manual` debe ser ≥ 2026-07-13 y el conteo de manuales > 123.
- **Expected observation if it worked:** tx del celular visibles en Movimientos de la Mac; diagnose confirma.
- **Expected observation if it failed:** última tx manual sigue 2026-07-12.
- **Most likely cause of failure:** el celular ya PERDIÓ esas tx localmente (un pull previo con `restore` pudo filtrarlas solo si estaban en `deletedTransactions` — improbable; el merge cliente es unión). Más probable: el usuario registró esas tx bajo OTRO sync-id o sin sync activo.
- **Countermove:** en el celular, Ajustes → verificar que el código de sync empieza con `6c1f6e95`. Si difiere → ese es el problema original; copiar el código de la Mac y "Conectar" en el celular (el estado local del celular se fusiona vía restore + push). Re-verificar con diagnose.
- **Downstream consequences:** si las tx aparecen con el dedupe de servidor activo, el blob además se habrá limpiado de duplicados de interés legacy en el mismo POST (efecto colateral positivo — verificar conteo total de tx BAJÓ pese a sumar manuales).

### Move 10: Corrección recurrente + plan APK
- **Action:**
  1. Documentar en `wargames/` (este archivo, sección resultado) los conteos post-fix del diagnose.
  2. **Proceso recurrente**: `node scripts/diagnose_sync.mjs` tras cualquier anomalía de sync; el dedupe de servidor corre solo en cada POST (auto-sanación continua); el pull de 5 min + pull-on-focus ya están en el bundle web nuevo.
  3. **APK**: sigue con bundle viejo (genera pushes ciegos — ya inofensivos — y duplicados de interés — ya deduplicados en server). Recomendar al usuario UNA de: (a) recompilar/reinstalar APK: `npm run build && npx cap sync android` + build en Android Studio; (b) usar el navegador del celular con la PWA de `mis-finazas-gold.vercel.app` (siempre bundle fresco) y abandonar el APK. Hasta entonces, el server tolera al APK viejo.
  4. Recordatorio de pendientes del wargame anterior (ejecutar DESPUÉS de que este brief cierre): cirugía Apple (balance 42125.22, lastAccrual 2026-06-30, payoutDayOfMonth 31 — con backup previo vía `scripts/backup_blob.mjs`) y limpieza global de duplicados (el dedupe de servidor puede haberla hecho ya — verificar con diagnose antes de ejecutar nada).
- **Expected observation if it worked:** usuario informado con checklist claro; diagnose documentado.
- **Expected observation if it failed:** n/a (move informativo).
- **Most likely cause of failure:** n/a.
- **Countermove:** n/a.
- **Downstream consequences:** cierra el ciclo; deja guardias permanentes.

## Unresolved assumptions

1. **¿El celular usa el APK Capacitor o el navegador/PWA?** Afecta solo el Move 10 (plan de actualización). El fix de servidor funciona igual en ambos casos. El usuario puede confirmarlo: si en Ajustes → Sincronización aparece "Bundle: <fecha de hoy>" tras refrescar, es navegador; si nunca cambia, es APK.
2. **¿El usuario recuerda la contraseña original de jr (la del 2026-07-02)?** Decide Ruta A vs B del Move 7. Solo el usuario puede responder.
3. **¿Qué usuarios secundarios existían localmente en la Mac después del 2-jul?** La nube solo tiene `jr`. El usuario debe revisarlos en Ajustes → Usuarios (lista local) y recrearlos tras el Move 7.
4. **¿Las tx del celular 13–17 jul siguen en su localStorage?** No verificable desde aquí. Si el Move 9 falla por pérdida local, esas tx deben recapturarse a mano (no hay copia en nube — confirmado por diagnose).
5. **Escrituras concurrentes**: Vercel Blob no ofrece transacciones; merge-on-write reduce la ventana de pérdida a ~100 ms y el sistema se auto-repara en el siguiente push/pull. Aceptado y documentado. Alternativa si algún día se observa pérdida real: mover el estado a Upstash Redis (transaccional) o journal de eventos append-only por dispositivo (refactor mayor). Tercera alternativa: backend gestionado (Supabase) para auth+datos — resuelve ambos problemas de raíz pero es migración completa; fuera de alcance de este brief.

## Abort conditions

- Move 1: tests o build rojos que no se resuelven con stash → reportar, no tocar servidor.
- Move 6: el curl de verificación muestra sobrescritura (`['b2']`) tras 2 intentos de fix → **rollback inmediato**: `git revert` del commit + `vercel deploy --prod` (el POST ciego previo es el statu quo, no empeora), reportar.
- Move 6: `/api/_merge` expone contenido → no dejar en producción; inline + redeploy antes de continuar.
- Move 7: `verify` devuelve `ok:false` con contraseña que el usuario confirma correcta → sospecha de mismatch PBKDF2 → STOP total (tocar hashes a ciegas puede dejar fuera al único admin), reportar con evidencia.
- Cualquier move: `users/global.json` o el blob principal ilegibles/corruptos → STOP, backup inmediato con `scripts/backup_blob.mjs`, reportar.
- Blob principal > 900 KB tras merge → ejecutar dedupe/limpieza antes de cualquier otra escritura (guard de 1 MB rechazaría pushes y el sistema dejaría de sincronizar por completo).
