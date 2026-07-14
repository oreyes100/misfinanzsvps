#!/bin/bash
# install.sh — Instalador para Ubuntu 22.04 / Debian 12
# Uso: bash install.sh
set -e

echo "=== Cuentas Congregación — Instalación VPS ==="

# ── 1. Docker ─────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  echo "Instalando Docker..."
  curl -fsSL https://get.docker.com | sh
  usermod -aG docker "$USER"
  echo "Docker instalado. Puede que necesite re-login para aplicar el grupo."
fi

if ! command -v docker &>/dev/null; then
  echo "ERROR: Docker no disponible. Instale manualmente y re-ejecute."
  exit 1
fi

# ── 2. Crear .env si no existe ────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ ! -f "$SCRIPT_DIR/.env" ]; then
  cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
  # Generar JWT_SECRET aleatorio
  JWT_SECRET=$(openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | base64 | tr -d '\n=/')
  sed -i "s/cambia_este_secreto_largo_y_aleatorio/$JWT_SECRET/" "$SCRIPT_DIR/.env"
  echo ""
  echo "⚠  Archivo .env creado con secreto aleatorio."
  echo "   Edítelo para agregar GEMINI_API_KEY si desea OCR con IA:"
  echo "   nano $SCRIPT_DIR/.env"
  echo ""
fi

# ── 3. Build y arranque ───────────────────────────────────────────
cd "$SCRIPT_DIR/.."
echo "Construyendo imagen Docker..."
docker compose -f vps/docker-compose.yml build

echo "Iniciando servicios..."
docker compose -f vps/docker-compose.yml up -d

echo ""
echo "✅ Sistema iniciado en http://localhost:3002"
echo ""
echo "Credenciales iniciales:"
echo "  Usuario:    admin"
echo "  Contraseña: admin1234"
echo ""
echo "IMPORTANTE: Cambie la contraseña desde el panel de Administración."
echo ""
echo "Comandos útiles:"
echo "  Ver logs:   docker compose -f vps/docker-compose.yml logs -f"
echo "  Detener:    docker compose -f vps/docker-compose.yml down"
echo "  Reiniciar:  docker compose -f vps/docker-compose.yml restart"
