@echo off
cd /d "%~dp0"
if not exist ".venv" (
  py -m venv .venv
  .venv\Scripts\python.exe -m pip install --upgrade pip
  .venv\Scripts\python.exe -m pip install -r requirements.txt
)
if not exist ".env" (
  copy .env.example .env
  echo Created scanner\.env. Fill in BACKSPYNE_OWNER_ID and BACKSPYNE_NODE_TOKEN, then rerun.
  exit /b 1
)
.venv\Scripts\python.exe run.py