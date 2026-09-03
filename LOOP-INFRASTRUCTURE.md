# 🔄 Infraestructura de Loops — Plan de Implementación

> **Basado en**: "Prompting is dead. Here is how you create loops" (Finn Loop)  
> **Fecha**: 2026-09-04  
> **Estado**: Plan de implementación

---

## 📊 Análisis del Estado Actual

### ✅ Lo que ya existe

| Componente | Estado | Ubicación |
|---|---|---|
| **Telegram bot** | ✅ Activo | `@dineroorganizadobot`, `server/hermes/telegram*.mjs` |
| **Sistema de wargames** | ✅ 21/21 completados | `WARGAMES-MCP-MISFINANZSVPS.md` |
| **Scripts de diagnóstico** | ✅ Múltiples | `scripts/*.mjs`, `scripts/*.sh` |
| **Deploy automatizado** | ✅ VPS + Vercel | `VPS-CONEXION.md`, `.vercel/` |
| **Tests automatizados** | ✅ 502 tests | `npm test`, Vitest |
| **Documentación estructurada** | ✅ Wiki + MOCs | `Wiki/`, `MOCs/` |
| **Reglas de enganche** | ✅ Ground Truth | `CLAUDE.md`, lecciones aprendidas |
| **Hermes Agent** | ✅ Procesamiento IA | `server/hermes/hermes.mjs` |

### ❌ Lo que falta para loops autónomos

| Componente | Gap | Solución propuesta |
|---|---|---|
| **Issue tracker** | No hay backlog persistente | SQLite table `wargame_issues` + JSON file `backlog.json` |
| **Skill `/spec`** | Humano escribe wargame completo | Bot entrevista → genera issues atómicos |
| **Build loop** | Humano ejecuta manualmente | Cron/systemd timer cada 5 min |
| **Review loop** | Humano verifica con curl | Playwright auto-testing + criterios medibles |
| **Merge por gesto** | `git push` manual | Emoji 🚀 en Telegram → merge automático |
| **Notificaciones proactivas** | Solo respuestas | Bot envía updates sin preguntar |
| **Preview por issue** | Deploy completo | Vercel branch previews (git branch por issue) |

---

## 🎯 Arquitectura de Loops Adaptada

### Flujo completo

```
┌─────────────────────────────────────────────────────────────┐
│  1. SPEC (5 min, humano)                                    │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Usuario: /spec Quiero exportar a CSV                  │  │
│  │ Bot: 🎯 Pregunta 1/6: ¿Qué datos exportar?           │  │
│  │ Usuario: transacciones + cuentas                      │  │
│  │ Bot: 🎯 Pregunta 2/6: ¿Formato de fecha?             │  │
│  │ ...                                                   │  │
│  │ Bot: ✅ Spec completado. 4 issues creados.            │  │
│  │      📋 Backlog: issues #45-48                        │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  2. BUILD LOOP (autónomo, cada 5 min)                       │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Cron: node scripts/build-loop.mjs                     │  │
│  │ → Lee issue #45 (estado: todo)                        │  │
│  │ → Marca in_progress                                   │  │
│  │ → Ejecuta: git checkout -b wargame-30-issue-45        │  │
│  │ → Implementa código + tests                           │  │
│  │ → npm test (debe pasar)                               │  │
│  │ → npm run build (debe pasar)                          │  │
│  │ → git commit + push                                   │  │
│  │ → Marca estado: review                                │  │
│  │ → Notifica Telegram: "🔨 Issue #45 listo para review" │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  3. REVIEW LOOP (autónomo, cada 5 min)                      │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Cron: node scripts/review-loop.mjs                    │  │
│  │ → Lee issue #45 (estado: review)                      │  │
│  │ → Deploy a Vercel preview (branch)                    │  │
│  │ → Ejecuta acceptance criteria con Playwright          │  │
│  │ → Si todo verde:                                      │  │
│  │   → Marca estado: ready_to_merge                      │  │
│  │   → Notifica Telegram con preview URL                 │  │
│  │   → Espera emoji 🚀 del humano                        │  │
│  │ → Si algo rojo:                                       │  │
│  │   → Marca estado: needs_fix                           │  │
│  │   → Notifica Telegram con errores                     │  │
│  │   → Vuelve al build loop                              │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────┐
│  4. MERGE (gesto, humano, 30 seg)                           │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Telegram: "✅ Issue #45 listo. Preview: [URL]"        │  │
│  │           "🚀 Reacciona para mergear"                 │  │
│  │ Usuario: 🚀                                           │  │
│  │ Bot:                                                  │  │
│  │   → git checkout main                                 │  │
│  │   → git merge wargame-30-issue-45                     │  │
│  │   → npm test (suite completa)                         │  │
│  │   → Deploy VPS + Vercel prod                          │  │
│  │   → Actualiza WARGAMES.md v7.6.0                      │  │
│  │   → Notifica: "✅ Issue #45 desplegado"               │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## 🏗️ Componentes a Implementar

### 1. Issue Tracker (SQLite + JSON)

**Archivo**: `server/hermes/issues.mjs`

```javascript
// Schema SQLite
CREATE TABLE wargame_issues (
  id INTEGER PRIMARY KEY,
  wargame_id INTEGER,           // Wargame 30
  issue_number INTEGER,         // Issue 1/4
  title TEXT,                   // "Exportar transacciones a CSV"
  description TEXT,             // Descripción detallada
  acceptance_criteria TEXT,     // JSON array de criterios
  non_goals TEXT,               // JSON array de no-goals
  state TEXT DEFAULT 'todo',    // todo | in_progress | review | ready_to_merge | done | failed
  branch TEXT,                  // wargame-30-issue-1
  commit_hash TEXT,
  preview_url TEXT,
  created_at TEXT,
  updated_at TEXT,
  attempts INTEGER DEFAULT 0
);

// Funciones exportadas
export function createIssue(wargameId, title, description, ac, nonGoals)
export function getNextTodoIssue()
export function updateIssueState(issueId, state, metadata)
export function getIssuesByState(state)
export function incrementAttempts(issueId)
```

**Fallback**: `backlog.json` para cuando SQLite no esté disponible.

---

### 2. Skill `/spec` (Telegram Bot)

**Archivo**: `server/hermes/spec-skill.mjs`

**Flujo**:
```
Usuario: /spec Quiero exportar a CSV
Bot: 🎯 Entendido. Voy a hacerte 6 preguntas para especificar bien.

Bot: Pregunta 1/6: ¿Qué datos exportar?
     a) Solo transacciones
     b) Solo cuentas
     c) Ambos
     d) Personalizado (especifica)

Usuario: c

Bot: Pregunta 2/6: ¿Formato de fecha en el CSV?
     a) ISO (YYYY-MM-DD)
     b) DD/MM/YYYY
     c) MM/DD/YYYY

Usuario: b

... (4 preguntas más)

Bot: ✅ Spec completado. Resumen:
     • Exportar: transacciones + cuentas
     • Fecha: DD/MM/YYYY
     • Columnas: [fecha, descripción, monto, categoría, cuenta]
     • Filtros: rango de fechas, categoría, cuenta
     • Non-goals: no exportar assets, no PDF
     
     📋 4 issues creados:
     1. Crear función exportToCSV() pura
     2. UI: botón "Exportar" en Reports
     3. Filtros de exportación
     4. Tests de exportación
     
     🚀 Build loop empezará en 5 min.
```

**Preguntas auto-generadas** (basadas en el tipo de feature):
- ¿Qué problema resuelve?
- ¿Qué datos/archivos toca?
- ¿Qué wargames previos reutiliza?
- ¿Cómo se verifica el éxito? (curl, test, UI)
- ¿Qué puede fallar? (edge cases)
- ¿Cuál es el fallback si falla?

**Output**: 3-8 issues atómicos con acceptance criteria medibles.

---

### 3. Build Loop (Cron + Node Script)

**Archivo**: `scripts/build-loop.mjs`

**Ejecución**: Cron cada 5 minutos
```bash
# /etc/cron.d/misfinanzas-loops
*/5 * * * * devops cd /home/devops/mis-finanzas && node scripts/build-loop.mjs >> /var/log/build-loop.log 2>&1
```

**Lógica**:
```javascript
async function buildLoop() {
  const issue = getNextTodoIssue();
  if (!issue) {
    console.log("No hay issues pendientes");
    return;
  }
  
  console.log(`[build] Issue #${issue.id}: ${issue.title}`);
  
  // 1. Crear branch
  const branch = `wargame-${issue.wargame_id}-issue-${issue.issue_number}`;
  execSync(`git checkout -b ${branch}`);
  updateIssueState(issue.id, 'in_progress', { branch });
  
  // 2. Implementar (aquí va la lógica del agente)
  // - Leer description + acceptance_criteria
  // - Generar código + tests
  // - npm test
  // - npm run build
  
  try {
    // ... implementación del agente ...
    
    // 3. Commit + push
    execSync(`git add -A`);
    execSync(`git commit -m "feat(w${issue.wargame_id}): ${issue.title}"`);
    execSync(`git push origin ${branch}`);
    
    // 4. Marcar como review
    updateIssueState(issue.id, 'review', {
      commit: execSync('git rev-parse HEAD').toString().trim()
    });
    
    // 5. Notificar Telegram
    await telegramSend(`🔨 Issue #${issue.id} listo para review\n` +
                       `📋 ${issue.title}\n` +
                       `🌿 Branch: ${branch}`);
  } catch (e) {
    // Fallo: incrementar intentos
    incrementAttempts(issue.id);
    if (issue.attempts >= 3) {
      updateIssueState(issue.id, 'failed', { error: e.message });
      await telegramSend(`❌ Issue #${issue.id} falló tras 3 intentos\n` +
                         `Error: ${e.message}`);
    } else {
      updateIssueState(issue.id, 'todo'); // reintentar
      await telegramSend(`⚠️ Issue #${issue.id} falló, reintentando\n` +
                         `Intento ${issue.attempts + 1}/3`);
    }
  }
}
```

---

### 4. Review Loop (Playwright + Auto-testing)

**Archivo**: `scripts/review-loop.mjs`

**Ejecución**: Cron cada 5 minutos
```bash
*/5 * * * * devops cd /home/devops/mis-finanzas && node scripts/review-loop.mjs >> /var/log/review-loop.log 2>&1
```

**Lógica**:
```javascript
async function reviewLoop() {
  const issue = getIssuesByState('review')[0];
  if (!issue) return;
  
  console.log(`[review] Issue #${issue.id}: ${issue.title}`);
  
  // 1. Deploy preview a Vercel (branch)
  const previewUrl = await deployPreview(issue.branch);
  updateIssueState(issue.id, 'review', { preview_url: previewUrl });
  
  // 2. Ejecutar acceptance criteria con Playwright
  const browser = await chromium.launch();
  const page = await browser.newPage();
  
  const results = [];
  const criteria = JSON.parse(issue.acceptance_criteria);
  
  for (const ac of criteria) {
    try {
      const ok = await verifyAcceptanceCriterion(page, previewUrl, ac);
      results.push({ criterion: ac, ok, error: null });
    } catch (e) {
      results.push({ criterion: ac, ok: false, error: e.message });
    }
  }
  
  await browser.close();
  
  // 3. Evaluar resultados
  const passed = results.filter(r => r.ok).length;
  const total = results.length;
  
  if (passed === total) {
    // Todo verde → ready_to_merge
    updateIssueState(issue.id, 'ready_to_merge', { review_results: results });
    await telegramSend(`✅ Issue #${issue.id} pasó todas las pruebas\n` +
                       `🎯 ${passed}/${total} criterios verdes\n` +
                       `👀 Preview: ${previewUrl}\n` +
                       `🚀 Reacciona con 🚀 para mergear`);
  } else {
    // Algo rojo → needs_fix → vuelve a build loop
    updateIssueState(issue.id, 'todo', { review_results: results });
    const failed = results.filter(r => !r.ok);
    await telegramSend(`❌ Issue #${issue.id} falló en review\n` +
                       `🎯 ${passed}/${total} criterios verdes\n` +
                       `Errores:\n${failed.map(f => `  • ${f.criterion}: ${f.error}`).join('\n')}\n` +
                       `🔨 Volviendo a build loop`);
  }
}

async function verifyAcceptanceCriterion(page, url, criterion) {
  // Ejemplos de criterios:
  // - "curl /api/health → 200 OK"
  // - "GET /api/export → devuelve CSV con headers correctos"
  // - "UI: botón Exportar visible en Reports"
  // - "Test: exportToCSV() genera 5 columnas"
  
  if (criterion.startsWith('curl')) {
    // Ejecutar curl y verificar respuesta
    const response = await fetch(url + criterion.split(' ')[1]);
    return response.ok;
  }
  
  if (criterion.startsWith('UI:')) {
    // Navegar y verificar elemento
    await page.goto(url);
    const selector = extractSelector(criterion);
    await page.waitForSelector(selector);
    return true;
  }
  
  if (criterion.startsWith('Test:')) {
    // Ejecutar test específico
    const testFile = extractTestFile(criterion);
    const result = execSync(`npm test -- ${testFile}`);
    return result.includes('passed');
  }
  
  return false;
}
```

---

### 5. Merge por Gesto (Telegram Bot)

**Archivo**: `server/hermes/merge-skill.mjs`

**Flujo**:
```javascript
async function handleMergeReaction(messageId, userId, emoji) {
  if (emoji !== '🚀') return;
  
  const issue = getIssueByMessageId(messageId);
  if (!issue || issue.state !== 'ready_to_merge') return;
  
  console.log(`[merge] Issue #${issue.id}: merge aprobado por ${userId}`);
  
  try {
    // 1. Checkout main
    execSync('git checkout main');
    execSync('git pull origin main');
    
    // 2. Merge branch
    execSync(`git merge ${issue.branch}`);
    
    // 3. Tests completos
    execSync('npm test');
    
    // 4. Deploy
    execSync('npm run build');
    execSync('./scripts/deploy-vps.sh');
    execSync('vercel --prod');
    
    // 5. Actualizar WARGAMES.md
    updateWargamesDoc(issue.wargame_id, issue);
    
    // 6. Marcar como done
    updateIssueState(issue.id, 'done', {
      merged_at: new Date().toISOString(),
      merged_by: userId
    });
    
    // 7. Notificar
    await telegramSend(`✅ Issue #${issue.id} desplegado en producción\n` +
                       `🎉 Wargame ${issue.wargame_id} completado`);
  } catch (e) {
    await telegramSend(`❌ Error mergiendo issue #${issue.id}\n` +
                       `Error: ${e.message}`);
  }
}
```

---

### 6. Notificaciones Proactivas (Telegram Bot)

**Archivo**: `server/hermes/notifications.mjs`

**Eventos que disparan notificación**:
- Build loop completa un issue → `🔨 Issue #X listo`
- Review loop pasa todas las pruebas → `✅ Issue #X listo para merge`
- Review loop falla → `❌ Issue #X falló, reintentando`
- Merge completado → `✅ Issue #X desplegado`
- Error crítico (3 intentos fallidos) → `🚨 Issue #X falló tras 3 intentos`

**Formato de mensaje**:
```
🔨 Issue #45 listo para review

📋 Exportar transacciones a CSV
🌿 Branch: wargame-30-issue-1
🧪 Tests: 12/12 pasando
📦 Build: exitoso

🎯 Acceptance criteria:
  ✅ Función exportToCSV() pura
  ✅ UI: botón visible en Reports
  ✅ CSV con 5 columnas
  ✅ Filtros de fecha funcionando

🚀 Reacciona con 🚀 para mergear
```

---

### 7. Preview por Issue (Vercel Branch Previews)

**Archivo**: `scripts/deploy-preview.mjs`

**Lógica**:
```javascript
async function deployPreview(branch) {
  // Vercel automáticamente despliega cada branch como preview
  // URL: https://mis-finazas-gold-git-{branch}.vercel.app
  
  const sanitizedBranch = branch.replace(/[^a-z0-9-]/g, '-').toLowerCase();
  const previewUrl = `https://mis-finazas-gold-git-${sanitizedBranch}.vercel.app`;
  
  // Verificar que el deploy está listo
  let attempts = 0;
  while (attempts < 10) {
    try {
      const response = await fetch(previewUrl);
      if (response.ok) return previewUrl;
    } catch {}
    await sleep(5000);
    attempts++;
  }
  
  throw new Error('Preview no disponible tras 50s');
}
```

---

## 📋 Plan de Implementación (Fases)

### Fase 1: Issue Tracker + Skill `/spec` (2 días)

**Objetivo**: Poder crear issues desde Telegram

- [ ] Crear tabla `wargame_issues` en SQLite
- [ ] Implementar `server/hermes/issues.mjs`
- [ ] Implementar `server/hermes/spec-skill.mjs`
- [ ] Integrar en el bot de Telegram (`/spec`)
- [ ] Probar: `/spec Quiero exportar a CSV` → 4 issues creados
- [ ] Verificar: issues aparecen en `backlog.json`

**Criterio de éxito**: 
- Usuario puede crear spec desde Telegram
- Issues se guardan en SQLite + JSON
- Bot confirma con resumen

---

### Fase 2: Build Loop (3 días)

**Objetivo**: Build autónomo de issues

- [ ] Implementar `scripts/build-loop.mjs`
- [ ] Configurar cron cada 5 min
- [ ] Implementar lógica de creación de branch
- [ ] Implementar lógica de commit + push
- [ ] Implementar notificación Telegram
- [ ] Probar: issue todo → in_progress → review
- [ ] Verificar: branch existe, commit pusheado

**Criterio de éxito**:
- Build loop corre cada 5 min
- Issues pasan de todo → in_progress → review
- Branches se crean y pushean
- Notificaciones llegan a Telegram

---

### Fase 3: Review Loop (3 días)

**Objetivo**: Review autónomo con Playwright

- [ ] Instalar Playwright: `npm install playwright`
- [ ] Implementar `scripts/review-loop.mjs`
- [ ] Implementar `deploy-preview.mjs`
- [ ] Configurar cron cada 5 min
- [ ] Implementar verificación de acceptance criteria
- [ ] Probar: issue review → ready_to_merge (o needs_fix)
- [ ] Verificar: preview URL funciona, criterios se verifican

**Criterio de éxito**:
- Review loop corre cada 5 min
- Preview se despliega automáticamente
- Acceptance criteria se verifican
- Issues pasan a ready_to_merge o vuelven a todo

---

### Fase 4: Merge por Gesto (2 días)

**Objetivo**: Merge con emoji 🚀

- [ ] Implementar `server/hermes/merge-skill.mjs`
- [ ] Integrar en el bot de Telegram (reacción 🚀)
- [ ] Implementar lógica de merge + deploy
- [ ] Implementar actualización de WARGAMES.md
- [ ] Probar: emoji 🚀 → merge → deploy → done
- [ ] Verificar: main actualizado, producción desplegada

**Criterio de éxito**:
- Usuario reacciona con 🚀
- Branch se mergea a main
- Tests completos pasan
- Deploy a VPS + Vercel
- WARGAMES.md actualizado

---

### Fase 5: Notificaciones Proactivas (1 día)

**Objetivo**: Bot notifica sin preguntar

- [ ] Implementar `server/hermes/notifications.mjs`
- [ ] Integrar en build loop + review loop
- [ ] Probar: notificaciones llegan en cada evento
- [ ] Verificar: formato correcto, URLs funcionan

**Criterio de éxito**:
- Notificaciones llegan en cada cambio de estado
- Formato es claro y útil
- URLs de preview funcionan

---

### Fase 6: Wargame 30 Piloto (3 días)

**Objetivo**: Probar infraestructura con wargame real

- [ ] Crear spec de Wargame 30 (Photo Vault revisitado)
- [ ] Generar 5-8 issues atómicos
- [ ] Dejar que build loop los implemente
- [ ] Dejar que review loop los revise
- [ ] Mergear con 🚀
- [ ] Documentar lecciones aprendidas

**Criterio de éxito**:
- Wargame 30 completado sin intervención manual (excepto spec + merge)
- Todos los issues pasan por el loop
- Producción desplegada
- Lección #22 documentada

---

## 🔧 Herramientas Necesarias

### Instalación

```bash
# Playwright (para review loop)
npm install --save-dev playwright
npx playwright install chromium

# Cron jobs (en VPS)
sudo crontab -e
# Añadir:
# */5 * * * * devops cd /home/devops/mis-finanzas && node scripts/build-loop.mjs >> /var/log/build-loop.log 2>&1
# */5 * * * * devops cd /home/devops/mis-finanzas && node scripts/review-loop.mjs >> /var/log/review-loop.log 2>&1
```

### Configuración

**Archivo**: `server/hermes/loops.config.json`

```json
{
  "build_loop": {
    "enabled": true,
    "interval_ms": 300000,
    "max_attempts": 3,
    "auto_push": true
  },
  "review_loop": {
    "enabled": true,
    "interval_ms": 300000,
    "playwright": {
      "browser": "chromium",
      "headless": true,
      "timeout_ms": 30000
    }
  },
  "notifications": {
    "telegram": true,
    "proactive": true,
    "events": ["build_complete", "review_passed", "review_failed", "merge_complete"]
  }
}
```

---

## 📊 Métricas de Éxito

### Corto plazo (1 mes)

- [ ] 5 wargames completados con loops (W30-W34)
- [ ] Tiempo promedio por wargame: <3 días (vs 1 semana manual)
- [ ] Intervención humana: <10% del tiempo (solo spec + merge)
- [ ] 0 wargames bloqueados por falta de contexto

### Mediano plazo (3 meses)

- [ ] 20 wargames completados con loops
- [ ] Build loop: 95% success rate (sin fallos tras 3 intentos)
- [ ] Review loop: 90% accuracy (acceptance criteria correctos)
- [ ] Merge: 100% sin conflictos (branches limpios)

### Largo plazo (6 meses)

- [ ] 50 wargames completados
- [ ] Loops completamente autónomos (spec también auto-generado)
- [ ] Multi-proyecto (loops corren en paralelo para varios repos)
- [ ] Dashboard de loops (métricas en tiempo real)

---

## 🎯 Siguientes Pasos

1. **Aprobar este plan** → confirmar que la arquitectura es correcta
2. **Empezar Fase 1** → Issue Tracker + Skill `/spec`
3. **Iterar** → ajustar según lecciones aprendidas
4. **Documentar** → actualizar WARGAMES.md con lección #22

---

## 📚 Referencias

- **Video original**: "Prompting is dead. Here is how you create loops" (Finn Loop)
- **Conceptos clave**: spec/build/review loops, Linear (issue tracker), Slack notifications, Vercel previews
- **Adaptación**: Telegram (en vez de Slack), SQLite (en vez de Linear), Vercel branch previews

---

**Estado**: Plan aprobado, listo para implementar Fase 1  
**Siguiente acción**: Crear `server/hermes/issues.mjs` y `server/hermes/spec-skill.mjs`
