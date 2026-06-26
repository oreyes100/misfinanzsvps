# Mis Finazas — Análisis de Código y Propuestas de Mejora

**Fecha**: 2026-06-25
**Proyecto**: Mis Finazas — MVP finanzas personales
**Stack**: React 19 + Vite 6 + Tailwind CSS v4 + Capacitor 8 + Vercel Blob
**Líneas de código fuente** (src/): ~7,200 LOC (20 archivos JSX/JS)
**Subproyecto Cuentas/**: Node.js + SQLite + OCR (servidor local paralelo)

---

## 1. Arquitectura General

La app es una SPA React 19 con estado global vía `useReducer + Context` (store.jsx, 548 líneas, 30+ action types). La persistencia es doble: localStorage (clave `mis-finazas-v1`) y sync en la nube con Vercel Blob Store. Tiene wrapper nativo Android vía Capacitor 8, autenticación client-side con SHA-256, OCR con tesseract.js, parsing de PDFs bancarios con pdfjs-dist, y un asistente agéntico con Web Speech API.

Hay un subproyecto `Cuentas/` que es un servidor Node.js independiente (Express + SQLite + Tesseract) con su propio dashboard React. Parece una iteración anterior o paralela que no está integrada con la app principal.

---

## 2. Problemas Detectados

### 🔴 Críticos (Seguridad)

**P1. Autenticación sin backend — hashes expuestos en localStorage**
- `auth.js` guarda usuarios con SHA-256 **sin salt** en `localStorage`. Cualquiera con acceso al navegador puede extraer los hashes y atacarlos offline con rainbow tables.
- La contraseña del admin (`Michoacan1`) está sembrada en el código fuente (`ensureSeed()` en auth.js línea 53). Es visible en el bundle de producción.
- **Propuesta**: Migrar a autenticación de servidor. Mínimo viable: Vercel Functions con bcrypt/argon2 + JWT. Alternativa: usar Vercel Auth o Clerk para no reinventar la rueda.

**P2. Sync API sin autenticación real**
- `api/sync.js` trata cualquier `id` válido (UUID) como credencial. Si se filtra el sync ID (localStorage, URL, logs), cualquier persona puede leer y sobrescribir todos los datos financieros.
- El CORS está en `*` — cualquier sitio web puede hacer peticiones al endpoint.
- **Propuesta**: Vincular el sync ID al usuario autenticado (token JWT en header). Restringir CORS al dominio de producción + `capacitor://` para la app nativa.

### 🟠 Altos (Rendimiento y Datos)

**P3. `tick_prices` cada 4s en el main thread**
- El reducer `tick_prices` corre cada 4 segundos en el hilo principal, causando re-renders completos del árbol React. Con datos sintéticos (random walk) esto no aporta valor real al usuario — son precios simulados.
- **Propuesta**: (a) Mover a Web Worker con `postMessage` para no bloquear la UI. (b) Aumentar el intervalo a 15-30s. (c) Mejor aún: ofrecer precios reales vía API (CoinGecko para cripto, exchangerate-api para FX) con un intervalo de 60s, y eliminar la simulación.

**P4. localStorage sin debounce**
- `store.jsx` línea 250: `localStorage.setItem(KEY, ...)` se ejecuta en **cada cambio de estado**, incluyendo los `tick_prices` cada 4s. Esto escribe varios KB al disco 15 veces por minuto aunque los datos reales no cambien.
- **Propuesta**: Separar `priceHistory`/`fx` del estado persistido (ya se hace para sync, aplicar también a localStorage) y agregar debounce de 500ms.

**P5. Sync sin resolución de conflictos**
- El modelo es last-write-wins. Si dos dispositivos editan simultáneamente, el último push gana y los cambios del otro se pierden silenciosamente. `cloudReadyRef` previene que un dispositivo nuevo machaque la nube al primer pull, pero no conflictes reales.
- **Propuesta**: (a) Mínimo: timestamp en cada registro (user-level CRDT-lite). (b) Medio: usar Yjs para el estado sincronizable. (c) Pragmático: mostrar un diff y pedir confirmación si el pull trae datos con timestamp más reciente que el local.

**P6. Tasas FX hardcodeadas**
- `BASE_FX` en utils.js tiene tasas estáticas (USD: 0.92, BTC: 61500, etc.). En producción, el usuario ve precios simulados que no reflejan el mercado real.
- **Propuesta**: Integrar API gratuita (exchangerate-api.com para fiat, CoinGecko para cripto). Cachear en localStorage con TTL de 1h. Fallback a BASE_FX si no hay red.

### 🟡 Medios (Calidad y Deuda Técnica)

**P7. Cero tests**
- No hay archivos de test. El reducer (30+ actions, lógica financiera con cálculos de intereses escalonados) es el punto más crítico a testear.
- **Propuesta**: Empezar con Vitest + React Testing Library. Cobertura prioritaria: `reducer` (accrue, transfer, FX), `categorize()`, `parseIntent()`, `accrueInterest()` con tramos escalonados. Meta inicial: 60% cobertura del store.

**P8. Sin TypeScript**
- 7,200 líneas de JSX/JS sin tipos. El reducer tiene 30+ action types sin discriminación — fácil mandar un action.type mal escrito y que falle silenciosamente.
- **Propuesta**: Migrar gradualmente: (1) Renombrar a `.tsx`/`.ts`, (2) Tipar el `reducer` (discriminated union de actions), (3) Tipar `State` y `Account`. No hace falta migrar todo a la vez — empezar por store.jsx y utils.js.

**P9. Subproyecto Cuentas/ — deuda técnica**
- `Cuentas/` es un servidor Node.js paralelo con su propio SQLite, dashboard React, y 39 imágenes de recibos duplicadas (5.1 MB). `server.js.broken.bak` está en el repo. `Cuentas.zip` también.
- La funcionalidad de OCR ya existe en la app principal (`src/ocr.js`, `src/statement-parser.js`).
- **Propuesta**: (a) Si Cuentas/ ya no se usa: archivar o eliminar. (b) Si sigue activo: integrar su funcionalidad en la app principal y eliminar el servidor paralelo. (c) Mínimo: mover a repo separado para limpiar el workspace.

**P10. HMR roto por exports incompatibles**
- El log del servidor muestra repetidamente: `Could not Fast Refresh ("currentCycle" export is incompatible)`. `store.jsx` exporta tanto el provider como funciones selectoras (`netWorthEUR`, `monthSpend`, `currentCycle`, `pendingCardPayments`), lo que rompe el Fast Refresh de Vite.
- **Propuesta**: Extraer los selectores a `src/selectors.js`. Mantener `store.jsx` con solo el Provider y el hook `useStore`.

**P11. Sin lazy loading de dependencias pesadas**
- `tesseract.js` (~2 MB) y `pdfjs-dist` (~1.5 MB) se cargan en el bundle principal aunque solo se usan al escanear recibos/estados de cuenta.
- **Propuesta**: `React.lazy()` + `import()` dinámico para `Assistant.jsx` (OCR) y el parser de PDFs. Reduciría el bundle inicial en ~3.5 MB.

**P12. No hay CI/CD**
- El deploy es manual (`vercel --prod` o scripts `.bat`/`.command`). No hay validación automática de build, lint ni tests antes de desplegar.
- **Propuesta**: GitHub Actions workflow: `npm run build` + `npx vitest run` (cuando existan tests) + `vercel deploy --prod` on push to main.

### 🟢 Bajos (Pulido)

**P13. Categorización por keywords frágil**
- `categorize()` usa matching de substrings. "Mercado" matchea "Comida" (keyword "comida" está en "mercado" → falso positivo). No maneja typos ni sinónimos regionales.
- **Propuesta**: (a) Corto plazo: usar word-boundary regex en vez de `includes`. (b) Medio: few-shot con embeddings (OpenAI text-embedding-3-small, $0.02/1M tokens). (c) Largo: modelo local ligero (ONNX) para offline.

**P14. 39 imágenes duplicadas en Cuentas/uploads/**
- Los nombres sugieren que el mismo recibo se subió múltiples veces (ej. 8 copias de "WhatsApp Image 2026-06-07 at 2.28.47 PM.jpeg" con prefixes timestamp distintos). El uploader no deduplica.
- **Propuesta**: Hash del archivo (SHA-256) antes de guardar. Si ya existe, reusar.

**P15. Sin manejo de errores de red en sync push**
- `pushNow()` hace `throw` si `!r.ok`, pero el `catch` en el effect solo hace `setSyncStatus("error")`. No hay retry con backoff, ni cola de reintentos.
- **Propuesta**: Cola de cambios pendientes en IndexedDB. Retry con backoff exponencial (1s, 2s, 4s, max 30s). Mostrar indicador de "cambios sin sincronizar" al usuario.

**P16. Sin validación de entorno**
- `.env.local` existe pero no se valida al arrancar. Si falta una variable (ej. `BLOB_READ_WRITE_TOKEN`), la sync falla silenciosamente.
- **Propuesta**: Script de startup que valide vars requeridas con mensajes claros.

**P17. Accesibilidad limitada**
- Hay un skip link y algo de ARIA, pero faltan: navegación por teclado en modales, live regions para transacciones nuevas, roles en la navegación bottom.
- **Propuesta**: Auditoría con axe-core. Mínimo: tramp focus en modales, `aria-live` para notificaciones de sync, `role="navigation"` en BottomNav.

---

## 3. Resumen de Propuestas Prioritarias

| # | Problema | Impacto | Esfuerzo | Prioridad |
|---|----------|---------|----------|-----------|
| P1 | Auth sin backend | 🔴 Seguridad | Alto | Inmediata |
| P2 | Sync API sin auth | 🔴 Seguridad | Medio | Inmediata |
| P3 | tick_prices en main thread | 🟠 Performance | Bajo | Alta |
| P4 | localStorage sin debounce | 🟠 Performance | Bajo | Alta |
| P6 | FX hardcodeadas | 🟠 Datos | Medio | Alta |
| P7 | Cero tests | 🟡 Calidad | Medio | Alta |
| P10 | HMR roto | 🟡 DX | Bajo | Media |
| P11 | Sin lazy loading | 🟡 Performance | Bajo | Media |
| P9 | Deuda Cuentas/ | 🟡 Tech debt | Medio | Media |
| P8 | Sin TypeScript | 🟡 Calidad | Alto | Media |
| P5 | Sync sin conflictos | 🟠 Datos | Alto | Media |
| P13 | Categorización frágil | 🟢 UX | Medio | Baja |
| P15 | Sin retry de sync | 🟢 UX | Bajo | Baja |
| P17 | Accesibilidad | 🟢 UX | Medio | Baja |

---

## 4. Quick Wins (1-2 horas cada uno)

1. **Debounce de localStorage** (P4): Envolver el `setItem` en un debounce de 500ms. Excluir `priceHistory` y `fx` del estado persistido.
2. **Separar selectores** (P10): Mover `netWorthEUR`, `monthSpend`, `currentCycle`, `pendingCardPayments` a `src/selectors.js`. Restaura Fast Refresh.
3. **Lazy load de Tesseract/PDF** (P11): `const Assistant = React.lazy(() => import('./components/Assistant.jsx'))` con Suspense.
4. **Aumentar intervalo tick_prices** (P3): Cambiar 4000ms → 30000ms. Reduce re-renders en 87%.
5. **Limpiar Cuentas/** (P9): Eliminar `server.js.broken.bak`, `Cuentas.zip`, y las 39 imágenes duplicadas. `.gitignore` ya las excluye pero siguen ocupando espacio.

---

## 5. Roadmap Sugerido (3 sprints de 2 semanas)

### Sprint 1 — Fundaciones
- Migrar auth a Vercel Functions con bcrypt + JWT (P1)
- Vincular sync ID al usuario autenticado (P2)
- Debounce localStorage + excluir precio/FX (P4)
- Separar selectores (P10)
- Lazy load de dependencias pesadas (P11)
- Setup Vitest + primeros tests del reducer (P7)

### Sprint 2 — Datos y Performance
- Integrar API de precios reales (CoinGecko + exchangerate-api) (P6)
- Mover tick_prices a Web Worker (P3)
- Retry de sync con backoff + cola en IndexedDB (P15)
- Deduplicación de uploads por hash (P14)
- CI/CD con GitHub Actions (P12)

### Sprint 3 — Calidad
- Migrar store.jsx + utils.js a TypeScript (P8)
- Resolución de conflictos con timestamps (P5)
- Mejorar categorización con word-boundary regex (P13)
- Auditoría de accesibilidad con axe-core (P17)
- Archivar/eliminar subproyecto Cuentas/ (P9)

---

*Análisis basado en lectura completa del código fuente (src/, api/, Cuentas/, .claude/, Wiki/, configuración) el 2026-06-25.*
