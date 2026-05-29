@echo off
echo Building CC-Web...
echo.

set PATH=%USERPROFILE%\.cargo\bin;%PATH%

cargo build --release

if %ERRORLEVEL% EQU 0 (
    echo.
    echo Build successful!
    echo Executable: target\release\cc-web.exe
    echo.
    echo Copying to project root...
    copy /Y target\release\cc-web.exe cc-web.exe
    echo.
    echo Done! Run cc-web.exe to start the server.
) else (
    echo.
    echo Build failed!
)

pause
