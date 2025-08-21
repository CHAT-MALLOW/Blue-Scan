#!/usr/bin/env bash
set -Eeuo pipefail
cd "$(dirname "$0")"

python3 -m venv .venv
source .venv/bin/activate
pip install -U pip
pip install -r requirements.txt

# Navigateurs + libs système (OK en root)
python -m playwright install chromium
python -m playwright install-deps || true

exec uvicorn app:app --host 0.0.0.0 --port 8000 --loop asyncio