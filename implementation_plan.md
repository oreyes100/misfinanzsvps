# Plan: Auditoría precisa con IA comparativa

## Problema
Auditoría marca "todo en orden" con datos incorrectos:
1. `Auditoria.jsx:133` lee `settings.geminiApiKey`; el setting real es `geminiKey` → IA nunca activa, siempre OCR local.
2. `audit.js findMatch` no consume matches: dos cargos idénticos matchean la misma tx registrada.
3. `amount_only` (importe+fecha, descripción distinta) se trata como correcto sin avisar.
4. No detecta asientos fantasma: tx registrada en el período que NO aparece en el estado de cuenta.
5. IA solo extrae; no compara.

## Cambios
| Archivo | Cambio |
|---|---|
| `src/audit.js` | Matching 1-a-1 con consumo; nuevo tipo `phantom_transaction`; items llevan `proposal` editable `{description, amount, date, category, notes}` |
| `src/ocr.js` | Nueva `aiAudit(movements, registered, apiKey, opts)` — Gemini compara listas y devuelve discrepancias JSON con propuestas |
| `src/components/Auditoria.jsx` | Fix `geminiKey`; tras audit local, correr `aiAudit` y usar su checklist (fallback local si falla) |
| `src/components/AuditChecklist.jsx` | Campos editables por item (descripción, categoría, notas) precargados con la propuesta; aplicar con un clic usa valores editados; phantom → eliminar tx |

## Verificación
`npm test` (108) + `npm run build` + prueba manual con extracto.
