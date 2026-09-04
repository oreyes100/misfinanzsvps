// userBackups.js — W33-i6: listado de respaldos por usuario para Ajustes.
// Solo lectura: pide al server la lista de respaldos del PROPIO syncId
// (GET /api/user-backups?id=<código>). El server solo expone metadatos
// (fecha, bytes, hash, verificación) del árbol backups/users/<syncId>/ —
// jamás datos de otro usuario ni el backup global de W1 Fortress.
import { API_BASE } from "./utils.js";

/** Descarga la lista de respaldos del usuario, más reciente primero. */
export async function fetchUserBackups(syncId, fetchImpl = fetch) {
  if (!syncId) throw new Error("Sincronización no activa: no hay respaldos que listar.");
  const res = await fetchImpl(`${API_BASE}/api/user-backups?id=${encodeURIComponent(syncId)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Error ${res.status} al listar respaldos`);
  if (!data?.found) return [];
  return [...(data.backups || [])].sort((a, b) => String(b?.date || "").localeCompare(String(a?.date || "")));
}

/** 1234567 → "1.2 MB"; 512 → "512 B"; inválido → "—" (unidades binarias). */
export function formatBytes(n) {
  if (n == null || n === "") return "—";
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return "—";
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} kB`;
  return `${(v / (1024 * 1024)).toFixed(1)} MB`;
}

/** Línea legible de un respaldo: "2026-09-04 · 12.3 kB · v42 · 3 cuentas · 120 movs". */
export function backupLabel(b) {
  if (!b?.date) return "respaldo";
  const parts = [b.date, formatBytes(b.bytes)];
  if (b.syncVersion != null) parts.push(`v${b.syncVersion}`);
  if (b.counts) parts.push(`${b.counts.accounts ?? "?"} cuentas · ${b.counts.transactions ?? "?"} movs`);
  return parts.join(" · ");
}
