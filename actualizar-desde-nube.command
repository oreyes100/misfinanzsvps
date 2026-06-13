#!/bin/bash
# Lanzador: trae a local la última versión respaldada en GitHub.
cd "$(dirname "$0")"

echo "═══════════════════════════════════════"
echo "  GitHub → Local (Mis Finanzas)"
echo "═══════════════════════════════════════"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "⚠ Hay cambios locales sin commitear:"
  git status --short
  read -p "¿Continuar con pull? Cambios locales podrían generar conflicto (s/N): " ok
  [[ "$ok" != "s" && "$ok" != "S" ]] && { echo "Cancelado."; exit 0; }
fi

echo "▶ Trayendo última versión de GitHub…"
git pull origin main || { echo "✖ Pull falló (¿conflictos?)."; read -p "Enter para cerrar…"; exit 1; }

echo "▶ Actualizando dependencias…"
npm install

echo ""
echo "✓ Local actualizado. Arranca con: npm run dev"
read -p "Enter para cerrar…"
