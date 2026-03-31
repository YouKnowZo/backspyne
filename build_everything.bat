@echo off
echo ==============================================
echo       BackSpyne - Ultimate Deployment Compiler
echo ==============================================
echo.
echo Please ensure you have Node.js and Python installed.
echo.
echo [1] Compiling Web App (React/Vite PWA)...
cd web_gui
call npm run build
echo.

echo [2] Generating BackSpyne Engine EXECUTABLE (Windows)...
cd ..
call pip install pyinstaller
call pyinstaller --noconfirm --onefile --add-data "web_gui\dist;web_gui\dist" gui_server.py
echo ==============================================
echo Windows .exe compiled inside the "\dist" folder!
echo ==============================================
echo.

echo [3] Compiling Native Mobile App (Android/APK)...
cd web_gui
call npx cap sync android
echo Opening Android Studio... Hit Build -^> Build APK!
call npx cap open android
echo.

echo [4] Compiling Native iOS App (Apple/IPA)...
echo Opening Xcode (Mac Required)... Hit Product -^> Archive!
call npx cap sync ios
call npx cap open ios
echo.

echo ==============================================
echo ALL BUILDS COMPLETE! Backspyne is ready for the world.
echo ==============================================
pause
