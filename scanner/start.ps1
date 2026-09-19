$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
if (-not (Test-Path ".venv")) {
  py -m venv .venv
  .venv\Scripts\python.exe -m pip install --upgrade pip
  .venv\Scripts\python.exe -m pip install -r requirements.txt
}
if (-not (Test-Path ".env")) {
  Copy-Item .env.example .env
  Write-Host "Created scanner/.env. Fill in BACKSPYNE_OWNER_ID and BACKSPYNE_NODE_TOKEN, then rerun."
  exit 1
}
.venv\Scripts\python.exe run.py