---
title: Multi-Moneda y FX — Mis Finanzas
tags: [moneda, fx, conversion, forex, tasa-cambio]
source: src/utils.js (BASE_FX, convert, toEUR) + src/store.jsx (tick_prices, transfer)
---

# Multi-Moneda y FX — Mis Finanzas

## Divisas Soportadas
6 divisas en `CURRENCIES`: EUR · USD · GBP · MXN · BTC · ETH

## Tasas de Cambio
Todas expresadas como "1 unidad de la divisa en EUR":
```javascript
BASE_FX = { EUR: 1, USD: 0.92, GBP: 1.17, MXN: 0.05, BTC: 61500, ETH: 3120 }
```

- **FX vivo**: muta cada 4s vía `tick_prices` (random walk suave)
- **FX al inicio**: se restablece desde `BASE_FX` al cargar (`load()` → `{ ...BASE_FX, ...saved.fx }`)
- **No persiste**: `syncableSlice()` excluye `fx` deliberadamente — cada sesión arranca desde BASE_FX

## Conversión
```javascript
convert(amount, from, to, fx)  // amount * fx[from] / fx[to]
toEUR(amount, currency, fx)    // amount * fx[currency]
```

Usada en:
- **Transferencias** (`transfer` en reducer): cuando `from.currency !== to.currency`, aplica `amount * fx[from] / fx[to]`
- **Cálculo de patrimonio**: sumar saldos en EUR via `toEUR()`
- **Dashboard**: conversión automática al consolidar inversiones

## Simulación de Mercado (`tick_prices`)
Cada 4s aplica jitter (paseo aleatorio suave) a cada tipo:
| Divisa | Volatilidad por tick |
|--------|---------------------|
| USD, GBP | ±0.2% |
| MXN | ±0.3% |
| BTC | ±1.2% |
| ETH | ±1.4% |
| Gold (€/g) | ±0.4% |

Histórico: 48 puntos para gráficos (LineChart), ventana deslizante de 60.

## Edge Cases en Transferencias Multi-Moneda
- **Misma divisa**: crédito = amount, sin conversión
- **Divisa distinta**: crédito = `amount * fx[from] / fx[to]` — redondeo a 2 decimales bancarios
- **amount <= 0**: no-op (validación en `transfer`)
- **fromId o toId no existen**: no-op
- Se generan 2 transacciones (salida + entrada) con `counterpartId` para trazabilidad

> Fuente: `src/utils.js` líneas 9-36 (BASE_FX, convert, toEUR), `src/store.jsx` líneas 75-98 (tick_prices), 137-157 (transfer)
