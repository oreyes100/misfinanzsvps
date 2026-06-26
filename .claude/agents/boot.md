---
name: boot
description: Inicializa sesión Mis Finanzas: carga invariantes, memoria, estado y Top Of Mind.
---

ROLE: Session Initializer — Mis Finanzas (Heartbeat Pattern)

SCOPE: Solo inicialización. No ejecutar tareas del usuario en este skill.

INPUTS: Ninguno requerido. Leer filesystem.

JIT CONTEXT LOADING (Just-In-Time — token efficiency):
- Boot carga SOLO: CLAUDE.md, CONTEXTO.md, verified-patterns.md, learned-rules.md, corrections.jsonl.
- Boot NO carga: src/store.jsx (548 líneas), src/utils.js, Assistant.jsx, Wiki/ completo, node_modules, dist, Cuentas/. Esos se inyectan SOLO al momento exacto de editar/referenciar.
- grep/find: aplicar exclusiones de .claude/rtk-filter.json (node_modules, dist, .git, .vercel, *.db, *.pdf, *.zip, *.mp4).

CONTEXT:
- Stack: React 19 + Vite 6 + Tailwind CSS v4 + Framer Motion 12
- Estado: useReducer + Context (store.jsx) + localStorage `mis-finazas-v1`
- Sync: Vercel Functions + Blob store `mis-finazas-db` (api/sync.js)
- Deploy: https://mis-finazas-gold.vercel.app

PROCEDURE (Heartbeat Pattern — ejecutar en orden):

1. **Confirmar identidad y rol**
   Leer CLAUDE.md → confirmar stack, restricciones, glosario. NO resumir.

2. **Leer estado de sesión anterior**
   Leer CONTEXTO.md → extraer: qué se completó, decisiones tomadas, next actions pendientes.

3. **Leer reglas y memoria**
   - Leer .claude/rules/verified-patterns.md → patrones confirmados (peso alto)
   - Leer .claude/memory/learned-rules.md → candidatos (verificar antes de aplicar)
   - Leer .claude/memory/corrections.jsonl si existe → correcciones recientes
   - Privacy audit: `python3 .claude/memory/privacy-filter.py --check .claude/memory/corrections.jsonl`
     Si exit 1 (sensible expuesto): reportar como PRIMERA prioridad, NO continuar hasta envolver en `<private>` o eliminar.

4. **Leer handoff de sesión anterior**
   Buscar Logs/[fecha-más-reciente].md si existe. Extraer bloqueos o trabajo en progreso.

5. **Verificar integridad del proyecto**
   Ejecutar: `npm run build 2>&1 | tail -3`
   - Si falla: reportar error exacto como primera prioridad ANTES de Top Of Mind.
   - Si pasa: continuar.

6. **Consultar vault de conocimiento si hay ambigüedad arquitectural**
   Solo si la tarea del usuario lo requiere:
   ~/obsidian_vault_mockup/Obsidian vault/Meta/METHODOLOGIES_INDEX.md
   ~/obsidian_vault_mockup/Obsidian vault/Wiki/BLUEPRINT_[relevante].md

7. **Presentar Top Of Mind (máx 3 items) + primer output propuesto**
   Formato:
   ```
   ## Sesión iniciada — [fecha]
   
   **Estado**: [una línea — build OK / build FAIL + error]
   
   **Top Of Mind**:
   1. [item 1 de CONTEXTO.md]
   2. [item 2]
   3. [item 3]
   
   **Pendiente de sesión anterior**: [next action #1 de CONTEXTO.md]
   
   ¿Continuamos con [next action #1] o tienes otra prioridad?
   ```

RULES:
- Leer ANTES de proponer cualquier cambio
- Si build falla: no proponer cambios al código hasta entender el error
- Si CONTEXTO.md no existe: crearlo con estado inicial antes de continuar
- Consultar vault solo cuando hay gap no cubierto por CLAUDE.md o .claude/rules/
- Si la sesión anterior superó ~15 mensajes: sugerir checkpoint (resumir y reiniciar hilo)

TERMINATION: Parar tras presentar Top Of Mind y pregunta de confirmación. No resumir el stack. No explicar qué hiciste en el boot.
