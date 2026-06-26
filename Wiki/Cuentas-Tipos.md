---
title: Tipos de Cuenta — Mis Finanzas
tags: [cuentas, tipos, interes, tae]
source: src/store.jsx (SEED + reducer) + src/interest.js
---

# Tipos de Cuenta — Mis Finanzas

## Modelo de Datos
Cada cuenta en `state.accounts[]` tiene:
- `id` — UUID generado por `uid()`
- `name` — nombre para mostrar
- `type`: `checking` | `savings` | `deposit` | `credit`
- `currency` — EUR, USD, GBP, MXN
- `balance` — saldo actual (2 decimales, redondeo bancario)
- `rate` — TAE anual en decimal (0.045 = 4.5% APR)
- `accrual` — frecuencia de devengo: `none` | `daily` | `monthly`
- `lastAccrual` — última fecha ISO en que se calcularon intereses

## Tipos de Cuenta

| Tipo | Intereses | Uso típico |
|------|-----------|------------|
| `checking` | Sin intereses (rate=0) | Cuenta corriente: gastos diarios, nómina |
| `savings` | Rate configurable, daily/monthly | Ahorro con TAE |
| `deposit` | Rate fijo, monthly | Depósito a plazo (12m típico) |
| `credit` | Sin intereses | Tarjeta de crédito: tracking de deuda y pago |

## Cuentas Capped (MXN Investment / Sofipo)
Cuentas con tope escalonado de 2 tramos acumulativos:
- **Tramo 1**: saldo hasta `balanceCap1` gana `rate1`
- **Tramo 2**: saldo entre `balanceCap1` y `balanceCap1 + balanceCap2` gana `rate2`
- Por encima del tope: no genera intereses
- **Gain caps**: límite de por vida por tramo (`gainCap1`, `gainCap2`)
- **ISR**: impuesto configurable por cuenta (`isrRate`), prorrateado por frecuencia
- **Año comercial**: 360 días (base bancaria mexicana)

Campos adicionales para cuentas capped: `balanceCap1`, `balanceCap2`, `rate1`, `rate2`, `accrual1`, `accrual2`, `gainCap1`, `gainCap2`, `gainAccrued1`, `gainAccrued2`, `lastAccrual1`, `lastAccrual2`, `isrRate`.

Ver `src/interest.js` función `accrueCapped()`.

## Edge Cases en el Reducer
- **rate 0 → rate > 0**: `lastAccrual` se reinicia a hoy para evitar devengo retroactivo.
- **delete_account**: no reasigna transacciones — la cuenta desaparece y sus txs quedan huérfanas.
- **capped activado después**: `lastAccrual1/2` y `gainAccrued1/2` se inicializan en la fecha de activación.
- **mark_card_paid**: solo actualiza `lastPaidCycle` — no genera transacción.
- **add_account con datos incompletos**: `lastAccrual` se fija a hoy por defecto.

> Fuente: `src/store.jsx` líneas 27-31 (SEED), 181-215 (add/update/delete_account reducer cases), `src/interest.js` líneas 25-120 (accrueCapped)
