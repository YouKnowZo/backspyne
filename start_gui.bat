@echo off
echo ==============================================
echo       BackSpyne - Engine Startup Sequence
echo ==============================================
echo.
echo [1] Initializing Backend API and Full PWA Engine...
start cmd /k "title BackSpyne API Engine && python gui_server.py"

echo [2] Launching Dashboard in Default Browser...
timeout /t 3 /nobreak > NUL
start http://localhost:8000
