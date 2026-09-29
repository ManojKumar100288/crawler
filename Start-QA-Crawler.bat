@echo off
REM ============================================================
REM  QA Crawler - one-click launcher
REM  Double-click this file to start the UI server and open it
REM  in your default browser automatically.
REM ============================================================

title QA Crawler Server
cd /d "%~dp0"

echo.
echo   ================================================
echo    QA Crawler - starting up...
echo   ================================================
echo.

REM --- Check that Node.js is installed ---
where node >nul 2>nul
if errorlevel 1 goto NO_NODE

REM --- Install dependencies if missing (first run only) ---
if not exist "node_modules" goto INSTALL
goto RUN

:INSTALL
echo   Installing dependencies for the first time (one-time)...
call npm install
echo   Installing the browser (Chromium)...
call npx playwright install chromium
echo.
goto RUN

:RUN
echo   Starting the QA Crawler server...
echo   Keep THIS window OPEN while you use the tool.
echo   To stop the tool, close this window or press Ctrl+C.
echo.

REM Open the browser after a short delay so the server is ready.
start "" cmd /c "timeout /t 3 >nul & start http://localhost:5177"

REM Start the server in the foreground (keeps this window alive).
node src\server.js

echo.
echo   The server has stopped. If you saw an error above, please share it.
echo   Press any key to close this window.
pause >nul
goto END

:NO_NODE
echo   [ERROR] Node.js was not found on this computer.
echo   Please install Node.js 18+ from https://nodejs.org
echo.
echo   Press any key to close this window.
pause >nul
goto END

:END
