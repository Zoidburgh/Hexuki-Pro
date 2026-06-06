@echo off
REM ========================================
REM Hexuki SOLVE server (native-ish, off-browser, cached)
REM ========================================
REM Runs the C++ engine (via the node WASM build) as a local solve service on port 8080.
REM Solves happen here instead of in the browser, so the editor never freezes, and every
REM completed solve is cached to disk (server\cache.jsonl).
REM
REM Requires: bench\build.ps1 has been run once (produces bench\engine\hexuki.{js,wasm}).

cd /d "%~dp0\.."
echo Starting Hexuki solve server on http://localhost:8080
echo (Ctrl+C to stop)
echo.
node server\solve-server.cjs
pause
