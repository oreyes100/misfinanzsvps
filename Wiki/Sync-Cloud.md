---
title: Sync Cloud Mis Finanzas
tags: [sync, cloud, vercel, blob, api]
source: api/sync.js + src/store.jsx (sync logic) + README.md
---

# Sincronización en la Nube — Mis Finanzas

## Arquitectura
```
┌─────────────┐     HTTPS      ┌──────────────┐     ┌─────────────┐
│  Cliente    │ ◄────────────► │ Vercel Func  │ ◄─► │ Vercel Blob │
│ (React)     │  GET/POST      │ api/sync.js  │     │ mis-finazas-db│
└─────────────┘                └──────────────┘     └─────────────┘
```

## Flujo de Datos

### Pull (GET `/api/sync?id=<UUID>`)
1. Cliente envía UUID (generado en `Settings.jsx` → `sync.enable()`)
2. Server busca blob `mis-finazas-db/<UUID>.json`
3. Si existe: retorna `{ found: true, state: {...} }`
4. Si no existe: retorna `{ found: false }` → cliente hace push inicial
5. **Cache-buster**: `?t=<timestamp>` en primer GET para evitar 404 cacheados por CDN

### Push (POST `/api/sync?id=<UUID>`)
1. Cliente envía `syncableSlice(state)` como JSON
2. Server escribe/actualiza blob `mis-finazas-db/<UUID>.json`
3. Retorna 200 OK

## syncableSlice — Qué Viaja a la Nube
```javascript
{
  settings,      // baseCurrency, spendLimit, biometric
  accounts,      // balances, tasas, lastAccrual
  assets,        // crypto, gold, realEstate, depreciating
  transactions,  // historial completo
  scheduled,     // transferencias programadas
  categories,    // CRUD categorías + keywords IA
  transferAliases // aprendizaje OCR: texto → accountId
}
```
**EXCLUIDO deliberadamente**: `priceHistory` (60 pts × 3 series), `fx` vivo, `goldPriceEUR` — se regeneran en cliente via `tick_prices`.

## Ciclo de Vida en Cliente (store.jsx)
- **Activación**: `sync.enable()` → genera UUID → `localStorage.setItem(SYNC_KEY)` → `pull` automático
- **Pull**: Si cloud tiene datos → `hydrate` + `accrueInterest` → `synced`
- **Push automático**: `useEffect` con debounce 1.5s en `syncable` (JSON stringificado)
- **Estados UI**: `off` → `pulling` → `synced` | `pushing` → `synced` | `error`

## Seguridad
- UUID como **llave única** (16-64 chars, alphanum + hyphen)
- Blob **privado** (no público) — solo accesible vía Function con el ID
- Sin autenticación de usuario — seguridad por obscuridad del UUID
- **Tradeoff**: Simplicidad vs. control de acceso granular

## Desarrollo Local
- `vite.config.js` proxy: `/api` → `https://mis-finazas-gold.vercel.app`
- Permite probar sync real en `npm run dev` sin deploy

> Fuente: `api/sync.js` (56 líneas), `src/store.jsx` líneas 381-498 (sync logic), `vite.config.js`

---

## 🔗 Enlaces Relacionados
- [[MOC-Mis-Finanzas]] — Mapa de contenido principal
- [[Arquitectura-Estado]] — Estado global y syncableSlice