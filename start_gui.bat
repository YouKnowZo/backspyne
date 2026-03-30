@echo off
echo ==============================================
echo       Spy Finder Pro - Start Script
echo ==============================================
echo.
echo [1] Starting Python Background Scanner (API)...
start cmd /k "title Scanner API && python gui_server.py"

echo [2] Starting Beautiful Web Interface...
cd web_gui
npm run dev
