# W19 — Operación Copilot Parity

**Fork de prueba**: rama `w19-copilot-parity`. NO desplegar a producción.

## Objetivo
Añadir módulo de Reports estilo Copilot (5 features) + 3 tarjetas de dashboard, reutilizando el stack existente (SVG custom, framer-motion, reactivo con `convert` + `state.fx`).

## Ground Rules
- Recon en `Fase 0` terminado (Reports.jsx, Charts.jsx, Dashboard.jsx, types.ts, utils.ts leídos).
- Gráficos: `LineChart(data = números)`, `BarChart(bars={label,value,title})`, `PieChart(slices={label,value,color})` — **sin librerías nuevas**.
- Transferencias = `t.category === "Transferencia"` (+ `counterpartId`), igual que Reports.jsx/Dashboard.jsx ya hacen.
- Multimoneda → siempre `toBase(amount, currency)` vía `convert` + `state.fx` (el pseudocódigo del wargame ignora moneda; adaptar al código real).
- `cardOn(settings, id)` = `true` por defecto → tarjetas nuevas visibles sin tocar Settings.
- Tests base: 410 passing. Mantener.

## Archivos

### 1. `src/reports.ts` (nuevo) — motor puro, sin React
- `normalizeMerchant(description)` → minúsculas, sin acentos, quita prefijos (pago/cargo/compra/…), colapsa espacios.
- `isTransferTx(t)` → `category === "Transferencia"`.
- `cashflowByMonth(transactions, months, fx, base)` → `[{key,label,income,expense,net}]` últimos N meses, excluye transferencias, en divisa base.
- `allocationByType(accounts, fx, base)` → `[{type,label,value,pct}]` sobre cuentas de activo (excluye `credit`/`auto_loan`), convierte saldo a base, ordena desc, descarta ceros. Label via `ACCOUNT_TYPES`.
- `detectSubscriptions(transactions, fx, base)` → agrupa negativas no-transferencia por `normalizeMerchant`; con ≥2 ocurrencias calcula `{merchant, amount(base), currency, freq, lastDate, count}`. `freq` por mediana de intervalos: ≤10d semanal, ≤45d mensual, ≤380d anual, resto irregular. Ordena por amount desc.
- `spendingLine(transactions, year, month, fx, base)` → `[{date, day, value}]` gasto diario del mes (negativas, sin transferencias) en base.

### 2. `src/budgets.ts` (nuevo) — rollover puro
- `rolloverBudget(month, expenses, openingBudget)` → `max(0, openingBudget - expenses)` (no negativo).

### 3. `src/reports.test.js` (nuevo)
- Tests por función (≥10 casos): merchants, cashflow (incluye exclusión transferencia + conversión multi-divisa), allocation (excluye pasivos, convierte MXN→EUR), subscriptions (frecuencia mensual/semanal, exclusión transferencia), spendingLine (días del mes), rolloverBudget (positivo/negativo/clamp).

### 4. `src/components/Reports.jsx` (editar)
- Tab bar superior: `📊 Resumen` (contenido actual envuelto) + `💸 Cash flow` + `🎯 Allocation` + `🔁 Suscripciones` + `📈 Gasto diario` + `🎟️ Rollovers`.
- Sub-componentes locales `CashflowTab`, `AllocationTab`, `SubscriptionsTab`, `SpendingTab`, `RolloversTab` usando funciones puras + Charts existentes. Rollovers: input local de presupuesto mensual (default: gasto del mes pasado; sin persistencia — se deja para Settings en un futuro, test fork).

### 5. `src/components/Dashboard.jsx` (editar)
- 3 tarjetas nuevas (gated por `cardOn`):
  - `copilotCashflow` → "Cash flow del mes": ingresos − gastos del mes corriente + mini LineChart de flujo diario.
  - `copilotAllocation` → "Allocation": PieChart mini con `allocationByType`.
  - `copilotSubs` → "Suscripciones top 3": top 3 de `detectSubscriptions` + total/mes.

### 6. `src/utils.ts` (editar)
- Añadir 3 ids a `DASHBOARD_CARDS` (toggle en Settings): `copilotCashflow`, `copilotAllocation`, `copilotSubs`.

## Criterios de verificación
- `npm test` ≥ 420 passing (nuevos tests de reports/budgets).
- `npm run build` OK.
- Manual (local): tab de Reports muestra cash flow/allocation/suscripciones/gasto diario/rollovers; dashboard muestra las 3 tarjetas.
- NO redeploy a VPS/Vercel (fork de prueba).

## Orden
1. reports.ts + budgets.ts + reports.test.js → tests
2. utils.ts (DASHBOARD_CARDS)
3. Reports.jsx (tabs + secciones)
4. Dashboard.jsx (3 tarjetas)
5. `npm test` + `npm run build`
6. Reporte al usuario