@echo off
REM Lanzador Windows: trae a local la ultima version respaldada en GitHub

setlocal
cd /d "%~dp0"

echo ═══════════════════════════════════════
echo   GitHub → Local (Mis Finanzas)
echo ═══════════════════════════════════════

REM Verificar si hay cambios locales
git diff --quiet
if %errorlevel% neq 0 goto :has_changes
git diff --cached --quiet
if %errorlevel% neq 0 goto :has_changes
goto :no_changes

:has_changes
echo.
echo ⚠ Hay cambios locales sin commitear:
git status --short
echo.
set /p ok="Continuar con pull? Cambios locales podrian generar conflicto (s/N): "
if /i not "%ok%"=="s" (
    echo Cancelado.
    pause
    exit /b 0
)

:no_changes
echo.
echo ^> Trayendo ultima version de GitHub...
git pull origin main
if %errorlevel% neq 0 (
    echo ✖ Pull fallo (conflictos?).
    pause
    exit /b 1
)

echo ^> Actualizando dependencias...
call npm install

echo.
echo ✓ Local actualizado. Arranca con: npm run dev
pause