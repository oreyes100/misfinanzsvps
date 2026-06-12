# CONTEXTO.md — Estado Consciente Mis Finanzas
> Actualizado en cada `/close`. Leído en cada `/boot`.
> Contiene: estado actual, decisiones, next actions, Top Of Mind.

---

## 📅 Última Actualización
**Fecha**: 2026-06-12
**Sesión**: Inicialización Fase 1 (fundación agentica)

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
1. Creado `CLAUDE.md` como BIOS del proyecto (invariantes, stack, restricciones, glosario)
2. Creadas skills atómicas: `.claude/agents/boot.md` y `.claude/agents/close.md`
3. Copiado y adaptado `scripts/vault_lint.py` — **pasa ✅** (3 notas Wiki + 1 MOC + 1 MCP-Config, 0 issues)
4. Estructura PMF creada: `.claude/{rules,memory,agents}/`, `Wiki/`, `MOCs/`, `Sources/Inboxes/`, `Logs/`
5. **Wiki atómica inicial (4 notas)**: `Arquitectura-Estado.md`, `Sync-Cloud.md`, `MCP-Config.md`, `MOC-Mis-Finanzas.md` — todas con frontmatter, ≥40 palabras, "Fuente:", enlaces bidireccionales
6. **Build verificado** — `npm run build` ✅ (568ms)

---

## 🔄 Decisiones Técnicas Tomadas
| Decisión | Razón | Alternativa Desestimada |
|----------|-------|------------------------|
| PMF 4 capas en `.claude/` | Memoria persistente filesystem, auditable, portable | Memoria solo en contexto (no persiste) |
| Skills atómicas (ATOMS) para boot/close | ~100% deterministas, componibles | Skill compuesto monolítica |
| Vault lint adaptado a estructura proyecto | Calidad knowledge base desde día 1 | Sin lint (deuda técnica) |
| TERMINATION obligatorio en skills | Evita expansión output 3-4x | Sin límite (outputs verbosos) |
| Wiki atómica + MOC desde día 1 | Contexto navegable, token-eficiente, lintable | Solo código + README (contexto opaco) |
| MCP Config documentada (Filesystem, GitHub, Context7) | Capa 4 Stack lista para activar | Descubrir en caliente (pérdida tiempo) |

---

## ⏭️ Next Actions (Priorizadas, máx 3)
1. **Crear skills moleculares** — `/review-code` (fetch-data + validate + reasoning-gate), `/research-and-summarize`
2. **Completar Wiki pendiente** — `IA-Asistente.md`, `Multi-Moneda.md`, `Cuentas-Tipos.md`, `Portfolio-Multiactivo.md`
3. **Activar MCP Filesystem + GitHub + Context7** — Probar en próxima sesión con `/boot`

---

## 🧠 Top Of Mind (para próxima sesión)
1. **Optimizar `tick_prices` (4s)** — Evaluar Web Workers para no bloquear main thread
2. **Migrar categorización IA** — De reglas (utils.js) a embedding semántico + few-shot
3. **Tests unitarios reducer** — Cobertura: `accrueInterest`, `transfer` (FX conversion), `tick_prices`

---

## 📚 Referencias Rápidas
- `CLAUDE.md` — BIOS completa (invariantas, stack, restricciones, glosario)
- `src/store.jsx` — Estado global (548 líneas, 30+ action types)
- `src/utils.js` — FX, categorización IA, parser NL, formato
- `src/components/Assistant.jsx` — Chat agéntico human-in-the-loop + voz + OCR
- `api/sync.js` — Vercel Function + Blob sync (GET/POST con UUID)
- `Wiki/Arquitectura-Estado.md` — Estado global detallado + reducer actions
- `Wiki/Sync-Cloud.md` — Sync Vercel Blob + UUID + syncableSlice
- `Wiki/MCP-Config.md` — Configuración MCP (Filesystem, GitHub, Context7, Playwright)
- `MOCs/MOC-Mis-Finanzas.md` — Navegación temática Wiki ↔ src/