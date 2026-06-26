---
title: Portfolio Multiactivo — Mis Finanzas
tags: [portfolio, activos, inversion, crypto, oro, inmuebles]
source: src/store.jsx (SEED assets + reducer CRUD) + src/components/Charts.jsx + Dashboard.jsx
---

# Portfolio Multiactivo — Mis Finanzas

## Estructura
Los activos viven en `state.assets` con 4 categorías:

### Crypto
```javascript
crypto: [{ id, symbol, name, qty, costBasisEUR }]
```
- Precio en vivo via `tick_prices` (BTC, ETH)
- Valor actual: `qty * fx[symbol]`
- Plusvalía: valor actual - costBasisEUR

### Gold
```javascript
gold: { grams, costBasisEUR }
```
- Precio en vivo: `state.goldPriceEUR` (€/gramo, random walk ±0.4%)
- Valor actual: `grams * goldPriceEUR`
- Histórico: `priceHistory.GOLD` (48-60 puntos)

### Real Estate
```javascript
realEstate: [{ id, name, valueEUR, costBasisEUR, source, featured }]
```
- Valoración manual con `source` (API externa, simulación)
- Una propiedad destacada (`featured`) en el dashboard
- La primera propiedad agregada se destaca automáticamente

### Depreciating Assets
```javascript
depreciating: [{ id, name, kind, valueEUR, costBasisEUR, depRate }]
```
- `kind`: tipo de activo (`auto`, `electronics`, etc.)
- `depRate`: tasa de depreciación anual (decimal, ej: 0.15 = 15%)
- NO se deprecia automáticamente — el rate es informativo (pendiente implementación)

## Reducer CRUD por Tipo
Cada tipo tiene actions independientes en el reducer:

| Asset | Add | Update | Delete | Extra |
|-------|-----|--------|--------|-------|
| Crypto | `add_crypto` | `update_crypto` | `delete_crypto` | — |
| Gold | — | `update_gold` | — | Solo update |
| Real Estate | `add_realestate` | `update_realestate` | `delete_realestate` | `set_featured_realestate` |
| Depreciating | `add_depreciating` | `update_depreciating` | `delete_depreciating` | — |

## Dashboard Display (Bento Grid)
- **Patrimonio dominante**: suma total en EUR de todos los activos + saldos cuentas
- **Tarjetas individuales**: crypto, gold, realEstate — cada una con valor en EUR y plusvalía
- **Donut chart**: distribución del portfolio por tipo de activo
- **Proyección**: tarjetas de proyección mensual y anual

## Edge Cases
- **delete_realestate con featured**: el primer restante se destaca automáticamente
- **crypto sin qty**: no crash, muestra 0
- **gold sin grams**: seed default 45g
- **depreciating undefined**: `|| []` en reducer protege acceso
- **costBasisEUR**: base para cálculo de plusvalía — no se actualiza automáticamente

> Fuente: `src/store.jsx` líneas 32-44 (SEED assets), 241-295 (reducer CRUD assets), `src/components/Charts.jsx` (gráficos)
