---
name: close
description: Cierra sesión Mis Finanzas: scorecard, persiste correcciones, git sync, lint.
---

ROLE: Session Closer — Mis Finanzas (Checkpoint Protocol)

SCOPE: Solo cierre de sesión. No ejecutar tareas nuevas.

INPUTS: Estado de la sesión (qué se hizo, qué se aprobó, qué se rechazó).

CONTEXT:
- Memoria activa: CONTEXTO.md, .claude/memory/, .claude/rules/
- Log de sesiones: sessions.jsonl (raíz del proyecto)
- Vault de conocimiento: ~/obsidian_vault_mockup/Obsidian vault/

PROCEDURE (Checkpoint Protocol — ejecutar en orden):

1. **Verificar build final**
   ```bash
   npm run build 2>&1 | tail -3
   ```
   - Si falla: NO cerrar sesión. Reportar error y esperar fix antes de continuar.
   - Si pasa: continuar.

2. **Ejecutar vault lint**
   ```bash
   python scripts/vault_lint.py 2>&1 | grep -E "ERROR|WARNING|OK"
   ```
   Anotar resultado para el scorecard.

3. **Capturar correcciones de la sesión**
   Por cada corrección que el usuario hizo a mis propuestas, append a .claude/memory/corrections.jsonl:
   ```json
   {"ts":"ISO","rule_candidate":"descripción de la regla aprendida","trigger":"qué causó el error","verify":"comando bash ejecutable para validar","sessions_ok":0}
   ```

4. **Promover reglas maduras**
   - Buscar en corrections.jsonl entradas con sessions_ok ≥ 3 → mover a .claude/rules/verified-patterns.md
   - Buscar en verified-patterns.md entradas con sessions_ok ≥ 5 + 0 violaciones → candidatas a CLAUDE.md (preguntar al usuario antes de escribir)

5. **Actualizar CONTEXTO.md**
   Sobreescribir secciones:
   - "Última Actualización": fecha ISO de hoy
   - "Qué se Completó": lista de lo que se hizo en esta sesión
   - "Decisiones Técnicas": nuevas decisiones (tabla: decisión | razón | alternativa desestimada)
   - "Next Actions": máx 3, priorizadas por ROI
   - "Top Of Mind": actualizar si cambió la prioridad

6. **Generar scorecard → sessions.jsonl**
   Append una línea:
   ```json
   {"ts":"ISO","accepted":N,"overridden":N,"cost_usd":0.00,"cycle_time_min":N,"incidents":N,"build":"ok|fail","lint":"ok|warnings|errors","focus":"[Top Of Mind item trabajado]"}
   ```
   Acceptance rate meta: >70%. Si <70% → registrar como incident.

7. **Distilación al vault (si aplica)**
   Si se tomó una decisión arquitectural significativa o se descubrió un patrón nuevo:
   - Crear nota atómica en Wiki/ del proyecto
   - Considerar si merece propagarse al vault global (~/obsidian_vault_mockup/)

8. **Git sync**
   ```bash
   git add -A && git status
   ```
   Solo hacer commit si hay cambios. Mensaje: `chore: session close YYYY-MM-DD`
   Solo hacer push si el build pasó en paso 1.

RULES:
- Si build falla en paso 1: detener, reportar, NO hacer git push
- Nunca escribir en CLAUDE.md sin aprobación explícita del usuario
- El scorecard es honesto: si overridearon 5 de 5 propuestas, registrar accepted:0 overridden:5
- Acceptance rate <70% en 3 sesiones consecutivas = problema de contexto insuficiente, no de modelo

TERMINATION: Parar tras confirmar git status (o "nothing to commit"). Mostrar solo: build status + acceptance rate + next action #1. No resumir todo lo que hiciste.
