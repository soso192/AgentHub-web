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
echo [2/2] Building novice edition...
cargo build --release --features novice

if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Novice build failed!
    pause
    exit /b 1
)

copy /Y target\release\cc-web.exe cc-web-novice.exe
echo     -> cc-web-novice.exe

echo.
echo ===================================
echo  Build successful!
echo.
echo  cc-web-dev.exe     (port 3030, full features)
echo  cc-web-novice.exe  (port 3031, novice edition)
echo ===================================
echo.

pause
