@echo off
REM ZTD - Single command to start both backend and frontend (Windows)
REM Usage: run.bat

echo 🚀 Starting ZTD Application...
echo.

cd backend

REM Create venv if it doesn't exist
if not exist "venv" (
    echo    Creating virtual environment...
    python -m venv venv
)

REM Activate venv and install dependencies
call venv\Scripts\activate.bat
pip install -q -r requirements.txt 2>nul || pip install -r requirements.txt

REM Start backend in background
start "ZTD Backend" /min python app.py
cd ..

timeout /t 3 /nobreak >nul
echo    ✅ Backend starting on http://localhost:5001
echo.

cd frontend

REM Install dependencies if needed
if not exist "node_modules" (
    echo    Installing dependencies (this may take a minute)...
    call npm install
)

REM Start frontend
echo    ✅ Frontend starting on http://localhost:3000
echo.
echo ✨ ZTD is starting up!
echo.
echo    Backend:  http://localhost:5001
echo    Frontend: http://localhost:3000
echo.
echo    Close the windows to stop the servers
echo.

start "ZTD Frontend" npm start
cd ..

pause
