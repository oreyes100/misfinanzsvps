# Plan — OPERACIÓN RECEIPT VISION (adaptado al código real)

> Fecha: 2026-08-17 · Estado: **COMPLETADO** (commit `fab1faa`, desplegado `index-D_UsUwfc.js`)
> Repo: `oreyes100/misfinanzsvps` · Rama: `main` (HEAD `4665215`)

## 1. Diagnóstico verificado (Context-First, previo a código)

El wargame acierta en 4 de 6 huecos, pero asume un esquema de transferencias
(`type:"transfer"` + `transferPair`/`transferId`) que **no existe** en el código.
El esquema real usa `counterpartId` (store.jsx:208-209) sobre transacciones
normales. También asume que Transactions tiene un editor "parcial": en realidad
`TransactionModal` (Modals.jsx:221) **ya edita** descripción, monto, fecha,
cuenta, categoría, subcategoría, notas y `counterpartId`; el editor pobre es
solo el de **MCP** (`EditPanel`, 2 campos).

| Fase | Realidad | Veredicto |
|---|---|---|
| RV-01 Recibo visible en MCP | Items de revisión NO llevan imagen (buildQueueItems no persiste thumbnail/url) | 🔴 HUECO REAL |
| RV-02 Edición completa MCP | EditPanel solo categoría+cuenta; TransactionModal ya es completo | 🔴 HUECO (solo MCP) |
| RV-03 Storage de recibos | No existe receiptStorage ni receiptId en types.ts | 🔴 HUECO REAL |
| RV-04/05 Transferencias | Esquema real = `counterpartId`; update_transaction no toca el par → duplicados al cambiar destino | 🔴 HUECO REAL (esquema distinto al del wargame) |
| RV-06 Editor unificado | 2 editores distintos (EditPanel + TransactionModal) | 🟡 CIERTO |

## 2. Alcance adaptado (6 fases → 5 piezas reales)

**No se reescribe TransactionModal** (ya es el editor completo de Transactions);
se extiende para recibos persistentes y se reutiliza su lógica en MCP.

### RV-01 — `src/components/ReceiptPreview.jsx` (nuevo)
- `ReceiptThumbnail` (mini, click → viewer) y `ReceiptViewer` (modal full-screen,
  zoom 0.5–3x, rotación 90°), usando Framer Motion + ARIA dialog.
- Fuente de imagen: `receiptUrl` (Google Photos) o `receiptBlob` (IndexedDB/OCR).

### RV-02 — Editor completo en MCP (extender `EditPanel` → `McpEditPanel`)
- Campos nuevos: **monto, fecha, descripción** (además de categoría + cuenta).
- Usa `ReceiptThumbnail`/`ReceiptViewer` si el item trae imagen.
- El guardado sigue el flujo actual (`onSaveFix` → `add_transaction` con patch).
- No es editor unificado nuevo: es el mismo patrón que TransactionModal (form local).

### RV-03 — `src/services/receiptStorage.js` (nuevo, IndexedDB)
- `storeReceipt(blob, txId)` → comprime a JPEG ≤1600px q0.8 → guarda en IDB
  (`misfinanzas_receipts/images`), devuelve `receiptId`.
- `loadReceipt(receiptId)`, `deleteReceipt`, `updateReceiptTransactionId`,
  `cleanupOrphanReceipts(validTxIds)`, `enforceLimits` (500 rec / 500MB).
- Hook `useReceiptImage(receiptId)` → blob URL temporal con revoke.
- En `types.ts`: `receiptId?: string` en `Transaction`.

### RV-04 — Toggle transferencia en edición
- En el editor MCP y en `TransactionModal`: botón/toggle que convierte
  gasto↔transferencia. En el esquema real, transferencia = par de txs con
  `counterpartId` y categoría `"Transferencia"`.
- Reducer: `convert_to_transfer` (gasto/ingreso → par con counterpartId) y
  `convert_from_transfer` (par → tx simple). Atómicos (eliminan + crean el par).

### RV-05 — Edición atómica de transferencias (`edit_transfer` en reducer)
- Esquema real: `counterpartId`. `update_transaction` actualizado para que, si la
  tx tiene `counterpartId`, reajuste el par de saldos de forma atómica
  (monto/descripción/fecha/destino aplicados a ambas patas).
- `edit_transfer`: cambia el destino re-asignando `counterpartId` de ambas patas,
  sin dejar transacciones huérfanas ni duplicar saldos.
- Test dedicado: cambiar destino NO duplica, par consistente.

### RV-06 — Consistencia MCP/Transactions
- MCP y Transactions comparten `receiptStorage` + `ReceiptPreview` +
  `ReceiptViewer`; los dispatches al store son los mismos casos
  (`update_transaction`/`convert_*`/`edit_transfer`).

## 3. Archivos

| Archivo | Tipo | Fase |
|---|---|---|
| `src/services/receiptStorage.js` | nuevo | RV-03 |
| `src/components/ReceiptPreview.jsx` | nuevo | RV-01 |
| `src/store.jsx` | editar (convert_to/from_transfer, edit_transfer, update_transaction par, add_transaction receiptId) | RV-04/05 |
| `src/components/McpMenu.jsx` | editar (EditPanel → McpEditPanel completo + thumbnail) | RV-02/01 |
| `src/components/Modals.jsx` | editar (TransactionModal: receiptId al registrar + toggle transferencia) | RV-03/04 |
| `src/services/photoScanner.js` | editar (buildQueueItems incluye thumbnail/url en item) | RV-01 |
| `src/types.ts` | editar (receiptId, tags) | RV-03 |
| `src/receiptVision.test.js` | nuevo (tests del wargame) | todos |

## 4. Verificación
- `npm test` (355 actuales + nuevos) → 100% verde. **Resultado: 369 tests, 19 archivos.**
- `npm run build` → exitoso; `node --test server/...` sin regresiones.
- Deploy `/var/www/misfinanzas/` + `chown www-data`; push `main`; alinear VPS.

## 5. Riesgos
- IndexedDB no disponible (modo privado/WebView viejo) → fallback: mostrar
  "Recibo no disponible" y no romper la edición.
- Reajuste de saldos al editar transferencias (doble cuenta) → lógica atómica
  con tests que validan suma de saldos invariante.
- Tocar `store.jsx` → `vault_lint.py` + build antes de commit.

## 6. Implementado (commit `fab1faa`)
- **RV-01 Recibo visible**: `ReceiptPreview.jsx` (Thumbnail + Viewer zoom 0.5–3x,
  rotación 90°, ARIA dialog z-[70]); `photoScanner` persiste `receiptUrl`
  (thumbnail 800px); Modals `TransactionModal` captura el blob en `scanReceipt`.
- **RV-02 Edición completa MCP**: `EditPanel` reescrito (descripción, monto,
  fecha, categoría, cuenta + recibo + toggle "es una transferencia" con destino).
- **RV-03 Storage**: `receiptStorage.js` (IndexedDB, compresión JPEG ≤1600px q0.8,
  límites 500 rec/500MB, cleanup 30 días, `enforceLimits`); `types.ts` gana
  `receiptId`/`tags`.
- **RV-04/05 Transferencias atómicas**: `transfers.js` (findPair por counterpartId
  mutuo, buildPair, editPair con swap de destino sin duplicados, convertTo/From);
  reducer con `edit_transfer`, `convert_to_transfer`, `convert_from_transfer`,
  `convert_item_to_transfer` (MCP); `update_transaction` deriva a `editTransferPair`.
- **Tests**: `receiptVision.test.js` (14 tests: par, swap atómico, invariante de
  suma de saldos, conversiones).
- **Bug detectado en el camino**: `applyPairBalances` aplicaba la entrada al
  destino viejo en un swap b→c (doble cuenta); refactor a `oldToId`/`newToId`.