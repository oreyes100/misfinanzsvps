# CONTEXTO.md — Estado Consciente Mis Finanzas
> Actualizado en cada `/close`. Leído en cada `/boot`.
> Contiene: estado actual, decisiones, next actions, Top Of Mind.

---

## 📅 Última Actualización
**Fecha**: 2026-06-25
**Sesión**: Fase 2 — TypeScript, tests, seguridad, FX real

---

## 🎯 Estado Actual del Proyecto
- **Proyecto**: Mis Finanzas — MVP finanzas personales avanzado
- **Stack**: React 19 + Tailwind CSS v4 + Framer Motion + Vite 6
- **Deploy**: Vercel (producción: https://mis-finazas-gold.vercel.app)
- **Sync**: Vercel Functions + Blob Store `mis-finazas-db`
- **Estado local**: localStorage key `mis-finazas-v1`
- **Build**: `npm run build` — verificado funcionando

---

## ✅ Qué se Completó (Esta Sesión)
1. **TypeScript**: `reducer.ts`, `utils.ts`, `interest.ts`, `migrations.ts`, `types.ts` — strict mode, JS deleted
2. **Vitest**: 103 tests (47 reducer + 39 utils + 17 interest), `npm test` ~130ms
3. **Seguridad**: PBKDF2+salt (100k iter), setupAdmin en first boot, CORS restringido, API users sanitizada
4. **FX real**: `useFX` hook (Frankfurter + Coingecko cada 30 min), `tick_prices` eliminado
5. **Sync conflict resolution**: `mergeByID()` con `_updatedAt`, `_syncVersion` tracking
6. **Perf**: localStorage debounce 1.5s, selectors extraídos (Fast Refresh), React.lazy(Assistant+Auditoria) ~32kB
7. **Wiki actualizada**: Arquitectura-Estado.md, +4 nuevas notas (Cuentas-Tipos, Multi-Moneda, Portfolio-Multiactivo, Intereses-Automaticos)
8. **Base conocimiento**: CLAUDE.md (TS/Vitest/FX/seguridad), cost-optimization.md, `/wiki` agent
9. **Build + Deploy**: `npm run build` ✅ (958ms), Git push → Vercel prod aliased

---

## 🔄 Decisiones Técnicas Tomadas
| Decisión | Razón | Alternativa Desestimada |
|----------|-------|------------------------|
| TypeScript en módulos puros (no JSX) | React 19 + Vite 6 manejan JSX nativamente | TSX en componentes (fricción build) |
| `useFX` con APIs reales vs tick_prices | Random walk no aporta valor real | Simulación 4s (random walk sin señal) |
| `mergeByID()` con `_updatedAt` | Resolución correcta de conflictos sync | Last-write-wins bruto (pierde datos) |
| PBKDF2+salt en cliente (sin backend) | Única opción para app 100% frontend | Enviar hash a server (sin servidor propio) |
| Vitest vs Jest | 10-20x más rápido, mismo API, ESM nativo | Jest (config compleja, lento) |
| localStorage debounce + clave estable | Evita writes innecesarios (FX/priceHistory) | Escribir en cada cambio de estado |
| `/wiki` agent skill | Distilación a demanda, token-eficiente | Wiki batch monolítica |

---

## ⏭️ Next Actions (Priorizadas, máx 3)
1. **API oro real** — reemplazar `goldPriceEUR` fijo (68.4 €/g) con API real (e.g. gold-api.com)
2. **Tests de integración sync cloud** — pull/push/conflict en CI
3. **Migrar categorización IA** — de reglas a embedding semántico + few-shot

---

## 🧠 Top Of Mind (para próxima sesión)
1. **API oro real** — goldPriceEUR fijo → API real
2. **Test de sync cloud** — integración pull/push/conflict
3. **Categorización IA semántica** — embedding/local LLM

---

## 📚 Referencias Rápidas
- `CLAUDE.md` — BIOS completa (invariantas, stack, restricciones, glosario)
- `src/store.jsx` — Provider con useFX, debounced localStorage, sync mergeByID
- `src/reducer.ts` — 30+ action types, `_syncVersion` wrapper, mergeByID
- `src/utils.ts` — FX, categorización IA, parser NL, formato
- `src/useFX.js` — Tasas reales Frankfurter + Coingecko (reemplaza tick_prices)
- `src/selectors.js` — netWorthEUR, monthSpend, currentCycle, pendingCardPayments
- `src/auth.js` — PBKDF2+salt, setupAdmin, migrate SHA-256 legacy
- `src/types.ts` — Interfaces del dominio
- `api/sync.js` — CORS restringido, merge por ID, _syncVersion
- `api/users.js` — CORS restringido, GET sanitizado
- `Wiki/Arquitectura-Estado.md` — Estado global + reducer actions + useFX
- `Wiki/Sync-Cloud.md` — Sync Vercel Blob + UUID + syncableSlice
- `Wiki/MCP-Config.md` — Configuración MCP
- `MOCs/MOC-Mis-Finanzas.md` — Navegación temática Wiki ↔ src/