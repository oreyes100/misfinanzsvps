# War-game: Intereses duplicados diarios + assets que resucitan + limpiador de duplicados muerto
> Executor: run moves in order. Before each move, read its failure signals. Check abort conditions after every move.

## Mission objective
Tres entregables verificables en producción (`https://mis-finazas-gold.vercel.app`):
1. Las cuentas con intereses emiten **exactamente un juego de depósitos por día por tier** (1 depósito entre semana; el fin de semana acumulado se deposita lunes/martes en 1–3 partes según `weekendDeposits`). Cero duplicados nuevos tras recargar la app 3 veces seguidas.
2. Todas las transacciones de interés mal generadas se eliminan de la base de datos (Vercel Blob + localStorage de cada dispositivo) con tombstones para que no resuciten.
3. Los activos `Auto — Mazda 3` (id `dep-1`) y `Ethereum` (id `eth`) se pueden eliminar y NO reaparecen tras sync (tombstone de assets).
4. El botón "Analizar duplicados potenciales" muestra siempre un resultado visible (incluso "0 grupos") y detecta los duplicados de interés reales.

## Recon summary
Proyecto: `Mis finazas/` (React 19 + Vite 6 + TS, useReducer, Vercel Blob). Deploy: `vercel --prod` desde raíz. `npm test` (153 tests Vitest) antes de commit, `npm run build` antes de push.

**Hechos establecidos leyendo el código:**

- `src/interest.ts` — `accrueInterest(state)` es puro. IDs deterministas: `int-<accId>-t<1|2>-<postDate>-k<1..3>` e `isr-...`. Dedupe SOLO por `existingIds` (Set de `t.id`). La matemática diaria es correcta (25 000 × 12 %/360 = 8.33 → coincide con captura del usuario).
- **Vector de duplicado #1 (cuentas duplicadas):** captura muestra el 07/07 DOS pares de depósitos para "MLJR": tasa principal 12.00 % (+8.33) y 12.08 % (+41.97) — tasas distintas ⇒ **dos objetos Account distintos con el mismo nombre**, cada uno devengando por su lado. 41.97 ≈ 5 días de catch-up ⇒ el segundo Account tenía `lastAccrual` atrasado. Origen probable: resurrección de cuenta borrada por merge (bug corregido para accounts el 2026-07-17 con `deletedAccountIds`, pero los duplicados ya creados persisten en el blob).
- **Vector de duplicado #2 (IDs legacy):** versiones anteriores del código generaban IDs de interés sin sufijo `t<n>/k<n>`. Txs viejas en el blob + regeneración con IDs nuevos = duplicados que el Set no detecta.
- `src/store.jsx` — `load()` (línea ~479): sin localStorage arranca de `accrueInterest(SEED)`. SEED incluye `eth` (crypto) y `dep-1` (Mazda). Caso `restore` (línea ~397) hace mergeByID de `assets.crypto/realEstate/depreciating` **sin ningún tombstone** ⇒ borrar un asset local y hacer pull lo resucita desde la nube. Igual en `src/merge.js` (líneas 47-53) y `api/_merge.js` (líneas 36-41). **Este es el bug de Mazda/ETH — no es que el botón no funcione, es que el merge los devuelve.**
- `src/reducer.ts` — acciones `delete_crypto` (línea ~277), `delete_realestate` (~294), `delete_depreciating` (~317): filtran el array pero no registran tombstone. `store.jsx` tiene copia propia del reducer (mismas acciones).
- `syncableSlice` (store.jsx ~499) NO incluye ningún campo de assets borrados. El `syncable` useMemo tampoco.
- **Limpiador de duplicados** (`Settings.jsx` `DataTools`, ~349): `findPotentialDuplicateGroups` (utils.ts:360) agrupa por `descripción+fecha+monto+cuenta` EXACTOS. Los duplicados reales tienen montos/descripciones distintos (8.33 vs 41.97, "12.00 %" vs "12.08 %") ⇒ 0 grupos. Con 0 grupos solo hay un `flash()` de 4 s y ningún render ⇒ "no hace nada". Además `analyzeDuplicateValidity` sin Gemini marca `Intereses/Impuestos` como VÁLIDOS (utils.ts:393) ⇒ aunque agrupara, no ofrecería botón de borrado — exactamente al revés de lo que el usuario necesita.
- Ya existe acción `clean_interest_duplicates` en store.jsx (~448) con tombstones `deletedTransactions` — dedupe exacto, insuficiente para este caso pero es el patrón a seguir (borrar = filtrar + tombstone, sin ajustar saldos).
- Scripts con acceso directo al blob (patrón establecido): `scripts/backup_blob.mjs` (blob principal = `sync/6c1f6e95-3cc4-4a3d-999a-5eded8789c52.json`, token en `.env.local` → `BLOB_READ_WRITE_TOKEN`), `scripts/diagnose_sync.mjs` (lista todos los `sync/*`).
- Tombstones existentes: `deletedTransactions` (mapa id→timestamp), `deletedAccountIds` (array). Se replican en `src/merge.js`, `api/_merge.js`, caso `restore` de store.jsx, y `load()`.

**ZONA PROHIBIDA (invariantes de sesiones previas — NO tocar):** rama `accrual === "daily"` de la ruta histórica, `getDepositDate`, `weekendDepositDay`, `weekendDeposits`, lógica k1/k2/k3, `payoutDatesBetween`. El fix de duplicados NO cambia la matemática: se añade un guard semántico al final de `accrueInterest` (filtrado de `newTx`), fuera de esas ramas.

## Moves

### Move 1: Backup + diagnóstico de datos de producción
- **Action:** Desde `Mis finazas/`: `node scripts/backup_blob.mjs` y luego `node scripts/diagnose_sync.mjs`. Después escribir un script temporal (scratch, no commitear) que lea el backup recién creado en `scripts/backups/` y reporte: (a) cuentas agrupadas por `name` con sus `id`, `rate/rate1/rate2`, `lastAccrual`, `balance`, `_updatedAt` — buscar nombres repetidos (esp. "MLJR"); (b) transacciones con `category` ∈ {Intereses, Impuestos} agrupadas por `accountId|date`, con conteo por día — un día sano tiene ≤ `weekendDeposits` tx de interés por tier por cuenta; (c) IDs que NO matchean `/^(int|isr)-.+-t[12]-\d{4}-\d{2}-\d{2}-k[123]$/` ni `-approved-` (formato legacy); (d) contenido de `assets.crypto` y `assets.depreciating`.
- **Expected observation if it worked:** Backup en `scripts/backups/blob-backup-*.json`; el reporte muestra ≥2 cuentas con el mismo nombre O txs legacy O ambos; días con >expected txs de interés listados; `eth`/`dep-1` presentes en assets del blob.
- **Expected observation if it failed:** `Sin token en .env.local` o `Blob no encontrado`.
- **Most likely cause of failure:** `.env.local` sin `BLOB_READ_WRITE_TOKEN` o UUID del blob cambiado (el usuario usó "🔗 Cambiar código").
- **Countermove:** `node scripts/diagnose_sync.mjs` lista todos los `sync/*.json` con tamaño y fecha — el blob activo es el de `uploadedAt` más reciente y mayor número de tx. Actualizar `BLOB_KEY` en backup_blob.mjs (solo localmente) y reintentar. Si hay DOS blobs con actividad reciente → los dispositivos usan UUIDs distintos → registrar ambos y continuar el diagnóstico sobre ambos, pero ver Abort conditions.
- **Downstream consequences:** El resultado (a) decide la rama del Move 6: cuentas duplicadas ⇒ hay que tombstonear la cuenta sobrante además de sus txs. Si NO hay cuentas duplicadas ni IDs legacy y los conteos diarios son correctos, el bug activo ya no existe (lo arregló el fix de tombstones del 17-jul) y el Move 5 se vuelve solo-preventivo — igual ejecutarlo.

### Move 2: Tombstones de assets (código)
- **Action:** Añadir `deletedAssetIds: string[]` al estado (default `[]`). Cambios exactos:
  1. `src/types.ts`: campo opcional `deletedAssetIds?: string[]` en AppState.
  2. `src/reducer.ts` Y `src/store.jsx` (reducer duplicado — cambiar AMBOS): en `delete_crypto`, `delete_realestate`, `delete_depreciating`, además de filtrar, `deletedAssetIds: [...new Set([...(state.deletedAssetIds||[]), action.id])]`.
  3. `src/merge.js` `mergeSyncStates`: `mergedDeletedAssetIds` = unión de ambos lados; filtrar `crypto/realEstate/depreciating` mergeados con `.filter(x => !mergedDeletedAssetIds.includes(x.id))`; incluir `deletedAssetIds: mergedDeletedAssetIds` en el retorno.
  4. `api/_merge.js`: idéntico en el servidor.
  5. `src/store.jsx` caso `restore` (~línea 407): misma unión + filtro sobre los tres arrays de assets.
  6. `src/store.jsx` `load()` (~485): tras armar `merged`, filtrar `merged.assets.crypto/realEstate/depreciating` contra `merged.deletedAssetIds || []` (evita que SEED re-siembre `eth`/`dep-1` en dispositivos nuevos).
  7. `syncableSlice` y el useMemo `syncable` (store.jsx): añadir `deletedAssetIds`.
  8. `src/components/Assets.jsx`: tras cada dispatch de borrado, `setTimeout(() => sync?.forcePush?.(), 80)` si `sync?.id` (mismo patrón que `remove()` de Accounts.jsx).
- **Expected observation if it worked:** `npm test` verde (añadir 2 tests en `reducer.test.js`: borrar crypto agrega tombstone; en `server-merge.test.js`: merge filtra asset tombstoneado de ambos lados). `npm run build` exitoso.
- **Expected observation if it failed:** Test rojo `expected [] to include 'eth'` o build con error TS.
- **Most likely cause of failure:** Olvidar uno de los DOS reducers (reducer.ts vs store.jsx) — los tests importan `reducer.ts`, la app usa `store.jsx`; o typo en la clave dentro de `syncableSlice`.
- **Countermove:** Grep `delete_crypto` en ambos archivos y verificar que ambos bloques quedaron idénticos. Regla del proyecto: cualquier cambio en store.jsx exige `npm run build` antes y después.
- **Downstream consequences:** Sin el punto 6 (`load()`), el Move 8 fallará en dispositivos que borren localStorage: SEED revive `eth`/`dep-1` localmente y el push los re-sube. Sin el punto 4 (server), el merge-on-write de `api/sync.js` los resucita aunque el cliente esté bien.

### Move 3: Guard semántico anti-duplicado en accrueInterest
- **Action:** En `src/interest.ts`, SIN tocar ramas prohibidas: al inicio de `accrueInterest`, además de `existingIds`, construir `existingSemantic: Set<string>` recorriendo `state.transactions` con `category` ∈ {Intereses, Impuestos} y `auto`: clave `${t.accountId}|${t.date}|${cat}|${tier}|${k}` donde `tier` = "t2" si la descripción incluye "tasa secundaria", si no "t1"; `k` = match `/depósito (\d)\//` en descripción o "1". Al final de la función, antes de construir el estado de retorno, filtrar `newTx` eliminando las que colisionen con `existingSemantic` (misma derivación de clave sobre la tx candidata). Si el filtro elimina todas las tx de una cuenta, esa cuenta conserva el avance de `lastAccrual` que ya calculó (no revertir — evita re-intentos infinitos).
- **Expected observation if it worked:** Test nuevo en `interest.test.js`: estado con una tx legacy `{id:"int-legacy-abc", date:hoy, category:"Intereses", accountId:X, auto:true, description:"Intereses X (12.00 % TAE)"}` y cuenta X con `lastAccrual` = ayer ⇒ `accrueInterest` NO emite segunda tx de interés t1-k1 para hoy. Los 153 tests existentes siguen verdes.
- **Expected observation if it failed:** Tests existentes de interest.test.js rojos (sobre-filtrado: el guard bloquea k2/k3 legítimos o el tier 2).
- **Most likely cause of failure:** Clave semántica que no distingue k1/k2/k3 o t1/t2 ⇒ el primer depósito bloquea a los demás.
- **Countermove:** La clave DEBE incluir tier y k derivados de la descripción (los IDs nuevos también los llevan — derivar del ID cuando matchee el patrón `t(\d)-...-k(\d)`, fallback a descripción). Si un test existente de weekendDeposits falla, el guard está dentro de una rama prohibida — moverlo exclusivamente al filtrado final de `newTx`.
- **Downstream consequences:** Este guard hace idempotente la regeneración aunque existan txs legacy — es lo que impide que el Move 6 (limpieza) sea revertido por el próximo devengo.

### Move 4: Reparar el limpiador inteligente de duplicados
- **Action:** En `src/utils.ts` y `Settings.jsx`:
  1. Nueva función `findInterestAnomalyGroups(transactions, accounts)`: agrupa txs `auto` de Intereses/Impuestos por `accountId|date|tier` (tier derivado como en Move 3). Un grupo es sospechoso si tiene más miembros que `weekendDeposits||1` de su cuenta, o si la suma del día excede `interestSanityCap(cuenta, 4)` (importar de interest.ts). Mantener también el agrupador exacto actual para duplicados no-interés.
  2. `analyzeDuplicateValidity` SIN Gemini: para grupos de interés, en vez de `isValid: true` fijo, comparar contra el cap: `isValid = sumaDelGrupo <= cap`; razón explícita con números ("suma 50.30 > cap diario 16.66").
  3. UI (`Settings.jsx` `analyzeDuplicates`): resultado SIEMPRE visible — estado `dupAnalysisDone`; si 0 grupos, render persistente "✓ Sin duplicados potenciales (N transacciones analizadas)". Grupos válidos también se listan con botón secundario "Eliminar de todos modos".
  4. `removeDuplicateGroup`: al conservar 1, preferir la tx cuyo monto sea ≤ cap diario (la "buena"), no la de menor id. Tras borrar, `sync.forcePush()`.
- **Expected observation if it worked:** En dev (`npm run dev`), pestaña Ajustes → botón muestra resultado persistente; con datos del backup cargados en localStorage de prueba, los grupos del 07/07 de MLJR aparecen como "❌ excede cap".
- **Expected observation if it failed:** Botón sigue sin render visible, o consola: `interestSanityCap is not a function` (import circular utils↔interest).
- **Most likely cause of failure:** Import circular: `interest.ts` ya importa de `utils.ts`. `utils.ts` NO puede importar de `interest.ts`.
- **Countermove:** Duplicar el cálculo del cap en utils.ts como función local `dailyInterestCap(acc, days)` (3 líneas: `max(rate,rate1,rate2)/360 × balance × days × 2`) en lugar de importar. Decisión ya tomada: duplicación aceptada, documentar con comentario cruzado.
- **Downstream consequences:** Ninguna sobre moves posteriores; el limpiador es la herramienta de respaldo si el Move 6 deja residuos.

### Move 5: Tests + build + deploy
- **Action:** `npm test` → `npm run build` → commit → `vercel --prod` desde `Mis finazas/`. NO git push como mecanismo de deploy (webhook no confiable — patrón P9).
- **Expected observation if it worked:** 157+ tests verdes, build sin errores, `vercel --prod` devuelve URL de producción con estado Ready.
- **Expected observation if it failed:** Tests rojos o `vercel` pide login/scope.
- **Most likely cause of failure:** Tests de merge desactualizados por la nueva clave `deletedAssetIds` en snapshots/igualdades estrictas.
- **Countermove:** Ajustar solo las aserciones que comparan el objeto completo; jamás debilitar los tests de tombstone de cuentas del 17-jul. Si `vercel` pide credenciales → detenerse y reportar (Abort).
- **Downstream consequences:** El Move 6 escribe el blob DIRECTO; el servidor con `_merge.js` viejo re-mezclaría assets sin filtro en el siguiente POST de cualquier cliente. Por eso deploy ANTES de limpiar datos. Orden inviolable: código primero, datos después.

### Move 6: Limpieza de datos en producción (script)
- **Action:** Crear `scripts/clean_bad_interest.mjs` (patrón de backup_blob.mjs: leer token de `.env.local`, `get`/`put` de `@vercel/blob`). Lógica sobre el blob activo identificado en Move 1:
  1. Releer blob y re-hacer backup (segundo backup, post-deploy).
  2. **Cuentas duplicadas** (si Move 1 las encontró): conservar la de `_updatedAt` más reciente; la(s) otra(s): añadir su id a `deletedAccountIds`, quitarlas de `accounts`, y TODAS sus txs pasan a `deletedTransactions[id] = Date.now()` y se quitan de `transactions`.
  3. **Txs de interés malas** en cuentas conservadas: por cada grupo `accountId|date|tier|k` con >1 tx, conservar la de monto menor o igual al cap diario (`balance × maxRate/360 × 2`; si varias cumplen, la de menor monto) y tombstonear el resto. Tombstonear también toda tx legacy (ID sin `-t*-k*` y sin `-approved-`) que tenga contraparte de formato nuevo en el mismo `accountId|date|tier`.
  4. **Assets**: quitar `eth` de `assets.crypto` y `dep-1` de `assets.depreciating`; escribir `deletedAssetIds: ["eth","dep-1"]` (unión con lo existente).
  5. Imprimir resumen (cuentas eliminadas, N txs tombstoneadas, suma de montos por cuenta) y pedir confirmación por argumento `--apply` (sin él, dry-run que solo imprime).
  6. Con `--apply`: `put` del blob con `state` modificado y `updatedAt: Date.now()`.
  Ejecutar primero SIN `--apply`, revisar el resumen, luego con `--apply`.
- **Expected observation if it worked:** Dry-run imprime números coherentes con el diagnóstico del Move 1 (mismas fechas/cuentas). Con `--apply`, releer el blob muestra los tombstones y las txs ausentes.
- **Expected observation if it failed:** El dry-run quiere borrar txs manuales (`auto: false`) o >40 % de todas las transacciones.
- **Most likely cause of failure:** Clasificador demasiado agresivo — cuentas con `weekendDeposits: 2|3` tienen k1/k2/k3 legítimos el lunes que NO son duplicados.
- **Countermove:** El grupo es por `accountId|date|tier|k` (k incluido) — k1 y k2 del mismo lunes son grupos DISTINTOS. Nunca tocar txs con `auto !== true`. Si aun así el conteo parece alto, cotejar 5 casos a mano contra el backup antes de `--apply`.
- **Downstream consequences:** No ajustar `balance` de cuentas en el script (regla existente del proyecto: los duplicados de merge no acreditaron el saldo — comentario en `clean_interest_duplicates`). PERO aquí hay excepción: si había DOS cuentas devengando en paralelo, el saldo de la cuenta conservada puede estar bien y el problema desaparece al borrar la otra. Si el usuario reporta saldo incorrecto después, se corrige a mano en la UI (editar cuenta) — no automatizar.

### Move 7: Sincronizar dispositivos y verificar idempotencia
- **Action:** En el navegador de producción (Mac): login, esperar pull (o botón ☁️). Verificar en Movimientos con filtro de la cuenta afectada: días recientes con exactamente el número esperado de depósitos. Recargar la página 3 veces: el conteo de txs no debe crecer (guard del Move 3). Repetir pull en el teléfono/otro navegador.
- **Expected observation if it worked:** Duplicados desaparecen en todos los dispositivos tras un pull; recargas no generan txs nuevas; header muestra "synced".
- **Expected observation if it failed:** Duplicados reaparecen tras recargar, o el conteo crece con cada reload.
- **Most likely cause of failure:** Un dispositivo con localStorage viejo empuja sus txs antes de hacer pull (push gana), y esas txs no estaban tombstoneadas porque su ID difiere del que el script vio.
- **Countermove:** Los tombstones se mergean por unión en `_merge.js` — el push del dispositivo viejo no puede borrar tombstones. Si reaparecen txs con IDs nuevos no tombstoneados: correr de nuevo el script del Move 6 (es idempotente) DESPUÉS de que ese dispositivo haya hecho push; el guard del Move 3 impide que se regeneren más.
- **Downstream consequences:** Si tras dos ciclos siguen apareciendo, hay un tercer dispositivo o un blob alterno — volver a `diagnose_sync.mjs` y revisar UUIDs (Abort si no se identifica).

### Move 8: Verificar borrado de assets end-to-end
- **Action:** En producción: Gestión/Activos → eliminar "Auto — Mazda 3" y "Ethereum". Forzar sync (☁️). Recargar página. Abrir la app en segundo navegador (o pestaña privada con el mismo código de sync) y hacer pull.
- **Expected observation if it worked:** Ambos assets ausentes tras recarga y en el segundo navegador; el blob (releer con script) muestra `deletedAssetIds` conteniendo `eth` y `dep-1`.
- **Expected observation if it failed:** Reaparecen tras recargar o en el otro navegador.
- **Most likely cause of failure:** El Move 6 ya los quitó del blob pero un cliente con localStorage viejo los re-empuja y falta el filtro server-side (punto 4 del Move 2 mal aplicado), o el deploy no incluyó `api/_merge.js`.
- **Countermove:** Verificar en el código deployado (`vercel ls` + inspeccionar el deployment o re-deploy) que `_merge.js` filtra por `deletedAssetIds`. Re-deploy y repetir.
- **Downstream consequences:** Ninguna — es el último gate de la misión de assets.

### Move 9: Verificar limpiador en producción y cerrar
- **Action:** Ajustes → "Analizar duplicados potenciales". Debe renderizar resultado persistente (grupos o "sin duplicados"). Registrar sesión: actualizar `Logs/` y `Meta/Contexto Activo.md` del vault según protocolo `/close`.
- **Expected observation if it worked:** Mensaje/lista visible que no desaparece a los 4 segundos; si quedan grupos, el botón de eliminar funciona y hace forcePush.
- **Expected observation if it failed:** Nada visible tras el spinner.
- **Most likely cause of failure:** Build viejo cacheado en el navegador.
- **Countermove:** Hard reload (Cmd+Shift+R); verificar hash del bundle en Network vs `dist/` local.
- **Downstream consequences:** Fin de misión.

## Unresolved assumptions
- **Saldos reales actuales** de las cuentas afectadas: solo el usuario los conoce (app del banco/SOFIPO). El script NO corrige saldos; si tras la limpieza el saldo mostrado difiere del real, el usuario lo ajusta editando la cuenta en la UI. Preguntarle al cerrar.
- **UUID de sync por dispositivo:** se asume que Mac y teléfono comparten `6c1f6e95-3cc4-4a3d-999a-5eded8789c52`. `diagnose_sync.mjs` lo confirma o desmiente en Move 1. Si difieren, el usuario debe unificarlos (Ajustes → Sincronización → 🔗 Cambiar código) ANTES del Move 7.
- **Config deseada por cuenta** (`weekendDeposits` 1/2/3, `weekendDepositDay`): se asume que lo configurado en cada Account es lo que el usuario quiere; la misión no cambia configuraciones, solo elimina emisiones duplicadas.
- **Cuántas cuentas generan intereses y cuáles tienen duplicados:** lo determina el diagnóstico del Move 1 — no asumir que MLJR es la única.

## Abort conditions
- El backup del Move 1 falla o no se puede confirmar cuál blob es el activo → STOP, reportar lista de blobs al usuario.
- El dry-run del Move 6 propone borrar cualquier tx con `auto !== true`, o más del 40 % del total de transacciones → STOP, adjuntar el resumen del dry-run.
- Cualquier test de la ZONA PROHIBIDA (weekendDeposits/k-splits/daily) se rompe y el fix requeriría modificar esas ramas → STOP, reportar el test exacto.
- `vercel --prod` pide credenciales o falla dos veces → STOP (no usar git push como sustituto).
- Tras dos ciclos de limpieza+pull (Move 7) siguen apareciendo duplicados nuevos → STOP, hay un generador no identificado; adjuntar IDs de las txs nuevas.
