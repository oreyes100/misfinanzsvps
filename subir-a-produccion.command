#!/bin/bash
# Lanzador: sube los cambios locales a GitHub y despliega a producción en Vercel.
cd "$(dirname "$0")"

echo "═══════════════════════════════════════"
echo "  Mis Finanzas → Producción"
echo "═══════════════════════════════════════"

echo "▶ 1/4 Verificando build…"
npm run build || { echo "✖ Build falló. NO se despliega."; read -p "Enter para cerrar…"; exit 1; }

echo "▶ 2/4 Commit de cambios…"
git add -A
if git diff --cached --quiet; then
  echo "  (sin cambios nuevos)"
else
  git commit -m "chore: deploy $(date +%F-%H%M)"
fi

echo "▶ 3/4 Push a GitHub (respaldo)…"
git push origin main || { echo "✖ Push falló."; read -p "Enter para cerrar…"; exit 1; }

echo "▶ 4/4 Desplegando a Vercel producción…"
vercel --prod || { echo "✖ Deploy falló."; read -p "Enter para cerrar…"; exit 1; }

echo ""
echo "✓ Listo: https://mis-finazas-gold.vercel.app"
read -p "Enter para cerrar…"
