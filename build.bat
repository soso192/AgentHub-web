@echo off
echo Building CC-Web...
echo.

set PATH=%USERPROFILE%\.cargo\bin;%PATH%

echo [1/3] Building React frontend...
pushd frontend
if not exist node_modules (
    call npm install --no-audit --no-fund
    if %ERRORLEVEL% NEQ 0 (
        echo.
        echo Frontend dependency install failed!
        popd
        pause
        exit /b 1
    )
)
call npm run build
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Frontend build failed!
    popd
    pause
    exit /b 1
)
popd

echo.
echo [2/3] Building dev edition...
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
echo [3/3] Building implCon edition...
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
