@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo Building CC-Web...
echo.

rem ---- toolchain checks ----
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

where cargo >nul 2>&1
if errorlevel 1 (
    echo [ERROR] cargo not found.
    echo Install Rust from https://rustup.rs/ and try again.
    goto :failed
)

rem Prefer npm from PATH; fall back to common install locations.
where npm.cmd >nul 2>&1
if errorlevel 1 (
    if exist "%ProgramFiles%\nodejs\npm.cmd" set "PATH=%ProgramFiles%\nodejs;%PATH%"
)
where npm.cmd >nul 2>&1
if errorlevel 1 (
    if exist "D:\Downloads\Software\nodejs\24.13.1\npm.cmd" set "PATH=D:\Downloads\Software\nodejs\24.13.1;%PATH%"
)
where npm.cmd >nul 2>&1
if errorlevel 1 (
    echo [ERROR] npm not found.
    echo Install Node.js or add its directory to PATH.
    goto :failed
)

rem ---- frontend ----
echo [1/4] Building React frontend...
pushd "%~dp0frontend"
if errorlevel 1 goto :failed

if not exist "node_modules" (
    echo     Installing frontend dependencies...
    call npm.cmd install --no-audit --no-fund
    if errorlevel 1 goto :failed_frontend
)

call npm.cmd run build
if errorlevel 1 goto :failed_frontend
popd

rem ---- dev ----
echo.
echo [2/4] Building dev edition...
cargo build --release
if errorlevel 1 goto :failed_dev

copy /Y "target\release\cc-web.exe" "cc-web-dev.exe" >nul
if errorlevel 1 goto :failed_copy
echo     -^> cc-web-dev.exe

rem ---- implCon ----
echo.
echo [3/4] Building implCon edition...
cargo build --release --features implCon
if errorlevel 1 goto :failed_implcon

copy /Y "target\release\cc-web.exe" "cc-web-implCon.exe" >nul
if errorlevel 1 goto :failed_copy
echo     -^> cc-web-implCon.exe

rem The implCon build overwrites target\release\cc-web.exe; restore dev so start.bat launches dev.
copy /Y "cc-web-dev.exe" "target\release\cc-web.exe" >nul

echo.
echo [4/4] Build complete.
echo.
echo ===================================
echo  cc-web-dev.exe      (port 3030, full features)
echo  cc-web-implCon.exe  (port 3031, implCon edition)
echo ===================================
echo.
pause
exit /b 0

:failed_frontend
popd
echo.
echo [ERROR] Frontend build failed.
goto :failed

:failed_dev
echo.
echo [ERROR] Dev build failed.
goto :failed

:failed_implcon
echo.
echo [ERROR] implCon build failed.
goto :failed

:failed_copy
echo.
echo [ERROR] Copy failed.
echo Close any running cc-web.exe and try again.
goto :failed

:failed
echo.
echo ===================================
echo  Build failed.
echo ===================================
echo.
pause
exit /b 1
