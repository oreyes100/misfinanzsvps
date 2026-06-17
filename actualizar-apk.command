#!/bin/bash
# Reconstruye la APK de Mis Finanzas con los últimos cambios y la copia al escritorio de Proyectos.
# Doble clic para ejecutar.

set -e
cd "$(dirname "$0")"

# --- Toolchain (fuera del PATH global) ---
export JAVA_HOME=/opt/homebrew/opt/openjdk@21       # Capacitor 7 exige JDK 21 (no 17)
export PATH="$JAVA_HOME/bin:$PATH"
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
export ANDROID_SDK_ROOT="$ANDROID_HOME"

DST="/Users/jorge/No sync/Proyectos/MisFinanzas.apk"
SRC="android/app/build/outputs/apk/debug/app-debug.apk"

echo "==> 1/3  Build web (vite)"
npm run build

echo "==> 2/3  Capacitor sync (copia dist a android)"
npx cap sync android

echo "==> 3/3  Gradle assembleDebug"
( cd android && ./gradlew assembleDebug )

cp "$SRC" "$DST"
echo ""
echo "============================================================"
echo " APK actualizada:"
echo "   $DST"
ls -la "$DST"
echo "============================================================"
echo ""
echo "Build DEBUG (instalable directo, no firmada para Play Store)."
echo "Empaqueta dist/ local — incluye todos los cambios actuales."
echo ""
read -n 1 -s -r -p "Listo. Pulsa cualquier tecla para cerrar."
