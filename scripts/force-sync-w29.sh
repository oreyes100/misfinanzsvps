#!/bin/bash
# force-sync-w29.sh — Fuerza el resync de TODOS los clientes de forma SEGURA.
# CORRER EN EL VPS.
#
# En vez de tocar sync_docs con SQL directo (frágil: sync_version de la columna
# y state._syncVersion deben coincidir), re-pushea el snapshot actual vía
# /api/push → consolidateAndBump avanza _syncVersion+1 determinísticamente y
# TODOS los clientes (heartbeat 60s) detectan el cambio y hacen resync.
#
# Uso: bash force-sync-w29.sh [sync_code] [url]

CODE="${1:-mf-60ec529050f44bfab1}"
URL="${2:-http://127.0.0.1:3000}"

echo "─── 1. Versión actual ───"
curl -s "$URL/api/sync-version?id=$CODE"
echo

echo "─── 2. Re-push del snapshot actual (consolidateAndBump +1) ───"
curl -s "$URL/api/snapshot?id=$CODE" | node -e '
let d = ""; process.stdin.on("data", (c) => d += c).on("end", () => {
  const snap = JSON.parse(d);
  if (!snap.found) { console.error("❌ no hay snapshot"); process.exit(1); }
  const body = JSON.stringify({
    state: {
      accounts: snap.state.accounts,
      transactions: snap.state.transactions,
      assets: snap.state.assets,
      settings: snap.state.settings,
      _syncVersion: snap.syncVersion,
    },
  });
  fetch(process.argv[1], { method: "POST", headers: { "Content-Type": "application/json" }, body })
    .then(async (r) => {
      const j = await r.json();
      console.log(`push: HTTP ${r.status} ok=${j.ok} syncVersion=${j.syncVersion} hash=${String(j.hash || "").slice(0, 12)} cuentas=${j.state?.accounts?.length} txs=${j.state?.transactions?.length}`);
    })
    .catch((e) => { console.error("❌", e.message); process.exit(1); });
});' "$URL/api/push?id=$CODE"
echo
echo "─── 3. Versión tras el push ───"
curl -s "$URL/api/sync-version?id=$CODE"
echo
echo "✅ Los clientes resyncarán en ≤60s (heartbeat). Si un cliente no resyncó: "
echo "   recarga la pestaña o pulsa el chip de sync en la webapp."
