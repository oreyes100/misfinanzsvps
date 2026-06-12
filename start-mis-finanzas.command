#!/usr/bin/env bash
# Mis Finanzas — Launcher macOS (doble clic para iniciar)
# Inicia servidor Vite, abre navegador en http://localhost:5173
# Mata cualquier proceso previo en el puerto 5173

set -euo pipefail

# ── Configuración ──────────────────────────────────────────────
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_PORT=5173
MAX_PORT=5273
DEV_COMMAND="npm run dev"
HEALTH_ENDPOINT="/"
READY_TIMEOUT=30
LOG_FILE="${PROJECT_DIR}/.server.log"
PID_FILE="${PROJECT_DIR}/.server.pid"
URL="http://localhost:${DEFAULT_PORT}"

# Colores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log()  { echo -e "${BLUE}[Mis Finanzas]${NC} $*"; }
ok()   { echo -e "${GREEN}[✓]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
err()  { echo -e "${RED}[✗]${NC} $*"; }

# ── Funciones ──────────────────────────────────────────────────

find_free_port() {
  local port="${1:-$DEFAULT_PORT}"
  local max="${2:-$MAX_PORT}"
  while lsof -ti :"${port}" >/dev/null 2>&1; do
    ((port++))
    if [[ ${port} -gt ${max} ]]; then
      err "No hay puerto libre en rango ${DEFAULT_PORT}-${MAX_PORT}"
      return 1
    fi
  done
  echo "${port}"
}

kill_port() {
  local port="$1"
  local pids
  pids=$(lsof -ti :"${port}" 2>/dev/null || true)
  if [[ -n "${pids}" ]]; then
    warn "Puerto ${port} ocupado — matando procesos: ${pids}"
    echo "${pids}" | xargs kill -9 2>/dev/null || true
    sleep 0.5
  fi
}

wait_for_server() {
  local url="$1"
  local timeout="$2"
  local attempt=0
  log "Esperando servidor en ${url} (timeout: ${timeout}s)..."
  while [[ ${attempt} -lt ${timeout} ]]; do
    if curl -sf --max-time 2 "${url}" >/dev/null 2>&1; then
      ok "Servidor listo"
      return 0
    fi
    sleep 1
    ((attempt++))
  done
  err "Timeout: servidor no respondió en ${timeout}s"
  return 1
}

cleanup_stale() {
  # Limpia PID/log antiguos si el proceso ya no existe
  if [[ -f "${PID_FILE}" ]]; then
    local old_pid
    old_pid=$(cat "${PID_FILE}" 2>/dev/null || true)
    if [[ -n "${old_pid}" ]] && ! kill -0 "${old_pid}" 2>/dev/null; then
      warn "PID file obsoleto (${old_pid}) — limpiando"
      rm -f "${PID_FILE}" "${LOG_FILE}"
    fi
  fi
}

# ── Main ───────────────────────────────────────────────────────

cd "${PROJECT_DIR}"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║           🚀 Mis Finanzas — Dev Launcher                 ║"
echo "╚══════════════════════════════════════════════════════════╝"

cleanup_stale

# 1. Verificar/liberar puerto
PORT=$(find_free_port "${DEFAULT_PORT}" "${MAX_PORT}") || exit 1
URL="http://localhost:${PORT}"

if [[ "${PORT}" -ne "${DEFAULT_PORT}" ]]; then
  warn "Puerto ${DEFAULT_PORT} ocupado — usando ${PORT}"
else
  ok "Puerto ${PORT} libre"
fi

# 2. Matar proceso previo en el puerto elegido (por si acaso)
kill_port "${PORT}"

# 3. Verificar que existe package.json
if [[ ! -f "package.json" ]]; then
  err "No se encuentra package.json en ${PROJECT_DIR}"
  exit 1
fi

# 4. Iniciar servidor en background
log "Iniciando: ${DEV_COMMAND} --port ${PORT}"
# Limpiar log anterior
> "${LOG_FILE}"

# Ejecutar en background con nohup, redirigiendo stdout/stderr al log
# Usamos --port para Vite
nohup ${DEV_COMMAND} -- --port "${PORT}" >>"${LOG_FILE}" 2>&1 &
SERVER_PID=$!

# Guardar PID
echo "${SERVER_PID}" > "${PID_FILE}"

log "Servidor iniciado (PID: ${SERVER_PID})"
log "Logs: tail -f ${LOG_FILE}"

# 5. Esperar a que el servidor responda
if ! wait_for_server "${URL}${HEALTH_ENDPOINT}" "${READY_TIMEOUT}"; then
  err "Falló el inicio. Ver logs: cat ${LOG_FILE}"
  kill "${SERVER_PID}" 2>/dev/null || true
  rm -f "${PID_FILE}"
  exit 1
fi

# 6. Abrir navegador
log "Abriendo navegador en ${URL}"
open "${URL}"

ok "¡Mis Finanzas corriendo en ${URL}"
echo ""
echo "────────────────────────────────────────────────────────────"
echo "  Para detener:  Cierra esta ventana o ejecuta:"
echo "                 kill \$(cat ${PID_FILE})"
echo "  Logs en vivo: tail -f ${LOG_FILE}"
echo "  Puerto:       ${PORT}"
echo "────────────────────────────────────────────────────────────"

# 7. Mantener script vivo para que el usuario vea el output
#    y pueda cerrar con Ctrl+C (mata el servidor hijo)
wait "${SERVER_PID}"