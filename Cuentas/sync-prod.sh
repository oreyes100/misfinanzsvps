#!/usr/bin/env bash
# sync-prod.sh — Sincroniza la base de datos entre local y producción
# Uso:
#   ./sync-prod.sh push          → sube DB local a producción (sobreescribe prod)
#   ./sync-prod.sh pull          → baja DB de producción a local (sobreescribe local)
#   ./sync-prod.sh push-csv      → sube transacciones CSV a producción
#   ./sync-prod.sh pull-csv      → descarga transacciones de producción como CSV

set -euo pipefail

PROD_URL="${CUENTAS_PROD_URL:-https://cuentas-congregacion-bay.vercel.app}"
LOCAL_URL="${CUENTAS_LOCAL_URL:-http://localhost:3001}"
BACKUP_DIR="$(dirname "$0")/backups"
mkdir -p "$BACKUP_DIR"

usage() {
  echo "Uso: $0 [push|pull|push-csv|pull-csv]"
  echo "  push      → local DB → producción"
  echo "  pull      → producción DB → local"
  echo "  push-csv  → local CSV → producción"
  echo "  pull-csv  → producción CSV → local"
  exit 1
}

login() {
  local base_url="$1"
  echo -n "Usuario para $base_url: "; read -r USER
  echo -n "Contraseña: "; read -rs PASS; echo
  TOKEN=$(curl -sf -X POST "$base_url/api/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" \
    | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")
  echo "Login OK"
}

case "${1:-}" in
  push)
    echo "=== PUSH: local → producción ==="
    echo "⚠️  Esto SOBREESCRIBE la base de datos de producción. ¿Continuar? (s/N)"
    read -r confirm; [[ "$confirm" =~ ^[sS]$ ]] || exit 0

    echo "--- Autenticando en local ---"
    login "$LOCAL_URL"
    LOCAL_TOKEN="$TOKEN"

    TS=$(date +%Y%m%d_%H%M%S)
    DB_FILE="$BACKUP_DIR/local_${TS}.db"
    echo "--- Descargando DB local ---"
    curl -sf -o "$DB_FILE" \
      -H "Authorization: Bearer $LOCAL_TOKEN" \
      "$LOCAL_URL/api/admin/backup/db"
    echo "DB local guardada: $DB_FILE ($(wc -c < "$DB_FILE") bytes)"

    echo "--- Autenticando en producción ---"
    login "$PROD_URL"
    PROD_TOKEN="$TOKEN"

    echo "--- Subiendo a producción ---"
    curl -sf -X POST "$PROD_URL/api/admin/restore" \
      -H "Authorization: Bearer $PROD_TOKEN" \
      -F "backup=@$DB_FILE;type=application/octet-stream" \
      | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK:', d.get('message',''))"
    echo "✅ Push completado"
    ;;

  pull)
    echo "=== PULL: producción → local ==="
    echo "⚠️  Esto SOBREESCRIBE la base de datos local. ¿Continuar? (s/N)"
    read -r confirm; [[ "$confirm" =~ ^[sS]$ ]] || exit 0

    echo "--- Autenticando en producción ---"
    login "$PROD_URL"
    PROD_TOKEN="$TOKEN"

    TS=$(date +%Y%m%d_%H%M%S)
    DB_FILE="$BACKUP_DIR/prod_${TS}.db"
    echo "--- Descargando DB de producción ---"
    curl -sf -o "$DB_FILE" \
      -H "Authorization: Bearer $PROD_TOKEN" \
      "$PROD_URL/api/admin/backup/db"
    echo "DB prod guardada: $DB_FILE ($(wc -c < "$DB_FILE") bytes)"

    echo "--- Autenticando en local ---"
    login "$LOCAL_URL"
    LOCAL_TOKEN="$TOKEN"

    echo "--- Restaurando en local ---"
    curl -sf -X POST "$LOCAL_URL/api/admin/restore" \
      -H "Authorization: Bearer $LOCAL_TOKEN" \
      -F "backup=@$DB_FILE;type=application/octet-stream" \
      | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK:', d.get('message',''))"
    echo "✅ Pull completado"
    ;;

  push-csv)
    echo "=== PUSH CSV: local transacciones → producción ==="
    echo "--- Autenticando en local ---"
    login "$LOCAL_URL"
    LOCAL_TOKEN="$TOKEN"

    TS=$(date +%Y%m%d_%H%M%S)
    CSV_FILE="$BACKUP_DIR/local_${TS}.csv"
    curl -sf -o "$CSV_FILE" \
      -H "Authorization: Bearer $LOCAL_TOKEN" \
      "$LOCAL_URL/api/admin/backup/csv"
    echo "CSV local: $CSV_FILE ($(wc -l < "$CSV_FILE") líneas)"

    echo "--- Autenticando en producción ---"
    login "$PROD_URL"
    PROD_TOKEN="$TOKEN"

    curl -sf -X POST "$PROD_URL/api/admin/restore" \
      -H "Authorization: Bearer $PROD_TOKEN" \
      -F "backup=@$CSV_FILE;type=text/csv" \
      | python3 -c "import sys,json; d=json.load(sys.stdin); print('OK:', d.get('message',''))"
    echo "✅ Push CSV completado"
    ;;

  pull-csv)
    echo "=== PULL CSV: producción → archivo local ==="
    echo "--- Autenticando en producción ---"
    login "$PROD_URL"
    PROD_TOKEN="$TOKEN"

    TS=$(date +%Y%m%d_%H%M%S)
    CSV_FILE="$BACKUP_DIR/prod_${TS}.csv"
    curl -sf -o "$CSV_FILE" \
      -H "Authorization: Bearer $PROD_TOKEN" \
      "$PROD_URL/api/admin/backup/csv"
    echo "✅ CSV de prod guardado: $CSV_FILE ($(wc -l < "$CSV_FILE") líneas)"
    ;;

  *)
    usage
    ;;
esac
