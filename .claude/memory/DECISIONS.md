# Decisiones Arquitectónicas — Mis Finanzas
> Inmutables una vez cerradas. No re-debatir sin aprobación explícita.

| Fecha | Decisión | Razón | Alternativa Desestimada |
|-------|----------|-------|-------------------------|
| 2026-06-12 | React 19 + Vite 6 + Tailwind v4 | Stack moderno, tree-shaking, performance | Next.js (overkill para SPA) |
| 2026-06-12 | localStorage `mis-finazas-v1` + Vercel Blob sync | Offline-first, bajo costo, simple | Supabase / Firebase (costo, complejidad) |
| 2026-06-12 | Categorización por reglas (utils.js) | Latencia cero, determinista | Embeddings API (latencia, costo) |
| 2026-06-12 | RTK filter + JIT loading para token efficiency | 70%+ reducción tokens | Cargar todo el contexto siempre |
| 2026-06-25 | TypeScript en módulos puros (no JSX) | React 19 + Vite 6 manejan JSX nativamente | TSX en componentes (fricción build) |
| 2026-06-25 | `useFX` con APIs reales (Frankfurter + Coingecko) | Random walk no aporta valor real | Simulación 4s (random walk sin señal) |
| 2026-06-25 | `mergeByID()` con `_updatedAt` para conflictos sync | Resolución correcta de conflictos | Last-write-wins bruto (pierde datos) |
| 2026-06-25 | PBKDF2+salt en cliente (100k iter) | Única opción para app 100% frontend | Enviar hash a servidor (sin servidor propio) |
| 2026-06-25 | Vitest sobre Jest | 10-20x más rápido, ESM nativo, mismo API | Jest (config compleja, lento) |
| 2026-06-25 | localStorage debounce 1.5s + clave estable | Evita writes innecesarios (FX/priceHistory) | Escribir en cada cambio de estado |
| 2026-06-25 | `/wiki` agent skill para destilación a demanda | Token-eficiente, solo cuando se necesita | Wiki batch monolítica |
| 2026-07-06 | Methodology stack: Session Efficiency + Plan First + Learning Evolution + Engineering Excellence | Optimización de tokens, memoria persistente, calidad código | Sin metodología (amnesia contextual, refactors fallidos) |