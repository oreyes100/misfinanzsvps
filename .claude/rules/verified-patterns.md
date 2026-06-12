# Verified Patterns — Mis Finanzas
> Patrones confirmados en 3+ sesiones. Fuente de verdad para decisiones arquitecturales.
> Solo agregar tras validación. Nunca eliminar — tachar y fechar si se invalida.

---

## Reducer / Estado

**P1 — store.jsx requiere build verify antes de modificar**
- Regla: `npm run build` antes Y después de cualquier cambio en store.jsx
- Why: Tailwind CSS v4 + Vite 6 tienen tree-shaking agresivo; errores de reducer no siempre son visibles en dev
- Verify: `npm run build 2>&1 | tail -5`

**P2 — syncableSlice excluye priceHistory y FX en vivo**
- Regla: nunca incluir priceHistory en la clave que viaja a Vercel Blob
- Why: ~10x tamaño del payload; conflictos de merge frecuentes en datos de mercado
- Verify: grep "priceHistory" api/sync.js — no debe aparecer en el body enviado

**P3 — localStorage key es `mis-finazas-v1`**
- Regla: no cambiar sin migration path explícito
- Why: breaking change silencioso; usuarios pierden datos sin warning
- Verify: `localStorage.getItem('mis-finazas-v1')` en consola del browser

**P4 — tick_prices cada 4s corre en main thread**
- Regla: no agregar lógica pesada en el callback de tick_prices
- Why: 4s × operación costosa = jank perceptible (<50ms budget)
- Status: candidato a Web Workers (Top Of Mind #1)

---

## Sync Cloud

**P5 — Conflict resolution es "last write wins" via UUID**
- Regla: no implementar merge complejo sin evaluar impacto en Vercel Hobby limits
- Why: Vercel Hobby = 100GB-hours/month; merge costoso puede agotar quota
- Verify: revisar Vercel dashboard antes de cambios en api/sync.js

**P6 — Debounce sync es 1.5s**
- Regla: no bajar de 1s — Vercel Functions tiene cold starts de ~300ms
- Why: debounce < 1s genera race conditions con cold start
- Verify: Network tab en devtools — verificar que POST /api/sync no se dispara múltiple veces en escrituras rápidas

---

## IA / Asistente

**P7 — categorización es por reglas en utils.js, NO embeddings**
- Regla: no introducir llamadas a API externa en el clasificador sin feature flag
- Why: latencia de red en el path crítico de entrada de gastos
- Status: candidato a migración semántica (Top Of Mind #2)

**P8 — approve() es síncrono con el dispatch**
- Regla: no asumir que state refleja dispatch inmediatamente después de llamarlo
- Why: useReducer es asíncrono en React — el estado nuevo llega en el siguiente render
- Verify: leer state en un useEffect posterior, no inmediatamente después de dispatch

---

## Deploy

**P9 — deploy solo vía `vercel --prod` desde raíz**
- Regla: no hacer git push esperando auto-deploy sin verificar que Vercel está conectado al repo correcto
- Why: hobby plan a veces desconecta el webhook; hacer push no garantiza deploy
- Verify: `vercel ls` para confirmar último deployment exitoso
