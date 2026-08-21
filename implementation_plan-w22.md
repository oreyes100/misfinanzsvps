# Implementation Plan — W22 "Verdad Forense"

## Problema
- `baseCurrency` viaja en `settings` → incluido en SYNCABLE_KEYS → hasheado
- Dos clientes con distintas divisas generan hashes diferentes → resync perpetuo
- Merge `settings: {...local, ...cloud}` sobrescribe `baseCurrency` → EUR siempre gana
- Loop: push EUR → pull MXN → hash difiere → resync → push EUR → ...

## Solución

### Fase 1: Quitar baseCurrency de SYNCABLE_KEYS
- **`src/utils.ts`**: quitar `"settings"` de SYNCABLE_KEYS? NO — necesitamos sync de `spendLimit`, `biometric`, etc.
- **Solución correcta**: Excluir `baseCurrency` del hash SIN quitar `settings` del sync
  - En `syncableSliceOf`: clonar settings sin `baseCurrency` antes de incluir en el slice
  - En `api/_hash.js`: misma lógica en `syncableSliceOf`

### Fase 2: SEED default EUR→MXN
- **`src/reducer.ts`**: `baseCurrency: "EUR"` → `"MXN"` en SEED
- **`src/store.jsx`**: `baseCurrency: "EUR"` → `"MXN"` en defaultSettings

### Fase 3: Patch server snapshot
- **`POST /api/sync`** del VPS: enviar state con `baseCurrency: "MXN"` en settings

### Fase 4: Guard de resync
- Ya funciona: si hash = hash → `converged: true` → sin resync
- Sin baseCurrency en el hash → mismo hash → sin loop

### Fase 5: Tests
- Test: syncableSliceOf excluye baseCurrency del hash
- Test: dos estados con distinto baseCurrency pero mismos datos → mismo hash
- Verificar total ≥518

### Fase 6: Deploy
- Build local → VPS (`sudo cp -r dist/* /var/www/misfinanzas`)
- Vercel auto-deploy
