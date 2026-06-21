@echo off
REM Mis Finanzas — Launcher Windows (doble clic para iniciar)
REM Inicia servidor Vite, abre navegador en http://localhost:5173
REM Mata cualquier proceso previo en el puerto 5173

setlocal enabledelayedexpansion

set "PROJECT_DIR=%~dp0"
set "DEFAULT_PORT=5173"
set "LOG_FILE=%PROJECT_DIR%.server.log"
set "PID_FILE=%PROJECT_DIR%.server.pid"

cd /d "%PROJECT_DIR%"

echo ╔══════════════════════════════════════════════════════════╗
echo ║           🚀 Mis Finanzas — Dev Launcher (Windows)       ║
echo ╚══════════════════════════════════════════════════════════╝
echo.

REM ── 1. Verificar/liberar puerto ──
echo [!] Verificando puerto %DEFAULT_PORT%...
set "PORT_FREE=1"
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :%DEFAULT_PORT% 2^>nul') do (
    set "PORT_FREE=0"
    set "OLD_PID=%%a"
)

if "%PORT_FREE%"=="0" (
    echo [!] Puerto %DEFAULT_PORT% ocupado por PID !OLD_PID! — matando...
    taskkill /F /PID !OLD_PID! >nul 2>&1
    timeout /t 1 /nobreak >nul
    echo [✓] Proceso eliminado
) else (
    echo [✓] Puerto %DEFAULT_PORT% libre
)

REM ── 2. Verificar package.json ──
if not exist "package.json" (
    echo [✗] No se encuentra package.json
    pause
    exit /b 1
)

REM ── 3. Limpiar log anterior ──
if exist "%LOG_FILE%" del "%LOG_FILE%"
if exist "%PID_FILE%" del "%PID_FILE%"

REM ── 4. Iniciar servidor ──
echo.
echo [Mis Finanzas] Iniciando: npm run dev

start /B "" npm run dev > "%LOG_FILE%" 2>&1

:: Esperar a que el puerto se abra
timeout /t 3 /nobreak >nul

set "SERVER_PID="
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :%DEFAULT_PORT% 2^>nul') do (
    set "SERVER_PID=%%a"
)
if defined SERVER_PID (
    echo !SERVER_PID! > "%PID_FILE%"
    echo [Mis Finanzas] Servidor iniciado (PID: !SERVER_PID!)
) else (
    echo [Mis Finanzas] Servidor lanzado (proceso en segundo plano)
)
echo [Mis Finanzas] Logs: type "%LOG_FILE%"

REM ── 5. Esperar servidor ──
echo.
echo [Mis Finanzas] Esperando servidor en http://localhost:%DEFAULT_PORT%...
set "TIMEOUT=30"
set "ATTEMPT=0"

:wait_loop
if !ATTEMPT! geq %TIMEOUT% (
    echo [✗] Timeout: servidor no respondio en %TIMEOUT%s
    echo     Revisa logs: type "%LOG_FILE%"
    pause
    exit /b 1
)
powershell -Command "try { $r = Invoke-WebRequest -Uri 'http://localhost:%DEFAULT_PORT%' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>&1
if %errorlevel% equ 0 (
    echo [✓] Servidor listo
    goto :server_ready
)
timeout /t 1 /nobreak >nul
set /a ATTEMPT+=1
goto :wait_loop

:server_ready

REM ── 6. Abrir navegador ──
echo.
echo [Mis Finanzas] Abriendo navegador...
start "" http://localhost:%DEFAULT_PORT%

echo.
echo [✓] Mis Finanzas corriendo en http://localhost:%DEFAULT_PORT%
echo.
echo ────────────────────────────────────────────────────────────
echo   Para detener:  Cierra esta ventana o ejecuta:
echo                  taskkill /F /PID !SERVER_PID!
echo   Logs en vivo:  type "%LOG_FILE%"
echo   Puerto:        %DEFAULT_PORT%
echo ────────────────────────────────────────────────────────────
echo.
echo Presiona Ctrl+C para detener el servidor y cerrar.

REM ── 7. Mantener script vivo ──
:keep_alive
timeout /t 5 /nobreak >nul
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :%DEFAULT_PORT% 2^>nul') do set "CURRENT_PID=%%a"
if not defined CURRENT_PID (
    echo [!] El servidor se ha detenido.
    pause
    exit /b 0
)
goto :keep_alive