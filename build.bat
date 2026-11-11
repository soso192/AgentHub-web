@echo off
echo Building CC-Web...
echo.

set PATH=%USERPROFILE%\.cargo\bin;%PATH%

echo [1/2] Building dev edition...
cargo build --release

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Dev build failed!
    pause
    exit /b 1
)

copy /Y target\release\cc-web.exe cc-web-dev.exe
echo     -> cc-web-dev.exe

echo.
echo [2/2] Building implCon edition...
cargo build --release --features implCon

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo implCon build failed!
    pause
    exit /b 1
)

copy /Y target\release\cc-web.exe cc-web-implCon.exe
echo     -> cc-web-implCon.exe

echo.
echo ===================================
echo  Build successful!
echo.
echo  cc-web-dev.exe      (port 3030, full features)
echo  cc-web-implCon.exe  (port 3031, implCon edition)
echo ===================================
echo.

pause
