# Plan — Wargame 11: Operación Aprendizaje Continuo (2026-08-18)

> Repo: `oreyes100/misfinanzsvps` · Rama: `main` (HEAD `30014ca`)
> Estado: **COMPLETADO (2026-08-18)** — 4 fases implementadas + tests + build OK.
> Deploy VPS pendiente por SSH caído (207.248.113.8:2223 timeout; app viva en HTTP).

## 🚨 Diagnóstico real (Ground Truth, verificado con grep/curl en VPS)

| Hallazgo | Realidad | Estado |
|---|---|---|
| Provider OCR del pipeline Hermes | `extractFromImage` usa Paddle primero (`cfg.ocrUrl` :8765), Gemini solo fallback | ✅ YA paddle |
| Provider OCR del bot Telegram | `extra.js:420` → `classifyImage` con `binding.aiProvider \|\| "gemini"` | ❌ gemini default |
| Fallo de cuentas en transfer | `handleTransfer` → `throw` → transacción abortada | ❌ no llega a MCP |
| Aprendizaje existente | `learnAccountAliases` → `state.transferAliases`; `bankAccountMap` en config.json | ⚠️ parcial |
| Imagen para el EditPanel | `receiptId` → IndexedDB del cliente; imagen llega al servidor | ❌ brecha |

## 🧱 Brecha de arquitectura (bloqueante)

Para que una transacción conflictiva aparezca en el menú MCP **con su imagen**, el
servidor debe guardar la imagen y el cliente debe poder descargarla. Opciones:

- **A. Endpoint `/api/evidence/:id`** — el bot/processor guarda la imagen en
  `server/evidence/` (hash), la transacción lleva `evidenceId`; el cliente
  muestra `<img src="/api/evidence/abc.jpg">`. Funciona con la infra actual
  (nginx proxya /api/* → server.mjs:3000).
- **B. Base64 en la propuesta** — la imagen viaja en el estado sync (payload grande,
  no recomendado).
- **C. Solo texto** — mostrar el motivo del conflicto sin imagen (pierde el
  objetivo del wargame).

## 📋 Fases adaptadas

### Fase 1 — Paddle por defecto en el bot Telegram
- `server/extra.js` `handleMessage`: antes de `classifyImage`, probar PaddleOCR
  local (`ocrImage` de `server/hermes/ocr.mjs`) + parser local
  (`parseOcrText` de `server/hermes/local.mjs`). Si produce resultado → usarlo.
  Gemini solo fallback. Respeta `binding.aiProvider` si es explícito.
- Criterio: bot procesa imagen con :8765 sin consumir Gemini.

### Fase 2 — Conflictivas al menú MCP con imagen
- `processor.mjs` `handleTransfer`: en vez de `throw`, crear transacción con
  `pendingResolution: { reason, from, to }` + guardar imagen (`/api/evidence`).
- Empujar item a `reviewQueue.pending` con `classification: "needs_fix"` +
  `evidenceId` (o `receiptId` si es OCR local).
- Criterio: item ⚠️ Corregir con thumbnail en el menú MCP.

### Fase 3 — Aprender de correcciones del menú MCP
- Nuevo endpoint `POST /api/learn` (server.mjs): actualiza `bankAccountMap` /
  `merchantCategoryMap` / `transferRules` (persistidos en config.json o tabla).
- `EditPanel` guardado: si `pendingResolution` existió y el usuario resolvió
  cuentas/categoría → `POST /api/learn`.
- Criterio: corregir "Banorte→BYD King" → `bankAccountMap` crece → próxima se resuelve sola.

### Fase 4 — Aprendizaje por lenguaje natural (Telegram)
- Parser de enseñanzas en `handleMessage` (mensajes de texto, no imagen):
  patrones `<alias> es la cuenta de <cuenta>`, `<alias> = <cuenta>`.
- Misma vía `/api/learn`. Confirmación "✅ Aprendido".
- Criterio: "banorte es la cuenta del BYD king" → map actualizado + confirmación.

### Fase 5 — Deploy + verificación
- Tests server (`server/categorize.test.mjs` patrón) + build + deploy VPS + curl.

## ⚠️ Riesgos
- Guardar imágenes en disco requiere tamaño/limpieza (evitar acumulación).
- `/api/learn` modifica config.json → respaldo + relectura sin restart.
- El review queue se regenera en cliente desde txs (`buildUnreviewedItems`);
  asegurar que el item conflictivo no se borre al sincronizar.

## ✅ Verificación final

### Fase 1 — Paddle por defecto en el bot Telegram
- ✅ `paddleFirst(buf, { mime })` en `server/extra.js`: Paddle local primero,
  Gemini solo fallback. Implementado.
- Criterio cumplido en código: bot procesa imagen con :8765 sin consumir Gemini
  (pendiente de verificación en VPS cuando vuelva el SSH).

### Fase 2 — Conflictivas al menú MCP con imagen
- ✅ `apply.addConflictTransaction` + `handleTransfer` sin `throw` +
  `saveEvidenceImage` (cfg.evidenceDir) + `GET /api/evidence/:name` +
  `buildUnreviewedItems` propaga `pendingResolution`/`receiptUrl`. Implementado.
- Decisión: se propagó la evidencia como `receiptUrl` remota en el item (el
  `EditPanel`/`ReceiptThumbnail` ya soporta URLs remotas). El review queue se
  regenera desde las txs sincronizadas, así el item conflictivo persiste.
- Criterio: item ⚠️ Corregir con thumbnail en el menú MCP — listo en código.

### Fase 3 — Aprender de correcciones del menú MCP
- ✅ `POST /api/learn` (`server/learn.mjs`, escritura atómica de config.json) +
  `McpMenu.onSaveFix` dispara aprendizaje cuando el item tenía `pendingResolution`.
- Criterio: corregir un conflicto en el EditPanel → `bankAccountMap`/`merchantCategoryMap`
  crecen → próxima vez el pipeline lo resuelve solo.

### Fase 4 — Aprendizaje por lenguaje natural (Telegram)
- ✅ `learnFromText` en `server/extra.js`: patrones `<alias> es la cuenta de
  <cuenta>` y `<merchant> es <categoría>` → `/api/learn` → "✅ Aprendido".
- Criterio: "banorte es la cuenta del byd king" → map actualizado + confirmación.

### Fase 5 — Deploy + verificación
- ✅ Tests: 389 pass (vitest: +3 `buildUnreviewedItems` WG11; node:test: +2
  `addConflictTransaction`). Build local OK.
- ⏳ Deploy VPS + curl pendiente por SSH caído.
- Git: `30014ca` pusheado a main. Docs: este plan + `implementation_plan_ia_agentes.md`.
- Bot procesa imagen → usa Paddle (journal: event "ocr").
- Imagen conflictiva → item ⚠️ en menú MCP con thumbnail.
- Corrección → `/api/learn` → próxima imagen se resuelve sola.
- Telegram NL: "banorte es la cuenta del BYD king" → "✅ Aprendido".
