@echo off
REM Lanzador Windows: sube los cambios locales a GitHub y despliega a Vercel

setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ═══════════════════════════════════════
echo   Mis Finanzas → Produccion
echo ═══════════════════════════════════════

echo.
echo ^> 1/4 Verificando build...
call npm run build
if %errorlevel% neq 0 (
    echo [✗] Build fallo. NO se despliega.
    pause
    exit /b 1
)
echo [✓] Build OK

echo.
echo ^> 2/4 Commit de cambios...
git add -A
git diff --cached --quiet
if %errorlevel% equ 0 (
    echo   (sin cambios nuevos)
) else (
    for /f %%a in ('wmic os get localtime /value ^| find "="') do set "DT=%%a"
    set "DT=!DT:~-4!-!DT:~-6,2!-!DT:~-8,2!-!DT:~-10,2!!DT:~-12,2!"
    git commit -m "chore: deploy !DT!"
)

echo.
echo ^> 3/4 Push a GitHub (respaldo)...
git push origin main
if %errorlevel% neq 0 (
    echo [✗] Push fallo.
    pause
    exit /b 1
)
echo [✓] Push OK

echo.
echo ^> 4/4 Desplegando a Vercel produccion...
call vercel --prod
if %errorlevel% neq 0 (
    echo [✗] Deploy fallo.
    pause
    exit /b 1
)

echo.
echo [✓] Listo: https://mis-finazas-gold.vercel.app
pause