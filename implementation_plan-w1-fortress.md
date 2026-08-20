# W1 Fortress (Revisión 2026) — Plan
## Fase 0 — Reconocimiento (completado 20 Ago 2026)
- Endpoints en server/server.mjs: /api/health, /api/users, /api/sync, /api/snapshot, /api/signup, /api/google-*, /api/telegram*, /api/categorize, /api/evidence/:name, /api/learn — router en ~L492.
- Auth actual: /api/users con hash/salt; /api/telegram ya verifica `X-Telegram-Bot-Api-Secret-Token` vs binding.webhookSecret o TELEGRAM_WEBHOOK_SECRET (extra.js:396). /api/categorize+snapshot+learn sin auth (fire-and-forget).
- Cliente: `categorizeSemanticAsync` (utils.ts:168) POST /api/categorize {text,categories} sin token; store.jsx resync GET /api/snapshot?id=syncCode sin token; McpMenu fetch /api/learn sin token.
- SQLite: `db.mjs:14` already `journal_mode=WAL`, `foreign_keys=ON`; integridad `ok`, service `misfinanzas-server.service` activo.
- Rate limit / circuit hoy: solo Drive retry backoff (drive-mcp.mjs), no en server.mjs.
- Validación hoy: solo `if(!text) 400`, no límites de longitud/arrays.
- DECISIÓN CRÍTICA: NO añadir auth a /api/categorize ni /api/snapshot (rompería cliente) → proteger con rate limiting. Auth+token reservado para /api/learn y /api/telegram (X-Telegram-Bot-Api-Secret-Token).
## Fases 1-5 — Entregas
| Fase | Módulo puro | Ruta | Integración | Criterio |
|---|---|---|---|---|
| 1 Auth/RBAC | `server/auth.mjs` | requireLearnAuth(req) lee Bearer == LEARN_TOKEN||hermes.syncCode||config.learnToken; requireTelegramSecret ya existe | server.mjs antes de handleLearn/handleTelegram | learn sin token 401, telegram sin secret 401, categorize sigue sin auth |
| 2 Rate limit + Circuit | `server/ratelimit.mjs` makeRateLimiter({windowMs,max}) ; `server/circuit.mjs` makeCircuitBreaker({threshold,resetMs}) | wrap /api/categorize (30/min/IP) y /api/learn (30/min/IP); circuit en categorize (Gemini 3×429→OPEN 5min fallback semantic:false) | 40 req categorize → 429, circuit OPEN → fallback |
| 3 Retry+Idempotencia | `server/retry.mjs` retryWithBackoff; `server/idempotency.mjs` updateIdStore + learn dedup | Gemini/Paddle retry 3 con jitter; webhook set de update_id persistido; learn misma regla no duplica | mismo learn 2× →1 regla, mismo update_id 2× no duplica tx |
| 4 Validation | `server/validate.mjs` validateCategorize/learn | 400 en text>500, categories>50, merchant>100 etc | casos criterio 400 |
| 5 WAL+Backups | ensure WAL + backup diario + integrity_check | backup a server/data/backup-YYYY-MM-DD.db (7d retention) + PRAGMA checks | journal_mode=wal, backup existe, integrity ok |
## Archivos a crear/editar
- NUEVO: server/ratelimit.mjs, server/circuit.mjs, server/retry.mjs, server/validate.mjs, server/idempotency.mjs, server/auth.mjs
- EDIT: server/server.mjs (middleware, wiring), server/learn.mjs (idempotencia), server/extra.js (internal learn token + idempotencia), src/components/McpMenu.jsx (Bearer syncId), src/fortress.test.js (vitest)
- OPS: backup timer en server.mjs (setInterval)
## Riesgo
- Bloquear cliente por auth en categorize/snapshot → mitigado por decisión crítica (rate-limit no auth).
- VPS build + service restart → verificar `GET /api/categorize` sin token siga 200+fallback.
