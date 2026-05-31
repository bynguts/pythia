@echo off
setlocal
title JWIS Launcher

set "BASE_DIR=%~dp0"
set "PROJECT_DIR=%BASE_DIR%jwis"
set "BACKEND_URL=http://127.0.0.1:8001/api/health"
set "FRONTEND_URL=http://127.0.0.1:5175"
set "PYTHON_EXE=C:\Users\HP\AppData\Local\Programs\Python\Python312\python.exe"

if not exist "%PROJECT_DIR%\frontend\package.json" (
  echo [ERROR] Cannot find project folder:
  echo %PROJECT_DIR%
  pause
  exit /b 1
)

if not exist "%PYTHON_EXE%" (
  echo [ERROR] Python 3.12 not found at:
  echo %PYTHON_EXE%
  pause
  exit /b 1
)

echo ========================================
echo   JWIS Winning System Launcher
echo ========================================
echo.

echo [1/4] Checking backend on port 8001...
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -Uri '%BACKEND_URL%' -UseBasicParsing -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  echo Backend not running. Starting FastAPI...
  start "JWIS Backend" /min cmd /k "cd /d ""%PROJECT_DIR%\backend"" && ""%PYTHON_EXE%"" -m uvicorn app.main:app --host 127.0.0.1 --port 8001"
) else (
  echo Backend already running.
)

echo [2/4] Checking frontend on port 5175...
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -Uri '%FRONTEND_URL%' -UseBasicParsing -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }"
if errorlevel 1 (
  echo Frontend not running. Starting Vite...
  start "JWIS Frontend" /min cmd /k "cd /d ""%PROJECT_DIR%\frontend"" && set ""VITE_API_URL=http://127.0.0.1:8001/api"" && npm run dev -- --port 5175"
) else (
  echo Frontend already running.
)

echo [3/4] Waiting for services...
set /a ATTEMPTS=0
:wait_loop
set /a ATTEMPTS+=1
powershell -NoProfile -ExecutionPolicy Bypass -Command "$backend=$false; $frontend=$false; try { Invoke-WebRequest -Uri '%BACKEND_URL%' -UseBasicParsing -TimeoutSec 2 | Out-Null; $backend=$true } catch {}; try { Invoke-WebRequest -Uri '%FRONTEND_URL%' -UseBasicParsing -TimeoutSec 2 | Out-Null; $frontend=$true } catch {}; if ($backend -and $frontend) { exit 0 } else { exit 1 }"
if not errorlevel 1 goto ready
if %ATTEMPTS% GEQ 30 goto timeout
timeout /t 2 /nobreak >nul
goto wait_loop

:ready
echo [4/4] Opening JWIS in browser...
start "" "%FRONTEND_URL%"
echo.
echo JWIS is ready.
echo URL      : %FRONTEND_URL%
echo Username : admin
echo Password : admin123
echo.
echo You can close this launcher window. Backend and frontend keep running in their own windows.
pause
exit /b 0

:timeout
echo.
echo [WARN] Services took too long to confirm, but they may still be starting.
echo Opening browser anyway:
echo %FRONTEND_URL%
start "" "%FRONTEND_URL%"
pause
exit /b 0
