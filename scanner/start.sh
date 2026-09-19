#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
if [[ ! -d ".venv" ]]; then
  python3 -m venv .venv
  .venv/bin/python -m pip install --upgrade pip
  .venv/bin/python -m pip install -r requirements.txt
fi
if [[ ! -f ".env" ]]; then
  cp .env.example .env
  echo "Created scanner/.env. Fill in BACKSPYNE_OWNER_ID and BACKSPYNE_NODE_TOKEN, then rerun."
  exit 1
fi
.venv/bin/python run.py