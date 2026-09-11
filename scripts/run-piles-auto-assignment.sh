#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT_DIR"

DEFAULT_VENV_PYTHON="$ROOT_DIR/.venv-piles-auto-assignment/bin/python"
if [ -x "$DEFAULT_VENV_PYTHON" ]; then
  FALLBACK_PYTHON="$DEFAULT_VENV_PYTHON"
else
  FALLBACK_PYTHON="python3"
fi
PYTHON_BIN="${PILES_ASSIGNMENT_PYTHON_BIN:-${PYTHON_BIN:-$FALLBACK_PYTHON}}"
PORTAL_ENVIRONMENT="${PILES_AUTO_ASSIGNMENT_SCHEDULE_PORTAL_ENVIRONMENT:-production}"
RUN_MODE="${PILES_AUTO_ASSIGNMENT_SCHEDULE_MODE:-all-active}"
VISIBLE_FLAG="${PILES_AUTO_ASSIGNMENT_SCHEDULE_VISIBLE:-false}"
EXECUTE_FLAG="${PILES_AUTO_ASSIGNMENT_SCHEDULE_EXECUTE:-true}"
MONTH_VALUE="${PILES_AUTO_ASSIGNMENT_SCHEDULE_MONTH:-All}"
YEAR_VALUE="${PILES_AUTO_ASSIGNMENT_SCHEDULE_YEAR:-All}"
INSURER_VALUE="${PILES_AUTO_ASSIGNMENT_SCHEDULE_INSURER:-}"

INVOCATION_BACKEND="${PILES_AUTO_ASSIGNMENT_RUNNER_BACKEND:-local}"
MAX_CONCURRENCY="${PILES_AUTO_ASSIGNMENT_MAX_CONCURRENCY:-1}"

if [ "$MAX_CONCURRENCY" != "1" ] && [ "$MAX_CONCURRENCY" != "2" ]; then
  echo "PILES_AUTO_ASSIGNMENT_MAX_CONCURRENCY must be 1 or 2." >&2
  exit 1
fi

set -- -u scripts/piles_auto_assignment_runner.py \
  --portal-environment "$PORTAL_ENVIRONMENT" \
  --month "$MONTH_VALUE" \
  --year "$YEAR_VALUE" \
  --run-source schedule \
  --invocation-backend "$INVOCATION_BACKEND"

if [ "$RUN_MODE" = "one-insurer" ]; then
  if [ -z "$INSURER_VALUE" ]; then
    echo "PILES_AUTO_ASSIGNMENT_SCHEDULE_INSURER is required when mode is one-insurer." >&2
    exit 1
  fi
  set -- "$@" --insurer "$INSURER_VALUE"
else
  set -- "$@" --all-active
fi

if [ "$VISIBLE_FLAG" = "true" ]; then
  set -- "$@" --visible
fi

if [ "$EXECUTE_FLAG" = "true" ]; then
  set -- "$@" --execute
fi

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting Piles Auto-Assignment schedule"
echo "Portal environment: $PORTAL_ENVIRONMENT"
echo "Mode: $RUN_MODE"
echo "Month/Year: $MONTH_VALUE $YEAR_VALUE"

exec "$PYTHON_BIN" "$@"
