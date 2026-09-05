# W35–W37f — Corrección de Ediciones Revertidas y Duplicados de Intereses
> **Proyecto**: [misfinanzsvps](https://github.com/oreyes100/misfinanzsvps) · **Producción**: https://dineroorganizado.duckdns.org
> **Fecha**: 3–4 de septiembre de 2026
> **Commits**: `143b3c4` (W35) · `e69c6ff` (W36) · `febb4d1` (W37) · `dbf32d4` (W37b/c) · `935b9d4` (W37d) · `3fcaa37` (W37e) · `a3f1705` (W37e-fix) · `c1bc9bb` (docs L0) · `fccc100` (W37f) · `29fae21` (docs W37f) · `e50024b` (review-loop) · `089d69b` (W37g — LA RAÍZ REAL)
> **Tests finales**: 596/596 ✅

---

## 📊 RESUMEN EJECUTIVO

Cinco reportes del usuario, una cadena de causas compartida — **mutaciones sin `_updatedAt`** + **un dedupe con la clave/implementación equivocadas** + **un proceso stale** + **un push que no adoptaba la versión del server** — manifestados como:

1. **Ediciones que se revertían** (~90s con la consolidación)
2. **Ediciones que se revertían** (~1s con el race del resync)
3. **Creaciones que desaparecían de inmediato** (el colapso del estado: 1302→290)
4. **Ediciones que seguían revertiéndose** (el proceso del server con el módulo roto en memoria, 17h)
5. **La causa estructural final**: el push no adoptaba la versión/estado consolidado del server → loop infinito de versiones + hydrate con snapshots pre-edición

**Estado final**: los 4 movers de balance stamp-ean el account, los accruals stamp-ean sus txs, el dedupe de intereses usa la clave exacta con best-per-group (identidad), el accrue no churna, el resync cuenta el `_dirty` render-confirmado, **y el push ahora adopta la versión del server (rompe el loop)**.

---

## 📊 RESUMEN EJECUTIVO

Tres reportes del usuario, una cadena de causas compartida — **mutaciones sin `_updatedAt`** + **un dedupe con la clave equivocada** + **un race de refs** — que se manifestaron como:

1. **Ediciones que se revertían** (~90s con la consolidación)
2. **Ediciones que se revertían** (~1s con el race del resync)
3. **Creaciones que desaparecían de inmediato** (el colapso del estado: 1302→290)

**Estado final**: los 4 movers de balance stamp-ean el account, los accruals stamp-ean sus txs, el dedupe de intereses usa la clave exacta con best-per-group, el accrue ya no churna, y el resync cuenta el `_dirty` render-confirmado.

---

## 🌊 CRONOLOGÍA

### W35 — Ediciones que se revertían (~90s) `143b3c4`
**Reporte**: el usuario edita una transacción (cambia la cuenta); minutos después vuelve a la original.

**Causa**: `update_transaction` editaba el tx **sin `_updatedAt`** → en el `mergeById` del server, empate 0vs0 → **gana el existente** (pre-edición) → el siguiente snapshot revertía la edición.

**Fix**: `const next = { ...old, ...patch, _updatedAt: Date.now() }` en `update_transaction` + el mismo bump en `update_account`, `update_crypto`, `update_realestate`, `update_depreciating`.

### W36 — El balance que volvía atrás `e69c6ff`
**Reporte**: la edición del accountId (Intereses de Wallet → PlataInv) "no se aplicaba" — PlataInv quedaba en 0.

**Causa**: `update_transaction` movía el balance ✓ (de-acreditar la vieja, acreditar la nueva) **pero sin bump-ear el `_updatedAt` de las accounts movidas** → `mergeById` de accounts: empate → **el balance movido volvía atrás** en el siguiente snapshot.

**Fix**: bump `_updatedAt: Date.now()` en las accounts tocadas por los **4 movers** (`add_transaction`, `update_transaction`, `delete_transaction`, `transfer`).

### W37 — Los duplicados de intereses + el primer restore `febb4d1`
**Reporte**: 103 txs "Intereses +10.42" duplicadas con `_updatedAt = 1970 (EPOC)`.

**Causas**:
- `interest.ts` (el accrual) creaba txs **sin `_updatedAt`** (EPOC)
- El dedupe (`dedupeAutoInterest` en `api/_merge.js`) usaba la clave compuesta **con la descripción**: las 3 rutas de interés (normal / aplazados / ISR) describen el MISMO interés con textos distintos → las 3 copias sobrevivían
- El accrue re-creaba el account con `lastAccrual: now` **en cada corrida (60s)** → churn del syncable → push cada 60s → **el loop hydrate/push entre devices** (los pushes v721→v728 regulares en el log)

**Fixes**: stamping de los accrual txs + el dedupe por (cuenta, fecha) sin la descripción + el accrue sin churn (el account solo se re-crea si los valores cambiaron) + **la limpieza server-side**: `scripts/clean-interests-w37.mjs` — 153 duplicados removidos, 805 EPOC normalizados, v739.

### W37b/c — LA SOBRE-CORRECCIÓN DAÑINA `dbf32d4`
**Error mío**: extendí el dedupe a "por categoría sin el requisito `auto`" **y quité el importe de la clave** — eso fusionó variantes **semánticamente distintas** (10.42 ganancia vs 10.43 ISR-capped) y el consolidado borró **594 entradas legítimas** → **el colapso 884→290** en producción.

### W37d — ROLLBACK + RESTORE `935b9d4`
**Fix 1**: la clave vuelve a **(cuenta, fecha, IMPORTE)** — solo las copias exactas dedupan; el best-per-group por `_updatedAt` SE QUEDA (la edición más nueva gana).

**Fix 2 (RESTORE)**: `scripts/restore-w37d.mjs` — unión con el backup W29 por ID: **290 → 1302 txs restauradas** (las borradas vuelven, las ediciones recientes ganan).

### W37e — EMERGENCIA: el colapso volvió (290→1302→290) `3fcaa37`
**Reporte**: el usuario re-créa transacciones y **se borraban de inmediato**; el estado del server colapsó de nuevo a 290 (v773).

**Causa**: la implementación best-per-group del W37d tenía **los lookups de posición mal alineados**: el contador `o` del output contaba TODAS las entradas pero las llaves saltaban los duplicados → **tras el primer duplicado, los lookups divergían y el dedupe se comía las entradas siguientes** — activo en CADA consolidate (el server).

**Fix**: implementación **sin los lookups de posición** (alineación libre): el Map guarda la mejor copia por clave; el output empuja solo la mejor **por identidad** (`best.get(key) === t`) — imposible que coma entradas.

**RESTORE #2**: 290 → **1302** (v774). + el regression test del colapso (300 vecinos + duplicados intercalados → ninguna pérdida).

### W37e-fix — El race del resync (<1.5s) `a3f1705`
**Reporte**: la edición se revertía en **1 segundo** (no en el ciclo de consolidación).

**Causa**: el `resyncNow` del focus/heartbeat podía correr **racando el render** de la edición: el `syncableRef` seguía apuntando al estado PRE-edición (el ref se actualiza en el render) → la empate de refs decía "sin pendientes" → **el hydrate aplicaba el snapshot PRE-edición** → la edición moría localmente antes de llegar a cualquier merge.

**Fix**: el pending del resync ahora cuenta **el `_dirty` del `stateRef` (render-confirmado)**:
```js
const dirty = stateRef.current._dirty || syncableRef.current !== lastPushedRef.current;
```
Con la edición pendiente, el resync **fuerza el push primero** → re-fetch (el snapshot con la edición) → el hydrate aplica CON la edición. El push fallido aborta (W24).

### W37e-doc — La causa raíz del colapso persistente `c1bc9bb`
**Reporte**: la edición SEGUÍA revertiéndose tras todos los fixes.

**Hallazgo forense decisivo**: el proceso del server (STARTED 04:19) nunca se reinició tras el fix W37e (escrito en disco 04:31) → **17h ejecutando el dedupe ROTO en memoria** → colapso del estado (1302→291) + ediciones droppeadas en cada consolidate. También se descubrió el **tombstone** como vector de borrado real (`deletedTransactions[sdb8ls4c] = 21:57:21`): `mergeStates` elimina PERMANENTEMENTE las txs tombstonadas y el union de tombstones los propaga entre devices.

**Fix**: `systemctl restart misfinanzas-server` (el módulo correcto se cargó) + restore. **Lección L0: tras un deploy server-side, verificar el STARTED del proceso, no solo `systemctl is-active`** — el proceso puede seguir corriendo el código viejo en memoria.

### W37f — La causa estructural final: el push no adoptaba la versión `fccc100`
**Reporte**: la edición seguía revertiéndose incluso con el server correcto.

**Hallazgo**: el log mostró el **loop infinito de versiones** (v853→v862, 9 pushes en 2 min con el MISMO delta bytes=383425). El `pushNow` del cliente NO adoptaba el estado/versión consolidado que devuelve el server (el protocolo W23 lo manda, pero nunca se conectó):
```
push → server v++ → la versión LOCAL queda stale
→ heartbeat: server v ≠ local v → resync → hydrate (versión local = server)
→ la versión cambia → syncable cambia → push → server v++ → (repetición)
```
Y en ese loop, un resync podía hydrate un snapshot **pre-edición** (el fetch antes del push de la edición) → el revert.

**Fix**: `pushWithRetry` devuelve el `body`; `pushNow` ahora **hydrata con el estado/versión del server** tras el push:
```js
if (res.body?.state) {
  skipPushRef.current = true;
  dispatch({ type: "hydrate", state: { ...migrate(res.body.state), ...volatile } });
}
```
→ la versión local siempre coincide con el server (el heartbeat no ve mismatch → no loop), y el estado consolidado (que YA incluye la edición) se adopta.

### W37g — LA CAUSA RAÍZ DEFINITIVA: dos reducers, el equivocado corregido `089d69b`
**Reporte**: la edición seguía revertiéndose DESPUÉS de W37f.

**Hallazgo forense definitivo (el que cierra todo)**: existen **DOS reducers**:
- `src/reducer.ts` — tipado, **solo lo usan los tests** (`reducer.test.js`, `syncHealth.test.js`)
- `src/store.jsx` — **el que React usa en producción** (`useReducer(reducer, ...)` en `StoreProvider`)

**Todos los fixes W35/W36/W37e se aplicaron a `reducer.ts` (el archivo equivocado).** La suite (596→603 tests) daba falsa confianza porque probaba `reducer.ts`. En `store.jsx`:
- `update_transaction` línea 196: `{ ...old, ...action.patch }` — **SIN `_updatedAt`** → el `mergeById` del server veía un empate → conservaba la versión pre-edición → **el server descartaba la edición**
- `add/delete/transfer`: movían saldos **sin stamp del account** → los balances revertían
- **`_dirty` NUNCA se seteaba** (el wrapper W24 no existía en store.jsx) → el guard del race (W37e) estaba muerto (leía `_dirty` siempre undefined)
- `mark_clean` se disparaba pero **no existía el case** → no-op

Y mi W37f (hydrate con la respuesta del server) **empeoraba** el síntoma: el cliente hydrate con el estado PRE-edición del server → el revert en <1 segundo (el reporte exacto del usuario).

**Fix (`089d69b`)**: aplicado a `store.jsx` (el archivo de producción):
- `update_transaction`: `{ ...old, ...patch, _updatedAt: Date.now() }` + stamp de las cuentas movidas
- `add_transaction`, `delete_transaction`, `transfer`: stamp de las cuentas (+ txs de transfer)
- Wrapper: `_dirty: true, _lastChangeAt: Date.now()` en toda mutación + `mark_clean` en skipVersion
- Case `mark_clean` + `hydrate` con `_dirty: false`
- **Export del reducer de store.jsx + test nuevo `src/storeReducer.test.js`** que cubre el reducer REAL (el gap)
- Fix colateral: test de reports date-robusto (el detector ignora cadencias >3 ciclos — rompía al avanzar el reloj)

---

## 🧠 MECÁNICA EXACTA (los 3 vectores de pérdida)

### Vector 1 — La edición sin stamp
```
edita (sin stamp) → push → mergeById: empate 0vs0 → gana el EXISTENTE
→ el server conserva el pre-edit → el siguiente snapshot REVERTE la edición
```

### Vector 2 — El balance sin stamp del account
```
update_transaction mueve el balance ✓ PERO el account sin stamp
→ mergeById de accounts: empate → el balance movido vuelve a 0
```

### Vector 3 — El race del resync
```
edita (t=0) → el resync del focus (t=0.4s) raca el render:
el syncableRef = PRE-edit → la empate: "sin pendientes" → NO fuerza el push
→ el hydrate con el snapshot PRE-edición → la edición muere en <1.5s
```

### Vector 4 — El dedupe que se comía el estado (W37d)
```
el dedupe: el Map best-per-group + los lookups de posición
el contador `o` cuenta TODAS, las llaves saltan los duplicados
→ tras el primer duplicado: o≠order → los lookups devuelven UNDEFINED
→ las entradas siguientes NO se empujan → el estado se come
```

---

## 📁 ARCHIVOS TOCADOS

| Archivo | Cambio |
|---|---|
| `src/reducer.ts` | Los 5 updaters + los 4 movers de balance stamp-ean `_updatedAt` |
| `src/interest.ts` | Los accrual txs stamp-ean; el accrue sin churn del account |
| `api/_merge.js` | `dedupeAutoInterest`: la clave (cuenta, fecha, IMPORTE), best-per-group por `_updatedAt`, sin los lookups de posición |
| `src/store.jsx` | El resyncNow: el pending cuenta `_dirty` (render-confirmado) |
| `src/reducer.test.js` | Los tests W35/W36 (la edición sobrevive el merge) |
| `src/server-merge.test.js` | Los tests W37 (el dedupe exacto + el colapso) |
| `scripts/clean-interests-w37.mjs` | La limpieza server (stamp EPOC + dedupe) |
| `scripts/restore-w37d.mjs` | El restore por unión con el backup |
| `scripts/w37-forensic.cjs` (tmp) | El forense de duplicados/EPOC |

---

## 🧠 LECCIONES PERMANENTES (nuevas)

| # | Lección |
|---|---|
| L0 | **LA CAUSA RAÍZ DEL COLAPSO**: el fix server-side (W37e) se escribió en disco (mtime 04:31) PERO el proceso del server (STARTED 04:19) **nunca se reinició** → 17h ejecutando el dedupe ROTO en memoria (colapso 1302→291 + ediciones droppeadas). **TRAS cada deploy server-side: verificar el STARTED del proceso, no solo `systemctl is-active`** |
| L0b | **LA CAUSA ESTRUCTURAL DEL REVERT**: el push no adoptaba el estado/versión consolidado del server (W23 lo manda, nunca se conectó) → la versión local stale → heartbeat → resync/hydrate → versión cambia → push → **loop infinito de versiones** (v853→v862) + hydrate con snapshots pre-edición. **El push DEBE hydrate con la respuesta del server** |
| L1 | **Toda entidad que viaja en el sync y puede editarse DEBE bump-ear `_updatedAt`** al mutarse — sin el bump, `mergeById` conserva la copia vieja (empate 0vs0) |
| L2 | **Los movers de balance bump-ean TAMBIÉN el account** — el tx y el account son dos entidades con dos stamps |
| L3 | **El dedupe de la clase interés**: clave `(cuenta, fecha, IMPORTE)` — SIN la descripción (las rutas describen lo mismo) y CON el importe (las variantes de centavos ISR son intereses DISTINTOS) |
| L4 | **El best-per-group SIN los lookups de posición**: `best.get(key) === t` por identidad — los contadores paralelos (order/o) se desalinean con los duplicados y comen el estado |
| L5 | **El accrue no churna**: el account solo se re-crea si los valores cambiaron — `lastAccrual: now` sin cambio = sin objeto nuevo = sin push cada 60s |
| L6 | **El pending del resync = `_dirty` (render-confirmado) || la empate de refs** — la empate sola raca las ediciones en la ventana dispatch→render |
| L7 | **La sobre-corrección daña**: extender la clave del dedupe (quitar el importe) fusionó intereses DISTINTOS — la extensión de una regla necesita su propio test de daño |
| L8 | **El restore por unión**: mergeById(backup, actual) por ID — las borradas vuelven, las ediciones (stamps nuevos) ganan — el backup + la unión = el recovery sin pérdida |

---

## ✅ ESTADO FINAL

| Métrica | Valor |
|---|---|
| Suite | **603/603** ✅ (incluye el test del reducer REAL de store.jsx) |
| Server | v863 (estable con el proceso correcto), 1302 txs, EPOC 0 |
| Commits | 11 (W35 → W37g) |
| Los 5 vectores de pérdida | Cerrados con tests de regresión |

## 📎 También en esta sesión
- **`e50024b` — review-loop allowlist ampliada**: `node --test`, `node scripts/`, `mkdir -p`, `echo`, `cat` + extracción del comando principal antes de pipes/redirecciones (para los AC de los issues del loop).

## 🔁 SI EL PROBLEMA VUELVE

1. `node /tmp/w37-final.cjs` (en el VPS) — el forense: v, txs, EPOC, duplicados
2. Si el estado colapsa de nuevo: `node scripts/restore-w37d.mjs` (la unión con el backup)
3. Si los duplicados vuelven: `node scripts/clean-interests-w37.mjs` + verificar que el server corra con el `_merge.js` nuevo (restart tras deploy)
4. La cadena de diagnosis: el log `[push]` (los bytes idénticos = el estado no cambia) → el console `[sync]` del navegador (la secuencia push/resync/hydrate) → el forense del localStorage (W29: UTF-16LE + framing LevelDB)
