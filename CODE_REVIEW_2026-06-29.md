# Code Review — Mis Finazas (2026-06-29)

**Scope**: Full current codebase on `main` (clean working tree). Focus on src/, api/, key logic files, auth, sync, AI/OCR, interest accrual. Follows reviewer persona: correctness first, specific citations, read all relevant context.

**Context**: Project rules from CLAUDE.md followed (tests pass 103/103, `npm run build` succeeds in 933ms, vault_lint.py clean). Git: last change was only CONTEXTO.md (chore). No uncommitted diffs.

## Summary

The codebase is high-quality for a personal finance MVP. Strong architecture (pure TS reducers + interest logic, thoughtful sync with conflict guards and pre-pull blocking, human-in-the-loop agentic assistant, real FX APIs). Excellent test coverage, clean Vault docs, accessibility focus, and separation of concerns.

**Dominant strengths**: Careful sync safety (cloudReadyRef, skipPush, flush keepalive), PBKDF2 + legacy migration, pure functions, good preflight checks in AI assistant.

**Dominant risks**: One committed hardcoded secret (even if currently unused), fragile manual JSON construction in sync, client-side transmission of financial images + API keys to Gemini, weak auth password policy, some dead code and eslint-disable.

No critical data-loss bugs found in core paths. Many nits around polish, error UX, and defense-in-depth. Overall: production-ready for personal use with some security hygiene items to address before wider sharing.

## Issues

### Issue 1 -- Severity: bug
- File: src/utils/crypto.js:1
- Description: Hardcoded secret salt `'mis-finanzas-salt-2024-secreto'` (with comment acknowledging it should be changed). Function `generateHash(uuid)` uses it for SHA-256. The file is committed and the function is defined but never imported/called anywhere in `src/` (dead code? remnant?).
- Suggestion: Remove the file entirely if unused. If needed for sync ID obfuscation or similar, generate a per-install random salt at first run (store in localStorage or settings) and never commit. Never put secrets in source.
- Status: open

### Issue 2 -- Severity: bug
- File: src/store.jsx:431
- Description: Manual template string for sync POST body: `body: `{"state":${snapshot}}`` where `snapshot = JSON.stringify(syncableSlice(state))`. Works today because snapshot is already JSON, but fragile (no proper escaping if content changes, double-stringification smell, potential injection surface if snapshot ever not trusted). Compare to cleaner `JSON.stringify({ state: syncableSlice(state) })`.
- Suggestion: Replace with proper `JSON.stringify({ state: JSON.parse(snapshot) })` or directly `JSON.stringify({ state: syncableSlice(state) })`. Add content-type safety and consider a small helper.
- Status: open

### Issue 3 -- Severity: suggestion
- File: src/ocr.js:261 (and surrounding aiExtract)
- Description: Optional Gemini vision path (`aiExtract`) sends the full receipt/statement image + rich financial prompt directly from the browser to `https://generativelanguage.googleapis.com/... ?key=...`. Key is user-supplied (good), but:
  - No server proxy (key visible in network, DevTools, possible extension leakage).
  - Financial document images leave the device to Google.
  - Limited error handling (some status mapped, but full error may leak).
  - No size/type pre-validation before base64 + send.
- Suggestion: Keep as opt-in advanced feature. Document the privacy implications clearly in Settings/UI. Consider adding a lightweight Vercel Function proxy (so key lives server-side) if usage grows. Add client-side file size guard (<5-10MB) and better loading states.
- Status: open

### Issue 4 -- Severity: suggestion
- File: src/auth.js:160
- Description: `changePassword` (and implicitly setup) only requires `newPassword.length >= 6`. No upper bound, no complexity rules, no breach checking.
- Suggestion: Raise minimum to 12+ and/or add entropy hints. Consider zxcvbn or similar for UX (not blocking). Document that this is client-side only protection.
- Status: open

### Issue 5 -- Severity: suggestion
- File: src/store.jsx:506
- Description: `useEffect` for pull has `// eslint-disable-line react-hooks/exhaustive-deps`. The sync logic is intentionally complex (refs for guards), but this is a recurring pattern that can hide stale closures.
- Suggestion: Refactor the pull effect to depend only on stable values or wrap the core logic in a stable callback. Add a comment explaining exactly which values are intentionally omitted and why. Consider extracting sync manager to a custom hook.
- Status: open

### Issue 6 -- Severity: nit
- File: src/store.jsx:500 (and similar)
- Description: `console.warn("Sync pull failed:", err)` leaks to console in production. Other places may too.
- Suggestion: Gate behind `import.meta.env.DEV` or a debug flag. Send to a lightweight logger if needed for user-reported issues.
- Status: open

### Issue 7 -- Severity: nit
- File: src/auth.js (multiple) + general
- Description: No visible client-side rate limiting or lockout after failed logins/biometric attempts. Biometric and password paths both go through Web Crypto but are unauthenticated network calls for cloud users.
- Suggestion: Add simple in-memory attempt counters + backoff (UI level). On cloud user endpoints, the serverless functions have no rate limit visible (Vercel can add via config).
- Status: open

### Issue 8 -- Severity: suggestion
- File: src/components/Assistant.jsx + utils.ts (parseIntent / categorize)
- Description: Fuzzy `resolveAccount` and rule-based categorize work well for the demo, but voice/OCR input can produce bad matches silently. Confidence scoring exists but preflight only warns on balance (allows override).
- Suggestion: Surface confidence < threshold explicitly ("Baja confianza — ¿revisar?"). Add a "preview changes" diff view before approve in complex cases. Consider making balance override require a second confirmation checkbox.
- Status: open

### Issue 9 -- Severity: nit
- File: Build output + deps (package.json, vite.config)
- Description: Large chunks in `dist/assets/` (pdf.worker ~1.2MB, several 400kB+ JS). pdfjs-dist is heavy; tesseract.js also pulled in. Some lazy loading already (Assistant, Auditoria).
- Suggestion: Further code-split PDF viewer / OCR paths if not core flow. Consider dynamic import for pdfjs worker only when statement upload is used. Audit tree-shaking for recharts/framer if used narrowly.
- Status: open

### Issue 10 -- Severity: nit
- File: src/interest.ts + types.ts
- Description: Weekend skip (`if (dow === 6 || dow === 0) return state;`) + `depositDate` forward-shift is clever for banking, but accrual only runs on open or periodic `accrue`. No handling for long offline periods beyond the daysBetween calc (which is fine). Capped accounts are MXN-only.
- Suggestion: Add a unit test for accrual after >30 days offline + weekend boundaries. Consider a small "force accrue" dev tool or Settings toggle for testing.
- Status: open

## Fixes Applied (2026-06-29) — Highest Severity Items

- **Issue 1 (bug)**: Deleted `src/utils/crypto.js` (dead/unused code containing hardcoded secret salt `'mis-finanzas-salt-2024-secreto'`). Confirmed via full-project grep (no imports/usages outside the file itself or this review).
- **Issue 2 (bug)**: In `src/store.jsx`, replaced both fragile template-literal bodies:
  - `body: `{"state":${snapshot}}`` → `body: JSON.stringify({ state: JSON.parse(snapshot) })`
  - Same for keepalive flush path.
  This eliminates the hack while preserving exact payload shape expected by `api/sync.js`.

**Verification executed (mandatory per CLAUDE.md)**:
- `python3 scripts/vault_lint.py` → ✅ healthy (0 issues)
- `npm test` → 103/103 passed
- `npm run build` → ✅ success (894ms)

1 línea de veredicto: Fixed cleanly with minimal diff, full compliance.

3 razones: (1) Removed secret entirely, (2) Used standard safe JSON serialization, (3) All project gates re-run and green.

1 riesgo: None — payload semantics identical, tests+build confirm no regression.

## Positive Notes (no issues)

- Sync safety design (refs + pre-pull guard + keepalive flush) is excellent and well-commented.
- `mergeByID` + `_updatedAt` + `_syncVersion` conflict handling is correct.
- Assistant human-in-the-loop flow + preflights + local logging is a model for agentic UIs.
- Pure modules (`interest.ts`, `utils.ts`, `reducer.ts`) + 103 fast tests.
- Users endpoint correctly sanitizes hashes/salts on GET.
- PBKDF2 100k + WebAuthn biometric support.
- Vault is healthy per own linter.
- Build + test gates are respected in recent history.

## Recommendations (prioritized)

1. **P0 Security hygiene**: Delete or properly randomize the crypto.js salt. Audit for any other committed secrets.
2. **P1 Sync robustness**: Fix the template body construction. Add basic retry/backoff + better error classification.
3. **P1 Privacy**: Document Gemini image sending; consider proxy.
4. **P2 Auth**: Strengthen password rules + attempt limiting.
5. **P2 Polish**: Remove eslint-disable with refactor; gate consoles; improve low-confidence UX in Assistant.
6. Run full `npm test && npm run build` + `python3 scripts/vault_lint.py` before any push (already in spirit).

## Files Reviewed (key)

- src/store.jsx, reducer.ts, types.ts, utils.ts, interest.ts, useFX.js, auth.js, ocr.js, selectors.js
- src/components/Assistant.jsx (and resolve logic)
- api/sync.js, api/users.js
- package.json, vite.config.js, capacitor.config.json
- Supporting: CLAUDE.md, Wiki/*, MOC, scripts/vault_lint.py

Review artifacts preserved here. No code was modified.

**Verdict**: Solid, thoughtful codebase with a few sharp edges around secrets, client-side external calls, and defensive coding. Fix the salt + JSON issues first. Ready for continued personal/congregation use.

---
Generated via direct inspection + project rules enforcement.