---
title: Arquitectura Estado Mis Finanzas
tags: [arquitectura, estado, store, reducer]
source: src/store.jsx + README.md
---

# Arquitectura de Estado — Mis Finanzas

## Visión General
El estado global vive en `src/store.jsx` usando **useReducer + Context + localStorage**. Es el **Single Source of Truth** para toda la app.

## Estructura del Estado (SEED)
```javascript
{
  settings: { baseCurrency, spendLimit, biometric },
  accounts: [{ id, name, type, currency, balance, rate, accrual, lastAccrual }],
  assets: {
    crypto: [{ id, symbol, name, qty, costBasisEUR }],
    gold: { grams, costBasisEUR },
    realEstate: [{ id, name, valueEUR, costBasisEUR, source, featured }],
    depreciating: [{ id, name, kind, valueEUR, costBasisEUR, depRate }]
  },
  transactions: [{ id, date, description, amount, currency, category, accountId, auto }],
  scheduled: [],
  categories: DEFAULT_CATEGORIES,
  transferAliases: {}, // OCR learning: texto normalizado → accountId
  fx: { ...BASE_FX },  // Tasas simuladas en vivo
  priceHistory: { BTC: [], ETH: [], GOLD: [] }, // 60 puntos para gráficos
  goldPriceEUR: 68.4
}
```

## Reducer — 30+ Action Types
| Acción | Propósito | Complejidad |
|--------|-----------|-------------|
| `hydrate` | Carga estado completo (sync/restore) | Baja |
| `update_fx` | Actualiza tasas FX reales desde API (useFX hook) | Baja |
| `add_transaction` | Crea transacción + actualiza balance cuenta | Media |
| `transfer` | Transferencia entre cuentas + conversión FX | Alta |
| `accrue` | Devengo intereses (diario/mensual) | Alta |
| `schedule_transfer` | Programa transferencia futura | Baja |
| `restore` | Merge estado cloud + local + accrue (mergeByID) | Alta |
| `reset` | Vuelve a SEED + accrue | Baja |

## Persistencia
- **localStorage**: key `mis-finazas-v1` — debounce 1.5s, clave estable que excluye `priceHistory`/`fx`/`goldPriceEUR`
- **Sync Cloud**: `syncableSlice()` incluye `_syncVersion` para conflict detection
- **Debounce**: 1.5s para localStorage y sync push
- **Conflict Resolution**: `mergeByID()` — fusiona colecciones por ID, conservando el `_updatedAt` más reciente
- **Versión**: `_syncVersion` incrementa en cada acción de usuario (no en `update_fx`/`accrue`)

## FX Reales (no simulación)
- `useFX` hook obtiene tasas reales de **Frankfurter API** (EUR/USD/GBP/MXN) + **Coingecko** (BTC/ETH)
- Refresco cada 30 minutos (no cada 4s)
- Fallback silencioso si no hay red — se mantienen últimas tasas conocidas
- `goldPriceEUR`: valor fijo (pendiente API oro)
- `priceHistory`: buffer 60 puntos (ventana deslizante), actualizado con cada fetch real
- `accrue` cada 60s: detecta cambio de día + devengo intereses

## Implicaciones para Agentes
1. **Lógica del reducer en TypeScript**: `reducer.ts` — `innerReducer()` pura + `reducer()` wrapper que incrementa `_syncVersion`. `types.ts` con interfaces del dominio
2. **Nunca modificar `store.jsx` sin `npm run build` + `npm test`** — 559 líneas, acoplamiento alto
3. **Estado serializable** — Todas las actions devuelven nuevo estado inmutable
4. **Conflictos de sync**: `mergeByID()` compara `_updatedAt`. Si agregas un action type nuevo, marca entidades con `_updatedAt: Date.now()`
5. **FX real vía useFX hook** — no simular random walk. Usar `update_fx` action type
6. **Auth**: PBKDF2 + salt (100k iteraciones). Sin contraseñas hardcodeadas. `setupAdmin()` en first boot
7. **Intereses automáticos** — `accrueInterest()` se ejecuta en `hydrate`, `reset`, `restore`, `accrue`, y al abrir app

> Fuente: `src/store.jsx` + `src/reducer.ts` + `src/types.ts` + `src/useFX.js` + `src/selectors.js`

---

## 🔗 Enlaces Relacionados
- [[MOC-Mis-Finanzas]] — Mapa de contenido principal
- [[Sync-Cloud]] — Sincronización Vercel Blob