@echo off
echo ==============================================
echo       BackSpyne - Engine Startup Sequence
echo ==============================================
echo.
echo [1] Initializing Backend API (Persistent Node)...
start cmd /k "title BackSpyne API Engine && python gui_server.py"

echo [2] Booting High-Fidelity Tracking GUI...
cd web_gui
npm run dev
