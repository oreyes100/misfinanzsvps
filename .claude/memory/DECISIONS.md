# Decisiones Arquitectónicas — Mis Finanzas
> Inmutables una vez cerradas. No re-debatir sin aprobación explícita.

| Fecha | Decisión | Razón | Alternativa Desestimada |
|-------|----------|-------|-------------------------|
| 2026-06-19 | React 19 + Vite 6 + Tailwind v4 | Stack moderno, tree-shaking, performance | Next.js (overkill para SPA) |
| 2026-06-19 | localStorage `mis-finazas-v1` + Vercel Blob sync | Offline-first, bajo costo, simple | Supabase / Firebase (costo, complejidad) |
| 2026-06-19 | Categorización por reglas (utils.js) | Latencia cero, determinista | Embeddings API (latencia, costo) |
| 2026-06-19 | RTK filter + JIT loading para token efficiency | 70%+ reducción tokens | Cargar todo el contexto siempre |