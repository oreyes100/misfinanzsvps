@echo off
REM Mis Finanzas — Launcher Windows (doble clic)
REM Abre una terminal persistente con npm run dev y el navegador.

cd /d "%~dp0"

title Mis Finanzas — Dev Server

echo ╔══════════════════════════════════════════╗
echo ║   🚀 Mis Finanzas — Dev Server (Windows) ║
echo ╚══════════════════════════════════════════╝
echo.

REM ── 1. Liberar puerto 5173 si está ocupado ──
echo [1/5] Verificando puerto 5173...
set "PORT_CLEAR=1"
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5173 " 2^>nul') do (
    taskkill /F /PID %%a >nul 2>&1
    set "PORT_CLEAR=0"
)
if "%PORT_CLEAR%"=="0" (
    echo   [✓] Puerto liberado
    timeout /t 1 >nul
) else (
    echo   [✓] Puerto libre
)

REM ── 2. Verificar npm disponible ──
echo [2/5] Verificando npm...
where npm >nul 2>&1
if %errorlevel% neq 0 (
    echo   [✗] npm no encontrado. Instala Node.js desde https://nodejs.org
    pause
    exit /b 1
)
echo   [✓] npm disponible

REM ── 3. Verificar node_modules ──
echo [3/5] Verificando dependencias...
if not exist "node_modules" (
    echo   Instalando dependencias...
    call npm install
)
echo   [✓] Dependencias listas

REM ── 4. Iniciar servidor ──
echo [4/5] Iniciando servidor Vite...
echo   Ejecutando: npm run dev
echo.
echo   ── Output del servidor ──────────────────────

start "Mis Finanzas — npm run dev" cmd /k "npm run dev"

echo   ──────────────────────────────────────────────
echo.

REM ── 5. Esperar servidor y abrir navegador ──
echo [5/5] Esperando que el servidor responda...
set "TIMEOUT=0"
:health_check
timeout /t 2 >nul
set /a TIMEOUT+=1
if %TIMEOUT% gtr 20 (
    echo   [✗] El servidor no arrancó en 40 segundos.
    echo       Revisa la ventana "Mis Finanzas - npm run dev"
    pause
    exit /b 1
)
powershell -Command "try { (Invoke-WebRequest -Uri 'http://localhost:5173' -UseBasicParsing -TimeoutSec 2).StatusCode -eq 200 } catch { 0 }" >nul 2>&1
if %errorlevel% neq 0 goto health_check

echo   [✓] Servidor listo en http://localhost:5173
echo.
start http://localhost:5173

echo ══════════════════════════════════════════
echo  ✅ Web UI abierta en el navegador
echo  📌 Cierra la ventana "Mis Finanzas — npm run dev"
echo     para detener el servidor.
echo ══════════════════════════════════════════
echo.
echo Presiona Ctrl+C para salir de este panel.
echo.

REM Mantener esta ventana viva
:keep
timeout /t 10 >nul
:: Verificar que el proceso node aun existe
tasklist /fi "WindowTitle eq Mis Finanzas — npm run dev*" 2>nul | find "cmd.exe" >nul
if %errorlevel% neq 0 (
    echo [!] La ventana del servidor se cerro.
    pause
    exit /b 0
)
goto keep