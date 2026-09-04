---
description: "Genera un spec GROUNDED para el loop autoconstructivo (grep/ls el repo antes de responder) y lo envía a la API /api/wargame/spec"
argument-hint: "<idea de feature o bug a diagnosticar>"
---

# Wargame Spec GROUNDED — $ARGUMENTS

Estás en el repo **Mis Finanzas** (misfinanzsvps). Tu trabajo: convertir esta idea en un **spec grounded** — cada respuesta respaldada por evidencia real del código (grep/ls), nunca suposiciones — y enviarlo a la API del loop.

## PASO 1 — Ground Truth (OBLIGATORIO antes de responder)

Investiga el repo ANTES de responder las preguntas:

1. `grep -rn` los módulos/símbolos que la idea tocará — **verifica que existan**
2. `ls` los directorios relevantes (server/, server/hermes/, src/, src/components/)
3. Si la idea es un **bug**: grep el mensaje de error real y lee el código que lo produce — diagnostica la causa raíz con rutas y líneas
4. Si toca tests: verifica qué corren en qué capa (vitest para `src/**` y `lib/**`, node --test para `server/**`)

Si un supuesto no aparece en el repo → **NO lo uses**. El spec debe citar rutas reales.

## PASO 2 — Responde las 7 preguntas con evidencia

1. **Problema que resuelve** (1 frase)
2. **Non-goals** (separados por coma; incluir "No tocar server/data/** ni credenciales")
3. **Wargames/módulos previos que reutiliza** (con rutas reales verificadas)
4. **Endpoints/archivos que tocará** (verificados con grep, con ruta exacta)
5. **Verificación de éxito** (comandos REALES ejecutables en el VPS: `npm test -- --run`, `node --test server/hermes/X.test.mjs`, `curl -s localhost:3000/...`, `grep -n ...`; los AC de server/** usan node --test, no vitest)
6. **Edge cases** (separados por coma)
7. **Complejidad**: "feature nueva" o "bug diagnóstico"

## PASO 3 — Determina el número de wargame

```bash
node scripts/wargame-cli.mjs issues
```
El siguiente número = el wargame más alto en el tracker + 1.

## PASO 4 — Envía el spec a la API

Escribe las 7 respuestas a un JSON temporal y envíalo:

```bash
cat > /tmp/wargame-spec.json << 'EOF'
{
  "wargame": <número>,
  "idea": "<la idea>",
  "answers": [
    "<respuesta 1>",
    "<respuesta 2>",
    "<respuesta 3>",
    "<respuesta 4>",
    "<respuesta 5>",
    "<respuesta 6>",
    "<respuesta 7: feature nueva | bug diagnóstico>"
  ]
}
EOF
node scripts/wargame-cli.mjs spec /tmp/wargame-spec.json
```

La API valida: idea + 7 respuestas (strings) + wargame numérico. Auth: WARGAME_TOKEN env o `~/.wargame-token`.

## PASO 5 — Reporta

```bash
node scripts/wargame-cli.mjs issues <wargame>
```

Muestra al usuario: IDs creados, títulos, y que el build loop los tomará en ≤5 min. **NO implementes los issues tú mismo** — el loop los construye (dogfooding); tu trabajo terminó al enviar el spec.
