// learning.mjs — Lectura del aprendizaje persistido (WG11 Fase 3).
// Funciones puras: consultan cfg.merchantCategoryMap / cfg.transferRules para
// que el pipeline resuelva SOLO lo que el usuario ya enseñó. Sin dependencias
// de SQLite (testeable con node --test sin mejor-sqlite3 instalado).

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Categoría aprendida (merchantCategoryMap) tiene prioridad sobre la heurística
 * de keywords. Devuelve la categoría mapeada si el comercio/descripción coincide
 * (por clave normalizada o substring), si no null.
 */
export function categoryFromMap(cfg, merchant, description) {
  const map = cfg.merchantCategoryMap || {};
  const m = norm(merchant); const d = norm(description);
  for (const [key, cat] of Object.entries(map)) {
    const k = norm(key);
    if (!k || !cat) continue;
    // claves < 3 chars solo coinciden exactas (evita "x" → "Oxxo")
    const exact = m === k || d === k;
    if (exact) return cat;
    if (k.length < 3) continue;
    if ((m && (m.includes(k) || k.includes(m))) || (d && d.includes(k))) return cat;
  }
  return null;
}

/**
 * Busca en cfg.transferRules un par (from|to) normalizado que coincida con la
 * transferencia. Soporta reglas aprendidas como "obmio|banorte" → { fromId, toId }.
 * El match es por normalización + substring (tolerante a variantes OCR) y
 * funciona en ambos órdenes. Devuelve la regla o null.
 */
export function transferRuleFor(cfg, from, to) {
  const rules = cfg.transferRules || {};
  const f = norm(from); const t = norm(to);
  const direct = rules[`${f}|${t}`] || rules[`${t}|${f}`];
  if (direct) return direct;
  for (const [key, rule] of Object.entries(rules)) {
    const [kf, kt] = key.split("|").map(norm);
    if (pairMatch(kf, f) && pairMatch(kt, t)) return rule;
    if (pairMatch(kf, t) && pairMatch(kt, f)) return rule;
  }
  return null;
}

function pairMatch(k, v) {
  if (!k) return true; // punta comodín: '' coincide con cualquier texto
  if (!v) return false;
  return v === k || v.includes(k) || k.includes(v);
}