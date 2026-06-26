---
title: Intereses Automáticos — Mis Finanzas
tags: [intereses, devengo, accrual, tae, capped]
source: src/interest.js + src/store.jsx (accrue, hydrate, restore, reset)
---

# Intereses Automáticos — Mis Finanzas

## Arquitectura
El devengo de intereses vive en `src/interest.js` — módulo puro sin dependencias React/DOM, importable desde `store.jsx` y `scripts/recalc-intereses.mjs`.

`accrueInterest(state)`: función pura que recibe el estado actual, calcula intereses pendientes para cada cuenta, y devuelve nuevo estado con saldos actualizados + transacciones de intereses.

## Disparadores
Se ejecuta en 4 momentos:
| Trigger | Contexto | Por qué |
|---------|----------|---------|
| `hydrate` | Carga inicial (localStorage) | Aplicar intereses acumulados offline |
| `accrue` | Timer cada 60s | Devengo en tiempo real |
| `restore` | Sync cloud pull | Sincronizar intereses tras merge |
| `reset` | Reset a SEED | Estado fresco con intereses calculados |

## Modelo de Devengo

### Cuentas Simples (checking/savings/deposit)
```javascript
interés = balance * rate * (daysDesdeUltimoDevengo / 365)
```

### Cuentas Capped (MXN investment/sofipo)
Modelo de 2 tramos acumulativos con tope:
- **Tramo 1**: saldo hasta `balanceCap1` gana `rate1`
- **Tramo 2**: exceso hasta `balanceCap2` adicional gana `rate2`
- **Año comercial**: 360 días (base bancaria mexicana)
- **ISR**: impuesto anual prorrateado a la frecuencia del tramo
- **Gain caps**: topes de por vida — al alcanzarlos, el tramo deja de generar

### Frecuencias
- `daily`: devengo cada día calendario
- `monthly`: devengo cada ~30 días
- Regla: si `daysDesdeUltimo >= daysPorFrecuencia`, se devenga

### Deposit Date
Sábados → lunes; domingos → lunes (para que finde se acumule en una sola transacción).

## Edge Cases
- **Restore sin cuentas**: `accrueInterest` itera sobre `state.accounts[]` vacío → no-op
- **Gain cap alcanzado**: el tramo deja de generar pero el otro tramo sigue
- **rate = 0**: skip (checked in `accrueCapped`)
- **balance negativo**: interés negativo (deuda técnica — no implementado aún)
- **lastAccrual futuro**: `daysBetween` devuelve 0, no crash

> Fuente: `src/interest.js` (189 líneas, función `accrueInterest` + `accrueCapped` + helpers), `src/store.jsx` líneas 178-179 (accrue case)
