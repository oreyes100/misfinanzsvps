---
title: MOC - Mis Finanzas
tags: [moc, index, navegacion]
source: Wiki/ + src/components/ + store.jsx
---

# MOC — Mis Finanzas (Map of Content)
> Punto de entrada temático. Vincula notas Wiki atómicas con componentes src/.
> Actualizar al crear nuevas notas Wiki.

---

## 🏗️ Arquitectura Core
- [[Arquitectura-Estado]] — store.jsx: useReducer + Context + localStorage + SEED + 30+ actions
- [[Sync-Cloud]] — Vercel Functions + Blob: UUID key, pull/push, syncableSlice, cache-buster
- *Pendiente*: `Arquitectura-Componentes.md` — Bento Grid, Glassmorphism, Framer Motion patterns

## 💰 Dominio Financiero
- [[Cuentas-Tipos]] — checking/savings/deposit, TAE, accrual daily/monthly, capped accounts
- [[Multi-Moneda]] — EUR/USD/GBP/MXN + BTC/ETH, FX simulado, conversión transferencias
- [[Portfolio-Multiactivo]] — Crypto, Gold (€/g), Real Estate, Depreciating assets
- [[Intereses-Automaticos]] — accrueInterest, daily/monthly, lastAccrual tracking, capped model

## 🤖 IA Integrada
- [[MCP-Config]] — Configuración MCP (Filesystem, GitHub, Context7, Playwright)
- [[IA-Importacion-Cuentas]] — Drive/Photos → OCR multi-proveedor → revisión de propuestas por cuenta
- [[Bot-Telegram]] — Webhook de recibos con propuesta + botones ✅/❌ (aprobación obligatoria)
- *Pendiente*: `IA-Categorizacion.md` — utils.js: categorize() por keywords + confidence scoring
- *Pendiente*: `IA-Asistente.md` — Assistant.jsx: human-in-the-loop, preview actions, voice, OCR
- *Pendiente*: `IA-Voz-OCR.md` — Web Speech API (es-ES) + tesseract.js receipt scanning

## 🎨 UI/UX
- *Pendiente*: `UI-Glassmorphism.md` — Glass 2.0, refracción animada, dark navy default
- *Pendiente*: `UI-Accesibilidad.md` — WCAG 2.2: contraste, focus, keyboard, aria-live, prefers-reduced-motion
- *Pendiente*: `UI-Charts.md` — SVG LineChart/PieChart accesibles (role=img, descripciones)

## 🔧 Configuración y Settings
- *Pendiente*: `Settings-Schema.md` — baseCurrency, spendLimit, rates, scheduled, biometric
- *Pendiente*: `Categorias-CRUD.md` — Categories.jsx: color, keywords para IA, system categories

## 📦 Deploy y Ops
- *Pendiente*: `Deploy-Vercel.md` — `vercel --prod`, env vars, Blob store config
- *Pendiente*: `Dev-Workflow.md` — `npm run dev` (Vite proxy), `npm run build`, lint, typecheck

---

## 🔗 Enlaces Rápidos a Código
| Componente | Archivo | Líneas Clave |
|------------|---------|--------------|
| Estado Global | `src/store.jsx` | 1-548 (SEED, reducer, sync, provider) |
| Utilidades | `src/utils.js` | FX, categorize, NL parser, format |
| Dashboard | `src/components/Dashboard.jsx` | Bento Grid asimétrico |
| Asistente IA | `src/components/Assistant.jsx` | Chat + voice + preview + OCR |
| Cuentas | `src/components/Accounts.jsx` | CRUD + TAE + accrual config |
| Importar (IA) | `src/components/IaImport.jsx` | Drive/Photos → revisión → registro |
| Bot Telegram | `src/components/TelegramAgent.jsx` | Vinculación + webhook del bot |
| Sync API | `api/sync.js` | GET/POST Vercel Function |
| Import API | `api/google-import.js` | Batch + clasificación por bloques |
| Bot API | `api/telegram.js` + `api/telegram-config.js` | Webhook + setWebhook |
| Config Vite | `vite.config.js` | Proxy `/api` → prod |

---

## 📝 Convenciones Wiki
- **Frontmatter YAML obligatorio**: `title`, `tags`, `source`
- **Mínimo 40 palabras** por nota atómica
- **Trazabilidad**: línea `> Fuente: <archivo/ruta>` al final
- **Enlaces bidireccionales**: `[[Arquitectura-Estado]]` ↔ `[[MOC-Mis-Finanzas]]` en ambas direcciones
- **Densidad técnica ≥ 3.0** (heurística: líneas con código/ref vs. totales)

> Fuente: `scripts/vault_lint.py` thresholds + `CLAUDE.md` restricciones