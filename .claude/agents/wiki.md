# /wiki — Knowledge Distillation Pipeline (Mis Finanzas)
> Genera notas atómicas en Wiki/ desde el código fuente.
> Implementa el pipeline downstream del driver Knowledge Distillation: código → nota atómica → MOC.

## Activación
- `/wiki` — lista topics disponibles sin fuentes cargadas
- `/wiki <topic>` — genera nota para un topic específico
- `/wiki <topic> --file <ruta>` — genera nota usando archivo fuente específico
- `/wiki --all` — genera todas las notas pendientes listadas en MOC-Mis-Finanzas.md

## Pipeline
1. Leer MOC-Mis-Finanzas.md para identificar *Pendiente* entries
2. Leer archivo fuente (store.jsx, component, util) para extraer estructura y lógica
3. Generar nota siguiendo convenciones:
   - YAML frontmatter: title, tags, source
   - 200-1500 palabras, técnica
   - Enlaces bidireccionales: [[Arquitectura-Estado]], [[MOC-Mis-Finanzas]]
   - Línea final: `> Fuente: <archivo/ruta>`
4. Actualizar MOC-Mis-Finanzas.md: reemplazar `*Pendiente*: \`topic\`` por wikilink real
5. NO crear nota si ya existe (verificar con glob)
6. NO alucinar — extraer todo del código leído

## Reglas de Destilación
- 1 concepto por nota (ej: "Cuentas-Tipos", no "Cuentas-Y-Sync")
- Código verbatim inline (evitar enlaces externos)
- Riesgos y edge cases del reducer
- Ver también con 2-4 wikilinks a notas existentes

## Ejemplo de Salida
```markdown
---
title: Cuentas-Tipos Mis Finanzas
tags: [cuentas, tipos, interes, tae]
source: src/store.jsx (SEED accounts)
---

# Tipos de Cuenta — Mis Finanzas

...

> Fuente: `src/store.jsx` líneas 27-31 (SEED accounts)
```

TERMINATION: Parar tras generar nota(s) y actualizar MOC. No resumir qué hiciste.
