# Agentic Behavior Layer — Mis Finanzas

## Identidad del Proyecto
**Mis Finanzas** — MVP finanzas personales avanzado: React 19 · Tailwind CSS v4 · Framer Motion · Vercel Blob Sync.
Producción: https://mis-finazas-gold.vercel.app (Vercel Hobby). Redeploy: `vercel --prod`.

## Stack Técnico Inmutable
- **Frontend**: React 19 + Vite 6 + Tailwind CSS v4 (@tailwindcss/vite)
- **Lenguaje**: TypeScript (types.ts, reducer.ts, utils.ts, interest.ts, migrations.ts)
- **Tests**: Vitest (~64 tests: reducer, interest, utils, selectors) — `npm test`
- **Estado**: useReducer + Context (store.jsx → reducer.ts + selectors.js) + localStorage persistence
- **Sync Cloud**: Vercel Functions + Vercel Blob (store `mis-finazas-db`) — api/sync.js
- **IA**: Categorización por reglas (utils.ts) + Asistente agéntico human-in-the-loop (Assistant.jsx) + Voice (Web Speech API) + OCR (tesseract.js)
- **Gráficos**: SVG accesibles (Charts.jsx) — LineChart, PieChart
- **Animaciones**: Framer Motion 12 (micro-interacciones <300ms)

## Arquitectura de Estado (store.jsx + reducer.ts)
- **SEED**: Estado semilla con cuentas, assets (crypto, gold, realEstate, depreciating), transacciones, categorías
- **Reducer**: 30+ action types (`innerReducer` + `reducer` wrapper con `_syncVersion` tracking)
- **FX reales**: `useFX` hook — API Frankfurter (fiat) + Coingecko (crypto) cada 30 min. No más random walk
- **Persistencia**: localStorage key `mis-finazas-v1` — debounce 1.5s, clave estable (excluye fx/priceHistory)
- **Sync**: Debounce 1.5s, UUID como llave, pull/push automático, merge por ID con `_updatedAt`, `_syncVersion`
- **Auth**: PBKDF2 + salt (100k iteraciones), setup en first boot (sin contraseña hardcodeada)
- **API Security**: CORS restringido a origen conocido (env `ALLOWED_ORIGINS`), /api/users no expone hashes
- **Lazy loading**: Assistant + Auditoria con React.lazy (~32kB fuera del bundle principal)
- **Dev**: `npm test` antes de commit. Fast Refresh funcional (selectors.js separado del store)

## Formato de Salida Obligatorio
- **Conciso**, bullets, **sin intro genérica** ("Como asistente de IA..."), **sin summary final**
- Código: completo, listo para producción, sin placeholders
- Decisiones: 1 línea de veredicto + 3 razones + 1 riesgo

## Restricciones Permanentes (NEGATIVE CONSTRAINTS)
- NO usar `sudo` sin pedirlo explícitamente
- NO usar datos mock en código de producción — usar APIs reales o simulación documentada
- NO hardcodear valores que vayan en Settings (divisa base, límite gasto, tasas, frecuencias)
- NO exponer contraseñas en código fuente (usar setup flow + PBKDF2)
- NO modificar `store.jsx` sin ejecutar `vault_lint.py` y verificar build (`npm run build`)
- NO hacer push sin `npm run build` exitoso
- NO commitear sin `npm test` exitoso
- NO asumir contexto: **Context-First** — leer Wiki/ + CLAUDE.md + CONTEXTO.md antes de proponer cambios
- NO expansiones de output: **TERMINATION** — parar cuando se cumple la condición, no resumir

## Glosario del Proyecto
| Término | Significado en este contexto |
|---------|------------------------------|
| `SEED` | Estado inicial semilla (accounts, assets, transactions, categories, FX) |
| `accrueInterest` | Función pura que calcula intereses pendientes (modelo simple + capped con ISR) |
| `useFX` | Hook que obtiene tasas reales (frankfurter.app + coingecko) cada 30 min |
| `syncableSlice` | Subconjunto del estado que viaja a la nube (sin priceHistory/FX/versionado con `_syncVersion`) |
| `mergeByID` | Función de merge en restore: fusiona colecciones por ID conservando el `_updatedAt` más reciente |
| `_syncVersion` | Contador de versión del estado — incrementa en cada acción de usuario |
| `_updatedAt` | Timestamp en cada entidad (cuenta, transacción, activo) para resolución de conflictos |
| `transferAliases` | Aprendizaje OCR: texto normalizado → accountId |
| `Bento Grid` | Dashboard asimétrico: patrimonio (dominante), crypto, gold, realEstate, límite, cuentas, donut |
| `Human-in-the-loop` | IA previsualiza acción (gasto, transferencia, programada, límite) → usuario aprueba → ejecuta |

## Skills Activas (en .claude/agents/)
- `/boot` — Inicializa sesión: carga invariantes, memoria, objetivos
- `/close` — Cierra sesión: scorecard, persiste correcciones, git sync, lint
- `/wiki` — Knowledge Distillation: genera notas atómicas Wiki/ desde código fuente

## Top Of Mind (actualizado en /close)
1. Migrar categorización IA de reglas a embedding semántico
2. Agregar API de oro (gold) a `useFX` (actualmente usa valor fijo)
3. Tests de integración sync cloud (pull/push/conflict)

---

## 📚 Stack Metodológico Activo

| Driver | Activación | Propósito |
|--------|-----------|-----------|
| **Session Efficiency** | Siempre | JIT Context Loading, prompts densos, reinicio cada ~15 mensajes, TERMINATION |
| **Persistent Context** | Siempre (via /boot → /close) | boot/close ciclo, learned-rules, CONTEXTO.md, corrections.jsonl |
| **Plan First** | >3 archivos o ambigüedad | Explorar antes de editar; ≤3 archivos → ejecutar directo |
| **Learning Evolution** | Cada ~10 sesiones | Graduar reglas: corrections.jsonl → verified-patterns → CLAUDE.md |
| **Knowledge Distillation** | Al crear Wiki nueva | Pipeline código → nota atómica → MOC (ver `/wiki`) |
| **Cost Optimization** | Siempre (implícito) | RTK filter, model selection (Haiku > Sonnet > Opus), wiki JIT |

Ver referencias en `~/obsidian_vault_mockup/Obsidian vault/META/METHODOLOGIES_INDEX.md`
Ver cost-optimization.md en `.claude/cost-optimization.md`

## 🔄 Checkpoint Protocol (Session Efficiency)

Para evitar degradación del contexto en sesiones largas:
- **Cada ~15 mensajes**: pausar, pedir resumen denso de la conversación, reiniciar hilo con ese resumen como primer mensaje
- `/close` ya actualiza CONTEXTO.md — usarlo como punto natural de checkpoint
- Si la tarea cambia de dominio (ej: de reducer a deploy): reiniciar hilo aunque sean <15 mensajes

## 🧠 Memoria Evolutiva

- `.claude/memory/learned-rules.md` — reglas candidatas (tras 3 sesiones sin violación → verified-patterns.md)
- `.claude/rules/verified-patterns.md` — patrones confirmados (P1-P9)
- `.claude/memory/corrections.jsonl` — correcciones crudas de cada sesión
- Ciclo: corrections → learned-rules → verified-patterns → CLAUDE.md (solo con aprobación explícita)