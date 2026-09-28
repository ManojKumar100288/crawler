@echo off
REM ============================================================
REM  QA Crawler - one-click launcher
REM  Double-click this file to start the UI server and open it
REM  in your default browser automatically.
REM ============================================================

title QA Crawler Server
cd /d "%~dp0"

echo.
echo   Starting QA Crawler UI server...
echo   Keep THIS window open while you use the tool.
echo   Close this window (or press Ctrl+C) to stop the server.
echo.

REM Open the browser after a short delay so the server is ready.
start "" cmd /c "timeout /t 2 >nul & start http://localhost:5177"

REM Start the server (this keeps running in the foreground).
node src\server.js

REM If node fails to start, pause so the user can read the error.
echo.
echo   Server stopped.
pause
