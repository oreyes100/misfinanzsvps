# Agentic Behavior Layer — Mis Finanzas

## Identidad del Proyecto
**Mis Finanzas** — MVP finanzas personales avanzado: React 19 · Tailwind CSS v4 · Framer Motion · Vercel Blob Sync.
Producción: https://mis-finazas-gold.vercel.app (Vercel Hobby). Redeploy: `vercel --prod`.

## Stack Técnico Inmutable
- **Frontend**: React 19 + Vite 6 + Tailwind CSS v4 (@tailwindcss/vite)
- **Estado**: useReducer + Context (store.jsx) + localStorage persistence
- **Sync Cloud**: Vercel Functions + Vercel Blob (store `mis-finazas-db`) — api/sync.js
- **IA**: Categorización por reglas (utils.js) + Asistente agéntico human-in-the-loop (Assistant.jsx) + Voice (Web Speech API) + OCR (tesseract.js)
- **Gráficos**: SVG accesibles (Charts.jsx) — LineChart, PieChart
- **Animaciones**: Framer Motion 12 (micro-interacciones <300ms)

## Arquitectura de Estado (store.jsx)
- **SEED**: Estado semilla con cuentas, assets (crypto, gold, realEstate, depreciating), transacciones, categorías, FX simulado
- **Reducer**: 30+ action types (hydrate, tick_prices, add_transaction, transfer, accrue, schedule_transfer, CRUD accounts/categories/assets, sync, restore, reset)
- **Persistencia**: localStorage key `mis-finazas-v1` (excluye priceHistory)
- **Sync**: Debounce 1.5s, UUID como llave, pull/push automático, conflict resolution simple
- **Market Simulation**: tick_prices cada 4s (random walk suave), accrue cada 60s

## Formato de Salida Obligatorio
- **Conciso**, bullets, **sin intro genérica** ("Como asistente de IA..."), **sin summary final**
- Código: completo, listo para producción, sin placeholders
- Decisiones: 1 línea de veredicto + 3 razones + 1 riesgo

## Restricciones Permanentes (NEGATIVE CONSTRAINTS)
- NO usar `sudo` sin pedirlo explícitamente
- NO usar datos mock en código de producción — usar APIs reales o simulación documentada
- NO hardcodear valores que vayan en Settings (divisa base, límite gasto, tasas, frecuencias)
- NO modificar `store.jsx` sin ejecutar `vault_lint.py` y verificar build (`npm run build`)
- NO hacer push sin `npm run build` exitoso
- NO asumir contexto: **Context-First** — leer Wiki/ + CLAUDE.md + CONTEXTO.md antes de proponer cambios
- NO expansiones de output: **TERMINATION** — parar cuando se cumple la condición, no resumir

## Glosario del Proyecto
| Término | Significado en este contexto |
|---------|------------------------------|
| `SEED` | Estado inicial semilla (accounts, assets, transactions, categories, FX) |
| `accrueInterest` | Función que calcula y registra intereses pendientes (diario/mensual) |
| `tick_prices` | Simulación de mercado cada 4s (random walk FX, crypto, gold) |
| `syncableSlice` | Subconjunto del estado que viaja a la nube (sin priceHistory/FX vivo) |
| `transferAliases` | Aprendizaje OCR: texto normalizado → accountId |
| `Bento Grid` | Dashboard asimétrico: patrimonio (dominante), crypto, gold, realEstate, límite, cuentas, donut |
| `Human-in-the-loop` | IA previsualiza acción (gasto, transferencia, programada, límite) → usuario aprueba → ejecuta |

## Skills Activas (en .claude/agents/)
- `/boot` — Inicializa sesión: carga invariantes, memoria, objetivos
- `/close` — Cierra sesión: scorecard, persiste correcciones, git sync, lint

## Top Of Mind (actualizado en /close)
1. Optimizar rendimiento de `tick_prices` (4s) — evaluar Web Workers
2. Migrar categorización IA de reglas a embedding semántico
3. Tests unitarios para reducer (accrueInterest, transfer, FX conversion)