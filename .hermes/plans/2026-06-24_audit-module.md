# Módulo de Auditoría — Mis Finanzas

> **Goal:** Crear un módulo que reciba estados de cuenta (PDF/imagen), los coteje contra los movimientos registrados y proponga correcciones en una checklist.

**Arquitectura:** Core engine en `src/audit.js` (sin dependencias UI) + componente `Auditoria.jsx` + integración en navegación. Reutiliza el OCR/Gemini existente en `ocr.js`.

**Stack:** React 19 + store.jsx (useReducer) + OCR.js (Tesseract.js local + Gemini API) + framer-motion

---

## Task 1: Crear `src/audit.js` — Motor de auditoría

**Objetivo:** Módulo puro (sin React) con la lógica de cotejo estado-de-cuenta vs. transacciones registradas.

**Files:**
- Create: `src/audit.js`
- Referencia: `src/ocr.js` (aiExtract, parseTransfer)
- Referencia: `src/utils.js` (normalize, fmtDate)
- Referencia: `src/store.jsx` (estructura account, transaction)

**Step 1: Diseñar API pública**

```javascript
// audit.js — Motor de auditoría de estados de cuenta

/**
 * Analiza un estado de cuenta extraído por OCR/Gemini y genera
 * una checklist de correcciones.
 *
 * @param {Object} extract — Resultado de aiExtract() (type: "statement", movements[])
 * @param {Object[]} accounts — state.accounts
 * @param {Object[]} transactions — state.transactions
 * @returns {AuditResult}
 */
export function auditStatement(extract, accounts, transactions) { ... }

/**
 * Identifica qué cuenta del sistema corresponde al estado de cuenta.
 * @param {Object} extract — Resultado de aiExtract()
 * @param {Object[]} accounts — state.accounts
 * @returns {{ account: Object|null, confidence: number, reason: string }}
 */
export function identifyAccount(extract, accounts) { ... }
```

**Step 2: Implementar `identifyAccount()`**

Estrategias de matching en orden:
1. Nombre de cuenta/tarjeta mencionado en el texto OCR coincide con `accounts[].name`
2. Saldo final del estado coincide (±1%) con `accounts[].balance`
3. Patrón de movimientos: suma de movimientos del período + saldo anterior ≈ saldo final
4. Rango de fechas del extracto vs. fechas de transacciones registradas

```javascript
export function identifyAccount(extract, accounts) {
  const text = (extract.merchant || extract.raw || "").toLowerCase();
  const mov = extract.movements || [];

  // 1. Match por nombre
  for (const a of accounts) {
    const an = a.name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    if (text.includes(an) || an.includes(text)) {
      return { account: a, confidence: 0.9, reason: `Nombre coincide: "${a.name}"` };
    }
  }

  // 2. Match por saldo final si el extracto trae total/balance
  //    (Gemini pone en merchant el nombre del banco, el balance no viene estructurado aún)
  //    Lo dejamos como heurística: si el usuario selecciona manual, se usa.

  // 3. Match por fechas: la cuenta con más transacciones en el rango
  const dates = mov.filter(m => m.date).map(m => m.date).sort();
  if (dates.length > 2) {
    const start = dates[0];
    const end = dates[dates.length - 1];
    let best = { account: null, count: 0 };
    for (const a of accounts) {
      const count = transactions.filter(
        t => t.accountId === a.id && t.date >= start && t.date <= end
      ).length;
      if (count > best.count) best = { account: a, count };
    }
    if (best.count >= 3) {
      return { account: best.account, confidence: 0.7, reason: `${best.count} movs en el rango ${start}–${end}` };
    }
  }

  return { account: null, confidence: 0, reason: "No se pudo identificar automáticamente" };
}
```

**Step 3: Implementar `auditStatement()` — El corazón del módulo**

Algoritmo de comparación:
1. Normalizar movimientos del extracto: cada movimiento tiene {date, description, amount, direction}
2. Cargar transacciones registradas para la cuenta identificada
3. Para cada movimiento del extracto:
   a. Buscar transacciones registradas con misma fecha (±1 día) e importe similar (±0.01)
   b. Si no hay match exacto, buscar por descripción similar + importe
   c. Si hay match parcial (misma desc, distinto importe) → **amount_mismatch**
   d. Si no hay match → **missing_transaction**
4. Transferencias: detectar movimientos con isTransfer=true → buscar transferencias registradas
5. Agrupar resultados en checklist

```javascript
const NORM = s => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();

function levenshtein(a, b) {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i++)
    for (let j = 1; j <= a.length; j++)
      matrix[i][j] = b[i-1] === a[j-1]
        ? matrix[i-1][j-1]
        : Math.min(matrix[i-1][j-1], matrix[i][j-1], matrix[i-1][j]) + 1;
  return matrix[b.length][a.length];
}

function descSimilarity(a, b) {
  const na = NORM(a), nb = NORM(b);
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.8;
  const dist = levenshtein(na.slice(0, 20), nb.slice(0, 20));
  return Math.max(0, 1 - dist / Math.max(na.length, nb.length, 1));
}

function dateDist(d1, d2) {
  return Math.abs(new Date(d1) - new Date(d2)) / 86400000;
}

function findMatch(mov, transactions) {
  let best = { tx: null, score: -1, type: null };

  for (const tx of transactions) {
    const amountMatch = Math.abs(mov.amount - Math.abs(tx.amount)) < 0.02;
    const dateClose = dateDist(mov.date, tx.date) <= 2;
    const descSim = descSimilarity(mov.description, tx.description);

    if (amountMatch && dateClose && descSim > 0.6) {
      const score = descSim + (dateClose < 0.5 ? 0.5 : 0);
      if (score > best.score) {
        best = { tx, score, type: "exact" };
      }
    }

    if (dateClose && descSim > 0.6 && !amountMatch) {
      const score = descSim + (dateClose < 0.5 ? 0.3 : 0);
      if (score > best.score) {
        best = { tx, score, type: "amount_mismatch" };
      }
    }
  }

  return best.score >= 0 ? best : null;
}

export function auditStatement(extract, accounts, transactions) {
  const { account, confidence, reason } = identifyAccount(extract, accounts);
  const movements = (extract.movements || []).filter(m => m.amount > 0);
  const accountTx = transactions.filter(t => t.accountId === account?.id);
  const unmatched = [];
  const mismatches = [];
  const missing = [];
  const transfers = [];

  for (const mov of movements) {
    const match = findMatch(mov, accountTx);

    if (!match) {
      if (mov.isTransfer) {
        transfers.push({
          type: "missing_transfer",
          mov,
          proposed: `Registrar transferencia: ${mov.description} — ${mov.amount} (${mov.direction === "in" ? "Entrada" : "Salida"})`,
        });
      } else {
        missing.push({
          type: "missing_transaction",
          mov,
          proposed: `Registrar "${mov.description}" por ${mov.amount}`,
        });
      }
      continue;
    }

    if (match.type === "amount_mismatch") {
      mismatches.push({
        type: "amount_mismatch",
        mov,
        tx: match.tx,
        difference: Math.abs(mov.amount - Math.abs(match.tx.amount)),
        proposed: `Corregir "${mov.description}": de ${Math.abs(match.tx.amount)} → ${mov.amount}`,
      });
    }
  }

  // Detectar transferencias entre cuentas
  const transferMovements = movements.filter(m => m.isTransfer);
  for (const tmov of transferMovements) {
    const allTx = transactions;
    const found = allTx.some(tx =>
      tx.category === "Transferencia" &&
      dateDist(tx.date, tmov.date) <= 2 &&
      Math.abs(Math.abs(tx.amount) - tmov.amount) < 0.02
    );
    if (!found) {
      transfers.push({
        type: "missing_transfer",
        mov: tmov,
        proposed: `Registrar transferencia no registrada: ${tmov.description} — ${tmov.amount}`,
      });
    }
  }

  return {
    account,
    accountConfidence: confidence,
    accountReason: reason,
    period: movements.length > 0
      ? { from: movements[0].date, to: movements[movements.length - 1].date }
      : null,
    summary: {
      totalMovements: movements.length,
      exactMatches: movements.length - mismatches.length - missing.length - transfers.length,
      amountMismatches: mismatches.length,
      missingTransactions: missing.length,
      missingTransfers: transfers.length,
    },
    checklist: [
      ...mismatches.map(m => ({ ...m, severity: "medium", action: "correct_amount" })),
      ...missing.map(m => ({ ...m, severity: "high", action: "add_transaction" })),
      ...transfers.map(m => ({ ...m, severity: "high", action: "add_transfer" })),
    ],
  };
}
```

**Step 4: Test unitario con datos simulados**

```javascript
// test-audit.mjs — pruebas rápidas del motor (Node)
import { auditStatement, identifyAccount } from "../src/audit.js";
```

---

## Task 2: Crear `src/components/Auditoria.jsx` — UI del módulo

**Objetivo:** Componente React con upload, procesamiento y checklist de correcciones.

**Files:**
- Create: `src/components/Auditoria.jsx`
- Create: `src/components/AuditChecklist.jsx` (subcomponente de checklist accionable)
- Modify: `src/App.jsx` (agregar vista)
- Modify: `src/components/BottomNav.jsx` (agregar tab)

**Step 1: Estructura del componente principal**

```jsx
export default function Auditoria({ session }) {
  const { state, dispatch } = useStore();
  const [file, setFile] = useState(null);
  const [progress, setProgress] = useState("idle"); // idle | scanning | analyzing | done | error
  const [result, setResult] = useState(null);
  const [selectedAccount, setSelectedAccount] = useState(null);
  const [manualAccount, setManualAccount] = useState(false);
  const [extract, setExtract] = useState(null);
  const [error, setError] = useState(null);
  // ...
}
```

**Step 2: Flujo de UI**

1. **Upload zone**: drag-and-drop o click para seleccionar PDF/imagen
   - Acepta: image/jpeg, image/png, application/pdf
   - Muestra preview de imagen si aplica

2. **Processing**: 
   - Local OCR (Tesseract.js) para extraer texto crudo
   - Si hay API key de Gemini, usar `aiExtract()` para análisis estructurado
   - Mostrar barra de progreso

3. **Account identification**:
   - Mostrar sugerencia automática con confianza
   - Dropdown para selección manual si la detección falla

4. **Results**:
   - Summary cards: total movs, matches, mismatches, missing, transfers
   - Checklist interactiva con:
     - Cada item: descripción, importe actual vs. propuesto, botón "Aplicar"
     - Severidad visual (high=rojo, medium=amarillo)
     - Select all / Apply all

5. **Apply corrections**: 
   - Cada corrección dispara `dispatch()` correspondiente
   - add_transaction, update_transaction, transfer

**Step 3: Estado de cada checklist item**

```javascript
const [checklistState, setChecklistState] = useState({});
// { [itemIndex]: "pending" | "applied" | "skipped" | "error" }
```

**Step 4: Actions de corrección**

```javascript
function applyCorrection(item) {
  switch (item.action) {
    case "add_transaction":
      dispatch({
        type: "add_transaction",
        tx: {
          date: item.mov.date,
          description: item.mov.description,
          amount: item.mov.direction === "out" ? -item.mov.amount : item.mov.amount,
          currency: selectedAccount.currency,
          category: item.mov.category || null,
          accountId: selectedAccount.id,
          auto: false,
        },
      });
      break;
    case "correct_amount": {
      // update_transaction: patch amount on the matched tx
      dispatch({
        type: "update_transaction",
        id: item.tx.id,
        patch: { amount: item.mov.direction === "out" ? -item.mov.amount : item.mov.amount },
      });
      break;
    }
    case "add_transfer": {
      // Buscar la contraparte o dejar que el usuario la seleccione
      dispatch({
        type: "transfer",
        fromId: ...,
        toId: ...,
        amount: item.mov.amount,
        date: item.mov.date,
      });
      break;
    }
  }
}
```

**Step 5: Integrar en App.jsx**

```javascript
// App.jsx
import Auditoria from "./components/Auditoria.jsx";

const VIEWS = {
  // ... existing views
  auditoria: Auditoria,
};
```

**Step 6: Integrar en BottomNav.jsx**

```javascript
const TABS = [
  // ... existing tabs, insert before "ajustes"
  { id: "auditoria", label: "Auditar", icon: "M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2M9 5h6M9 12l2 2 4-4" },
];
```

---

## Task 3: Integración con autenticación

**Files:**
- Modify: `src/auth.js` (agregar permiso para auditoría)

**Step 1: Agregar permiso**

```javascript
// En la función canAccess() de auth.js
const AUDIT_ROLES = ["admin", "owner"];
```

---

## Task 4: Validación

**Step 1: Probar build**
```bash
npm run build
```

**Step 2: Probar flujo completo**
1. Subir un estado de cuenta (imagen/PDF)
2. Verificar que se identifica la cuenta
3. Verificar que el checklist aparece con items correctos
4. Aplicar una corrección y verificar que el store se actualiza

---

## Archivos creados/modificados

| Archivo | Acción |
|---------|--------|
| `src/audit.js` | **Crear** — Motor de auditoría |
| `src/components/Auditoria.jsx` | **Crear** — Componente principal |
| `src/App.jsx` | **Modificar** — Agregar vista |
| `src/components/BottomNav.jsx` | **Modificar** — Agregar tab |
| `src/auth.js` | **Modificar** — Permisos opcional |

---

## Riesgos y tradeoffs

- **PDF processing**: El navegador no renderiza PDF nativamente sin librería. Usar `pdf.js` (mozilla/pdfjs-dist) para extraer texto o convertir a imagen. Alternativa: limitar a imágenes y que el usuario convierta PDF a imagen.
- **Gemini API key**: Si no hay key configurada, usar solo Tesseract.js (menos preciso). La UI debe mostrar el estado sin key.
- **Matching imperfecto**: Las descripciones bancarias vs. nuestras pueden diferir mucho. El umbral de similitud puede necesitar ajuste.
- **Transferencias**: Identificar la contraparte requiere más heurística (match por fecha+importe en otra cuenta).
