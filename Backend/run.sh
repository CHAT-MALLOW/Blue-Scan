#!/usr/bin/env bash
set -euo pipefail

# venv
python3 -m venv .venv
source .venv/bin/activate

pip install -U pip
pip install -r requirements.txt

# Télécharge Chromium pour Playwright
python -m playwright install chromium

# Lancer l’API
exec uvicorn app:app --host 0.0.0.0 --port 8000