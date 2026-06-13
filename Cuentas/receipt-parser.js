/**
 * receipt-parser.js — Análisis de texto OCR de recibos.
 *
 * Soporta el formato S-24-S "Registro de transacción" (casillas
 * Donación / Pago / Depósito / Adelanto) y recibos genéricos.
 *
 * Códigos según el modelo contable de la congregación:
 *   OM  Donación para la obra mundial      (Entrada / Recibido)
 *   C   Donaciones para la congregación    (Entrada / Recibido)
 *   D   Depósito en la caja de efectivo    (Traspaso Recibido → Caja)
 *   OV  Orador visitante / discursante     (Salida / Caja)
 *   G   Gastos de la congregación          (Salida / Caja)
 *
 * Principios:
 *  - Extracción ESTRICTA de montos: nunca se convierten palabras en números.
 *  - Si el monto de una línea no se puede leer, la línea se emite con
 *    monto null para que el usuario lo capture/valide en la interfaz.
 *  - Un segundo pase de OCR sobre la columna de cantidades (extraAmounts)
 *    puede completar los montos; siempre se validan contra el TOTAL.
 */

const normalize = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

function parseAmount(str) {
  if (!str) return null;
  let s = str.trim();
  if (s.includes(',') && s.includes('.')) {
    if (s.lastIndexOf('.') > s.lastIndexOf(',')) s = s.replace(/,/g, '');
    else s = s.replace(/\./g, '').replace(',', '.');
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  }
  if (/[^0-9.]/.test(s)) return null;
  const v = parseFloat(s);
  return isNaN(v) ? null : v;
}

/** Corrige años mal leídos por el OCR (p. ej. 2076 → 2026). */
function fixYear(yStr) {
  const cur = new Date().getFullYear();
  let n = parseInt(yStr, 10);
  if (isNaN(n)) return cur;
  if (yStr.length === 2) n = 2000 + n;
  if (n >= 2000 && n <= cur + 1) return n;
  const cand = parseInt(String(cur).slice(0, 3) + String(n).slice(3), 10);
  if (cand >= 2000 && cand <= cur + 1) return cand;
  return cur;
}

/** Devuelve YYYY-MM-DD o null. */
function parseDate(str) {
  const monthMap = {
    ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6,
    jul: 7, ago: 8, sep: 9, oct: 10, nov: 11, dic: 12
  };
  const monthMatch = str.match(/(\d{1,2})\s*[\/\-]+\s*([a-zA-ZÀ-ſ]+)\s*[\/\-]+\s*(\d{2,4})/);
  if (monthMatch) {
    const day = monthMatch[1].padStart(2, '0');
    const abbr = normalize(monthMatch[2]).substring(0, 3);
    const monthNum = monthMap[abbr];
    if (monthNum && parseInt(day) >= 1 && parseInt(day) <= 31) {
      const year = fixYear(monthMatch[3]);
      return `${year}-${String(monthNum).padStart(2, '0')}-${day}`;
    }
  }
  const m = str.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (!m) return null;
  let [, a, b, c] = m;
  const year = fixYear(c);
  if (parseInt(a) > 12 && parseInt(b) <= 12) return `${year}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`;
  if (parseInt(b) > 12 && parseInt(a) <= 12) return `${year}-${a.padStart(2, '0')}-${b.padStart(2, '0')}`;
  if (parseInt(a) >= 1 && parseInt(a) <= 31 && parseInt(b) >= 1 && parseInt(b) <= 12) {
    return `${year}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`; // DD/MM/AAAA
  }
  return null;
}

/**
 * Extrae candidatos de monto de una línea, de forma estricta.
 * Devuelve [{ val, alts, weak }]:
 *  - alts: interpretaciones alternativas por errores del OCR con "$"
 *      "S400.00" → val 400.00, alt 5400.00  |  "9400.00" → alt 400.00
 *  - weak: entero sin símbolo de moneda ni decimales (poco confiable)
 */
function extractAmountCandidates(line) {
  const out = [];
  // Separar también por ":" y "=" para casos como "TOTAL:$1967"
  for (const raw of line.split(/[\s:=]+/)) {
    const tok = raw.replace(/^[—\-_({\[]+/, '').replace(/[—\-_)}\]:;.,]+$/, '');
    if (!tok) continue;
    const m = tok.match(/^([S$s])?(\d[\d.,]*\d|\d)$/);
    if (!m) continue;
    const lead = (m[1] || '').toUpperCase();
    const digits = m[2];
    const isDecimal = /[.,]\d{2}$/.test(digits);
    if (!isDecimal && !lead && !/^\d{2,5}$/.test(digits)) continue;
    const v = parseAmount(digits);
    if (v === null || v <= 0 || v >= 100000) continue;
    if (!lead && !isDecimal && Number.isInteger(v) && v >= 1900 && v <= 2099) continue; // años
    const alts = [];
    if (lead === 'S' && isDecimal) {
      const v5 = parseAmount('5' + digits);
      if (v5 !== null && v5 > 0 && v5 < 100000) alts.push(v5);
    }
    const dm = digits.match(/^([9865])(\d{1,3}[.,]\d{2})$/);
    if (!lead && dm) {
      const vd = parseAmount(dm[2]);
      if (vd !== null && vd > 0) alts.push(vd);
    }
    out.push({ val: v, alts, weak: !lead && !isDecimal });
  }
  return out;
}

/**
 * Detecta la casilla marcada en un S-24-S.
 * Casilla vacía: "Cl", "(O", "[]", "O"... Marcada (☒): "X", "NI", "W", "M"...
 */
function detectMarkedOption(lines) {
  const options = [
    { key: 'donacion', re: /donacion(?!es)/ },
    { key: 'pago', re: /\bpago\b/ },
    { key: 'deposito', re: /deposito/ },
    { key: 'adelanto', re: /adelanto/ },
  ];
  let marked = null;
  for (const line of lines.slice(0, 8)) {
    const norm = normalize(line);
    for (const opt of options) {
      const m = opt.re.exec(norm);
      if (!m) continue;
      const before = norm.slice(Math.max(0, m.index - 4), m.index);
      if (/[xkmnwy✗×√v]/.test(before) && !marked) marked = opt.key;
    }
  }
  return marked;
}

/** Categorías conocidas (códigos del modelo de la congregación). */
function detectCategory(text) {
  const t = normalize(text);
  if (/cooperaci|orador|discursante|disursante/.test(t)) {
    return { description: 'Orador visitante', type: 'expense', code: 'OV' };
  }
  if (/obra\s*mundial/.test(t)) {
    return { description: 'Donación para la obra mundial', type: 'income', code: 'OM' };
  }
  if (/gastos?\s*de\s*la\s*congregacion|gastos?\s*congregacion/.test(t)) {
    return { description: 'Donaciones para la congregación', type: 'income', code: 'C' };
  }
  if (/deposito\s*en\s*la\s*caja|deposito\s*caja/.test(t)) {
    return { description: 'Depósito en la caja de efectivo', type: 'transfer', code: 'D' };
  }
  if (/(congregacion|caja\s*de\s*contribuciones?|contribucion)/.test(t) && /donac/.test(t)) {
    return { description: 'Donaciones para la congregación', type: 'income', code: 'C' };
  }
  if (/salones?\s*del?\s*reino/.test(t) && /donac/.test(t)) {
    return { description: 'Donación para Salones del Reino', type: 'income', code: 'DK' };
  }
  if (/asamblea|circuito/.test(t) && /donac/.test(t)) {
    return { description: 'Donación para Asambleas', type: 'income', code: 'DA' };
  }
  if (/mantenimiento/.test(t)) {
    return { description: 'Mantenimiento', type: 'expense', code: 'G' };
  }
  if (/gasto/.test(t)) {
    return { description: 'Gastos de la congregación', type: 'expense', code: 'G' };
  }
  if (/donac/.test(t)) {
    return { description: 'Donación', type: 'income', code: 'C' };
  }
  return null;
}

const SKIP_LINE_RE = /fecha|seleccione|registro\s+de\s+transacc|rellenado|verificado|s\s*-?\s*24/;

function bestTextLine(lines, stop) {
  let best = '', bestLetters = 0;
  for (let i = 0; i < stop; i++) {
    if (SKIP_LINE_RE.test(normalize(lines[i]))) continue;
    const letters = (lines[i].match(/[a-zA-ZÀ-ſ]/g) || []).length;
    if (letters > bestLetters) { best = lines[i]; bestLetters = letters; }
  }
  return best.trim();
}

const near = (a, b) => Math.abs(a - b) < 0.011;

/**
 * Resuelve los montos de las partidas de un S-24 combinando:
 *  - montos leídos en cada línea (con alternativas por errores de "$"),
 *  - montos del pase de dígitos de la columna derecha (extras),
 *  - el TOTAL del recibo.
 * Marca verified=true solo cuando la suma cuadra con el total.
 */
function resolveS24Amounts(items, totals, extras) {
  const n = items.length;

  // 1) Combinación de los montos de línea que cuadre con el total.
  //    Se consideran solo las líneas que sí tienen monto; si cuadran,
  //    las líneas sin monto sobrantes se descartan.
  const withAmt = items.filter(it => it.amount);
  if (withAmt.length > 0 && withAmt.length <= 8 && totals.length) {
    const lists = withAmt.map(it => [it.amount.val, ...it.amount.alts]);
    let chosen = null, chosenTotal = null;
    const rec = (idx, acc, cur) => {
      if (chosen) return;
      if (idx === lists.length) {
        for (const t of totals) if (near(acc, t)) { chosen = cur.slice(); chosenTotal = t; break; }
        return;
      }
      for (const v of lists[idx]) {
        cur.push(v); rec(idx + 1, acc + v, cur); cur.pop();
        if (chosen) return;
      }
    };
    rec(0, 0, []);
    if (chosen) {
      withAmt.forEach((it, i) => { it.value = chosen[i]; it.verified = true; });
      items.forEach(it => { if (!it.amount) it.drop = true; });
      return { total: chosenTotal, verified: true };
    }
  }

  // 2) Montos del pase de dígitos (en orden de lectura). Puede traer
  //    ruido (fecha, núm. de recibo), así que se busca la subsecuencia
  //    de longitud n cuya suma coincida con el total.
  if (n > 0 && extras.length) {
    const totalsTry = totals.length ? totals : (extras.length > n ? [extras[extras.length - 1]] : []);
    for (const t of totalsTry) {
      const rest = extras.slice();
      for (let i = rest.length - 1; i >= 0; i--) {
        if (near(rest[i], t)) { rest.splice(i, 1); break; }
      }
      if (rest.length >= n && rest.length <= 12) {
        let pick = null;
        const rec2 = (start, count, acc, cur) => {
          if (pick) return;
          if (count === n) { if (near(acc, t)) pick = cur.slice(); return; }
          for (let i = start; i < rest.length; i++) {
            cur.push(rest[i]); rec2(i + 1, count + 1, acc + rest[i], cur); cur.pop();
            if (pick) return;
          }
        };
        rec2(0, 0, 0, []);
        if (pick) {
          items.forEach((it, i) => { it.value = pick[i]; it.verified = true; });
          return { total: t, verified: true };
        }
      }
    }
  }

  // 3) Inferir un único monto desconocido a partir del total.
  //    Los montos "débiles" (enteros sin $ ni decimales que no cuadraron
  //    con el total) se consideran desconocidos: suelen ser basura de OCR.
  const isUnknown = it => !it.amount || it.amount.weak;
  if (totals.length) {
    const unknown = items.filter(isUnknown);
    const knownSum = items.reduce((s, it) => s + (!isUnknown(it) ? it.amount.val : 0), 0);
    if (unknown.length === 1) {
      for (const t of totals) {
        const diff = t - knownSum;
        if (diff > 0) {
          items.forEach(it => {
            it.value = isUnknown(it) ? diff : it.amount.val;
            it.verified = !isUnknown(it);
          });
          return { total: t, verified: false };
        }
      }
    }
  }

  // 4) Sin validación posible: conservar solo montos confiables; los
  //    débiles se vacían para que el usuario los capture (si hay total).
  items.forEach(it => {
    if (!it.amount) it.value = null;
    else if (it.amount.weak && totals.length) it.value = null;
    else it.value = it.amount.val;
    it.verified = false;
  });
  const total = totals.length ? totals[0]
    : items.reduce((s, it) => s + (it.value || 0), 0) || null;
  return { total, verified: false };
}

function parseReceiptText(text, extraAmounts = []) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const lowerAll = normalize(text);

  // ── 1. Fecha ──────────────────────────────────────────────────────
  let date = null;
  for (const line of lines) {
    if (/fecha/i.test(line)) { const d = parseDate(line); if (d) { date = d; break; } }
  }
  if (!date) {
    const upper = Math.max(1, Math.floor(lines.length * 0.4));
    for (let i = 0; i < upper && !date; i++) date = parseDate(lines[i]);
    for (let i = 0; i < lines.length && !date; i++) date = parseDate(lines[i]);
  }
  if (!date) date = new Date().toISOString().slice(0, 10);

  // ── 2. Línea TOTAL ────────────────────────────────────────────────
  let totalIdx = -1, totalCand = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!/total/i.test(normalize(lines[i]))) continue;
    let c = extractAmountCandidates(lines[i]);
    if (!c.length && i + 1 < lines.length) c = extractAmountCandidates(lines[i + 1]);
    totalIdx = i;
    if (c.length) totalCand = c[c.length - 1];
    break;
  }
  const stop = totalIdx >= 0 ? totalIdx : lines.length;

  // ── 3. ¿Formato S-24-S? + casilla marcada ─────────────────────────
  const isS24 = /registro\s+de\s+transacc|seleccione\s+el\s+tipo\s+de\s+transacc/.test(lowerAll);
  const marked = detectMarkedOption(lines);
  const expenseMode = marked === 'pago' || marked === 'adelanto';

  const extras = (extraAmounts || []).filter(v => typeof v === 'number' && v > 0 && v < 100000);

  let transactions = [];
  let total = null;
  let verified = false;

  if (isS24 || marked) {
    // ── Recibo S-24-S ───────────────────────────────────────────────
    const optionRowRe = /^\W{0,4}(donacion|pago|deposito\s*en|adelanto)\b/;
    const items = [];
    for (let i = 0; i < stop; i++) {
      const line = lines[i];
      const norm = normalize(line);
      if (SKIP_LINE_RE.test(norm)) continue;
      const isObra = /obra\s*mundial/.test(norm);
      const isGastosCong = /gastos?\s*de\s*la\s*congregaci/.test(norm);
      const cands = extractAmountCandidates(line);
      // Las filas de casillas (Donación/Pago/...) sin monto no son partidas
      if (!cands.length && !isObra && !isGastosCong) continue;
      // Líneas que son solo números (folio del recibo, ruido) no son partidas
      const letterCount = (line.match(/[a-zA-ZÀ-ſ]/g) || []).length;
      if (letterCount < 3 && !isObra && !isGastosCong) continue;
      if (optionRowRe.test(norm) && !isObra && !isGastosCong && !cands.length) continue;

      const amount = cands.length ? cands[cands.length - 1] : null;

      let desc = line
        .replace(/[S$]?\d[\d.,]*\d|\b\d\b/g, ' ')
        .replace(/[—\-_…·]+/g, ' ')
        .replace(/[()\[\]{}|]/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();

      let cat;
      if (isObra) {
        cat = { description: 'Donación para la obra mundial', type: 'income', code: 'OM' };
      } else if (isGastosCong) {
        cat = expenseMode
          ? { description: 'Gastos de la congregación', type: 'expense', code: 'G' }
          : { description: 'Donaciones para la congregación', type: 'income', code: 'C' };
      } else {
        cat = detectCategory(line);
      }
      if (cat && expenseMode && cat.type === 'income' && !isObra) {
        cat = { description: cat.description, type: 'expense', code: 'G' };
      }
      if (!cat) {
        if (marked === 'deposito') cat = { description: 'Depósito en la caja de efectivo', type: 'transfer', code: 'D' };
        else if (expenseMode) cat = { description: desc || 'Gasto', type: 'expense', code: 'G' };
        else cat = { description: desc || 'Donación', type: 'income', code: 'C' };
      }
      const useOcrDesc = desc && desc.length >= 4 && !/^donaciones?$/i.test(desc) && !isObra && !isGastosCong;
      items.push({
        amount,
        description: useOcrDesc ? desc : cat.description,
        type: cat.type,
        code: cat.code,
        date
      });
    }

    const totals = totalCand ? [totalCand.val, ...totalCand.alts] : [];
    const res = resolveS24Amounts(items, totals, extras);
    total = res.total;
    verified = res.verified;
    transactions = items.filter(it => !it.drop).map(it => ({
      amount: it.value,
      description: it.description,
      type: it.type,
      code: it.code,
      date,
      verified: !!it.verified
    }));

    // Solo se encontró el TOTAL (sin partidas)
    if (!transactions.length && (totalCand || extras.length)) {
      const amt = totalCand ? totalCand.val : extras[extras.length - 1];
      const desc = bestTextLine(lines, stop);
      const cat = marked === 'deposito'
        ? { description: 'Depósito en la caja de efectivo', type: 'transfer', code: 'D' }
        : expenseMode
          ? { description: desc || 'Pago', type: 'expense', code: 'G' }
          : { description: desc || 'Donación', type: 'income', code: 'C' };
      transactions.push({ amount: amt, ...cat, date, verified: false });
      total = amt;
    }
  } else {
    // ── Recibo genérico ─────────────────────────────────────────────
    const all = [];
    for (let i = 0; i < lines.length; i++) {
      const norm = normalize(lines[i]);
      if (/s\s*-?\s*24|rellenado|verificado/.test(norm)) continue;
      for (const c of extractAmountCandidates(lines[i])) {
        all.push({ val: c.val, alts: c.alts, line: i, text: lines[i] });
      }
    }
    const classified = [];
    const seenDesc = new Set();
    for (const e of all) {
      if (e.line === totalIdx) continue;
      const cat = detectCategory(e.text);
      if (cat && !seenDesc.has(cat.description)) {
        classified.push({ ...cat, amount: e.val });
        seenDesc.add(cat.description);
      }
    }
    if (classified.length) {
      transactions = classified.map(c => ({
        amount: c.amount, description: c.description, type: c.type, code: c.code, date, verified: false
      }));
      total = totalCand ? totalCand.val : transactions.reduce((s, t) => s + t.amount, 0);
      verified = totalCand ? near(transactions.reduce((s, t) => s + t.amount, 0), totalCand.val) : false;
    } else {
      const uniq = [...new Set(all.map(e => e.val))].sort((a, b) => b - a);
      const isExpense = /pago|compra|gasto|factura|servicio|cuota|supermercado|farmacia|restaurante|gasolinera|impuesto/.test(lowerAll);
      const isIncome = /donac|aporte|ofrenda|ingreso|deposito|abono/.test(lowerAll);
      const type = isIncome && !isExpense ? 'income' : 'expense';
      total = totalCand ? totalCand.val : (uniq.length ? uniq[0] : null);
      let merchant = '';
      for (const line of lines) {
        if (line.length > 4 && line.length < 80
          && !/\d{4,}/.test(line)
          && !/^(total|subtotal|iva|impuesto|fecha|hora|recibo|contribucion)/i.test(line)
          && !parseDate(line)) { merchant = line; break; }
      }
      if (total !== null) {
        transactions.push({
          amount: total,
          description: merchant || (type === 'income' ? 'Donación' : 'Gasto'),
          type,
          code: type === 'income' ? 'C' : 'G',
          date,
          verified: false
        });
      }
    }
  }

  if (total === null) total = transactions.reduce((s, t) => s + (t.amount || 0), 0) || null;
  return { transactions, total, date, verified, marked: marked || null };
}

function suggestFromOCR(text, extraAmounts = []) {
  const parsed = parseReceiptText(text, extraAmounts);
  const main = parsed.transactions[0] || {};
  return {
    amount: main.amount ?? null,
    description: main.description || '',
    type: main.type || 'expense',
    code: main.code || null,
    multi: parsed.transactions.length > 1,
    allTransactions: parsed.transactions,
    date: parsed.date,
    total: parsed.total,
    verified: parsed.verified,
    marked: parsed.marked
  };
}

module.exports = {
  parseAmount, parseDate, detectCategory, parseReceiptText,
  suggestFromOCR, extractAmountCandidates, detectMarkedOption
};
