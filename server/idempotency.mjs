// idempotency.mjs — Idempotencia para /api/learn y webhook Telegram (W1 Fase 3).
import fs from "node:fs";
import path from "node:path";

const DEFAULT_MAX = 5000;

/**
 * Store en memoria para update_id procesados. Persistido en FS si `persistPath` se da.
 */
export function makeUpdateIdStore({ persistPath = null, max = DEFAULT_MAX } = {}) {
  const set = new Set();
  const order = []; // para evicción FIFO

  function load() {
    if (!persistPath) return;
    try {
      if (fs.existsSync(persistPath)) {
        const arr = JSON.parse(fs.readFileSync(persistPath, "utf8"));
        for (const id of arr.slice(-max)) { set.add(String(id)); order.push(String(id)); }
      }
    } catch {}
  }

  function persist() {
    if (!persistPath) return;
    try {
      fs.mkdirSync(path.dirname(persistPath), { recursive: true });
      fs.writeFileSync(persistPath, JSON.stringify(order.slice(-max)), "utf8");
    } catch {}
  }

  function has(id) {
    return set.has(String(id));
  }

  function add(id) {
    const k = String(id);
    if (set.has(k)) return false; // ya existe → idempotente
    set.add(k);
    order.push(k);
    if (order.length > max) {
      const ev = order.shift();
      set.delete(ev);
    }
    persist();
    return true; // nuevo
  }

  function _size() { return set.size; }

  load();
  return { has, add, _size, _order: order, _set: set };
}

/**
 * Clave dedup para /api/learn: mismo kind+merchant+category/accountId.
 */
export function learnDedupKey(entry) {
  const kind = entry.kind || "account";
  if (kind === "category") return `cat:${norm(entry.merchant)}|${String(entry.category || "").trim().toLowerCase()}`;
  if (kind === "transfer") return `tr:${norm(entry.from)}|${norm(entry.to)}|${entry.fromId || ""}|${entry.toId || ""}`;
  return `acc:${norm(entry.merchant)}|${entry.accountId || ""}`;
}

function norm(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().replace(/\s+/g, " ");
}
