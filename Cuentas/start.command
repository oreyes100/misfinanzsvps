#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
echo "=== PROGRAMA DE CONTABILIDAD ==="

# Si ya hay un servidor corriendo en el puerto 3002, cerrarlo primero
PIDS=$(lsof -ti:3002 2>/dev/null)
if [ -n "$PIDS" ]; then
  echo "Cerrando instancia anterior del servidor..."
  kill $PIDS 2>/dev/null
  sleep 1
fi

# Instalar dependencias nuevas si faltan (p. ej. pdf-lib)
if [ ! -d "node_modules/pdf-lib" ]; then
  echo "Instalando dependencias (primera vez)..."
  npm install --no-audit --no-fund
fi

echo "Iniciando servidor..."
npm start &
sleep 2
open http://localhost:3002
wait
