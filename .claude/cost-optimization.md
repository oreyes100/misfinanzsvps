# Cost Optimization — Mis Finanzas
> Estrategia de infraestructura de tokens: RTK, model selection, wiki compilation.
> Aplicar siempre como parte de Session Efficiency.

## RTK Filter Strategy
Archivo: `.claude/rtk-filter.json`

Qué hace: reduce ruido en el contexto antes de que toque el LLM.
- **Excluye**: node_modules, dist, android/build, .vercel, __pycache__, .git
- **Excluye glob**: *.db, *.pdf, *.zip, *.apk, *.traineddata, *.mp4, *.jpeg, *.png, *.log, package-lock.json
- **Max size**: 512KB — archivos más grandes no se cargan al contexto
- **Logs**: solo ERROR/WARN pasan; DEBUG/TRACE se descartan
- **Dedup**: consecutivos con similitud >0.95 se colapsan
- **Compresión**: truncar a 500 chars con keep_start_end

## Model Selection
| Modelo | Cuándo usar | Por qué |
|--------|------------|---------|
| Claude Code (Sonnet 4) | Desarrollo activo: editar código, debug, refactor | Precisión técnica, tool use nativo |
| Claude Code (Haiku 3.5) | Tareas simples: lint, build check, grep, vault scan | 10% del costo, misma tool chain |
| Claude.ai | Arquitectura, diseño, documentación, Wiki | Contexto largo, mejor razonamiento |
| Claude Code (Opus) | NO usar — Sonnet 4 es suficiente para este código | Costo 3x sin beneficio medible |

### Reglas
1. Tareas de 1-2 archivos → Haiku. Si falla escala a Sonnet.
2. Más de 3 archivos o ambigüedad → Sonnet + Plan First.
3. Wiki/documentación → Claude.ai (contexto más largo, mejor formato).
4. NO usar Opus para este proyecto — el stack es simple y Sonnet lo cubre.

## Wiki Compilation for Token Efficiency
- **JIT Loading**: NO cargar Wiki/ al inicio. Solo cargar notas específicas cuando la tarea las requiere.
- **Densidad ≥ 3.0**: notas técnicas con código inline. Notas con baja densidad (párrafos sin código) se refactorizan.
- **MOC como índice**: MOC-Mis-Finanzas.md resuelve el 80% de las consultas sin bajar a notas individuales.
- **Consolidación**: cuando un tema tenga ≥3 notas Wiki relacionadas, considerar Blueprint en Meta/.
- **Anti-patrón**: leer 5+ notas Wiki para una tarea que podría resolverse con una búsqueda directa en código. Preferir leer el código fuente.

## Tests
- `npm test` rápido (~130ms) — 64+ tests
- Correr antes de cada commit
- No mockear APIs externas en tests de reducer (son puros, sin side effects)
- Si se agrega un action type nuevo, agregar test case

## Resumen de Costos
| Concepto | Límite | Estrategia |
|----------|--------|------------|
| Contexto por sesión | ~200K tokens | JIT loading + checkpoint cada ~15 mensajes |
| Build por sesión | 1-3 runs | P1: build verify antes/después de modificar store.jsx |
| Tests por sesión | 1 run pre-commit | `npm test` — ~130ms, 64+ tests |
| Sync cloud | Debounce 1.5s | Evita pushes innecesarios (P6) |
| Wiki en contexto | 0 (JIT) | No cargar preventivamente — solo nota específica |
