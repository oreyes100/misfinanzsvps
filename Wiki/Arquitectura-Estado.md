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
| `tick_prices` | Simulación mercado cada 4s (random walk) | Media |
| `add_transaction` | Crea transacción + actualiza balance cuenta | Media |
| `transfer` | Transferencia entre cuentas + conversión FX | Alta |
| `accrue` | Devengo intereses (diario/mensual) | Alta |
| `schedule_transfer` | Programa transferencia futura | Baja |
| `restore` | Merge estado cloud + local + accrue | Media |
| `reset` | Vuelve a SEED + accrue | Baja |

## Persistencia
- **localStorage**: key `mis-finazas-v1` (todo menos `priceHistory`)
- **Sync Cloud**: `syncableSlice()` excluye `priceHistory` + `fx` vivo
- **Debounce**: 1.5s ante cambios relevantes
- **Conflict Resolution**: Pull cloud → merge → push (last-write-wins simple)

## Market Simulation
- `tick_prices` cada 4s: random walk suave (FX ±0.2%, Crypto ±1.2%, Gold ±0.4%)
- `priceHistory`: buffer 60 puntos (ventana deslizante)
- `accrue` cada 60s: detecta cambio de día + devengo intereses

## Implicaciones para Agentes
1. **Nunca modificar `store.jsx` sin `npm run build`** — 548 líneas, acoplamiento alto
2. **Estado serializable** — Todas las actions devuelven nuevo estado inmutable
3. **FX vivo no persiste** — `syncableSlice()` lo excluye deliberadamente
4. **Intereses automáticos** — `accrueInterest()` se ejecuta en `hydrate`, `reset`, `accrue`, y al abrir app

> Fuente: `src/store.jsx` (líneas 16-60 SEED, 66-112 accrueInterest, 116-363 reducer, 383-498 StoreProvider)

---

## 🔗 Enlaces Relacionados
- [[MOC-Mis-Finanzas]] — Mapa de contenido principal
- [[Sync-Cloud]] — Sincronización Vercel Blob