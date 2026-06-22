# Contexto Activo — Mis Finanzas v1.0.0 / Sesión 2

## Estado del Proyecto
- **Versión**: 1.0.0
- **Sesión**: 2 (cerrada)
- **Sprint activo**: NINGUNO

## Última Sesión (2026-06-20)
### Completado
- Añadido % a las tarjetas de Proyección / mes y Proyección / año en Dashboard
- Corregido devengo de intereses en modelo capped:
  - Fix: balanceCap2 ahora usa > 0 para activar segundo tramo (OBMIO, OBMOM, REVOLUTALE)
  - Fix: año comercial 360 días (en lugar de 365) para cuentas MXN capped
  - Fix: ISR reducido 0.0524% anual para cuentas MXN investment
  - Fix: OBmio cambiado de `investment` a `sofipo` (no genera ISR)
  - Fix: rate2 de OBmio ajustado a 7.3%
- Datos sincronizados a Vercel Blob (sync ID: 6c1f6e95-3cc4-4a3d-999a-5eded8789c52)
- Archivos de memoria creados: CONTEXTO.md, DECISIONS.md, sessions.jsonl

### Pendiente
- Tests unitarios para reducer (accrueInterest, transfer, FX conversion)
- Evaluar Web Workers para tick_prices
- Migrar categorización a embeddings semánticos

## Decisiones Técnicas
| Decisión | Razón | Alternativa |
|----------|-------|-------------|
| Año comercial 360 días para MXN capped | Bancos mexicanos usan base 360/30 | 365 (producía interés incorrecto) |
| MXN_INVESTMENT_TAX_RATE = 0.0524% | Tasa real que descuenta el banco | 0.9% (genérico SAT, no aplica a estos instrumentos) |
| OBmio como `sofipo` | No paga ISR, coincide con comportamiento real | `investment` (generaba ISR incorrecto) |

## Próximos Pasos — Prioridad
1. 🟡 Verificar que mañana el devengo genere MX$16.72/día en OBmio
2. 🟡 Tests unitarios para reducer
3. 🟢 Evaluar Web Workers para tick_prices

---
*Cierre de sesión: 2026-06-20*