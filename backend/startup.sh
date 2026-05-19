#!/bin/bash
# Azure App Service startup script for the CN Warehouse FastAPI backend.
#
# App Service Linux Python invokes this after `pip install -r requirements.txt`
# completes. We:
#   1. Run any pending Alembic migrations against the configured Postgres
#      (Azure Database for PostgreSQL Flexible Server, expected via the
#      DATABASE_URL app setting — must include ?ssl=require).
#   2. Boot uvicorn on the port App Service assigns ($PORT — defaults to
#      8000 if missing for local testing).
#
# Logs from this script are written to App Service's default log stream:
#   az webapp log tail --name <app-name> --resource-group <rg>
#
# Set "Startup Command" in App Service → Configuration to:
#     bash startup.sh

set -euo pipefail

cd /home/site/wwwroot

echo "[startup] Working directory: $(pwd)"
echo "[startup] Python version: $(python --version)"
echo "[startup] Running pending Alembic migrations…"
python -m alembic upgrade head
echo "[startup] Migrations complete."

# App Service exposes its assigned port as $PORT. Fall back to 8000 for
# local testing of this script.
PORT="${PORT:-8000}"

# Workers: App Service B1 has 1 core / 1.75GB RAM. Two workers is a safe
# default. Bump on larger plans.
WORKERS="${UVICORN_WORKERS:-2}"

echo "[startup] Starting uvicorn on :${PORT} with ${WORKERS} workers…"
exec python -m uvicorn app.main:app \
    --host 0.0.0.0 \
    --port "${PORT}" \
    --workers "${WORKERS}" \
    --access-log \
    --no-server-header
