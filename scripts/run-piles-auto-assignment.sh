#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT_DIR"

RUNTIME_ROOT="${PILES_RUNTIME_ROOT:-$ROOT_DIR/.piles-runtime}"
RUNTIME_REQUIREMENTS="${PILES_RUNTIME_REQUIREMENTS_FILE:-$ROOT_DIR/scripts/piles-auto-assignment-requirements.txt}"
RUNTIME_HEALTH_SCRIPT="${PILES_RUNTIME_HEALTH_SCRIPT:-$ROOT_DIR/scripts/piles_runtime_health.py}"
RUNTIME_PREPARE_SCRIPT="${PILES_RUNTIME_PREPARE_SCRIPT:-$ROOT_DIR/scripts/prepare-piles-production-runtime.sh}"
RUNTIME_CONTROL_PYTHON="${PILES_RUNTIME_CONTROL_PYTHON:-python3}"
RUNTIME_RECOVERY_MODE="${PILES_RUNTIME_RECOVERY_MODE:-audit}"
PYTHON_BIN="${PILES_ASSIGNMENT_PYTHON_BIN:-${PYTHON_BIN:-$RUNTIME_ROOT/current/bin/python}}"
PORTAL_ENVIRONMENT="${PILES_AUTO_ASSIGNMENT_SCHEDULE_PORTAL_ENVIRONMENT:-production}"
RUN_MODE="${PILES_AUTO_ASSIGNMENT_SCHEDULE_MODE:-all-active}"
VISIBLE_FLAG="${PILES_AUTO_ASSIGNMENT_SCHEDULE_VISIBLE:-false}"
EXECUTE_FLAG="${PILES_AUTO_ASSIGNMENT_SCHEDULE_EXECUTE:-true}"
MONTH_VALUE="${PILES_AUTO_ASSIGNMENT_SCHEDULE_MONTH:-All}"
YEAR_VALUE="${PILES_AUTO_ASSIGNMENT_SCHEDULE_YEAR:-All}"
INSURER_VALUE="${PILES_AUTO_ASSIGNMENT_SCHEDULE_INSURER:-}"

INVOCATION_BACKEND="${PILES_AUTO_ASSIGNMENT_RUNNER_BACKEND:-local}"
MAX_CONCURRENCY="${PILES_AUTO_ASSIGNMENT_MAX_CONCURRENCY:-1}"

case "$RUNTIME_RECOVERY_MODE" in
  audit|repair) ;;
  *) echo "PILES_RUNTIME_RECOVERY_MODE must be audit or repair." >&2; exit 2 ;;
esac
if [ "$MAX_CONCURRENCY" != "1" ] && [ "$MAX_CONCURRENCY" != "2" ]; then
  echo "PILES_AUTO_ASSIGNMENT_MAX_CONCURRENCY must be 1 or 2." >&2
  exit 1
fi

check_runtime() {
  runtime_output=$(
    "$RUNTIME_CONTROL_PYTHON" "$RUNTIME_HEALTH_SCRIPT" \
      --runtime-root "$RUNTIME_ROOT" \
      --requirements "$RUNTIME_REQUIREMENTS" \
      --python-bin "$PYTHON_BIN" \
      --mode light \
      --json 2>/dev/null
  ) || return $?
  if [ -n "$runtime_output" ]; then
    printf 'Runtime preflight: %s\n' "$runtime_output"
  fi
}

runtime_status=0
check_runtime || runtime_status=$?
if [ "$runtime_status" -ne 0 ]; then
  if [ "$RUNTIME_RECOVERY_MODE" = "audit" ]; then
    echo "Piles runtime is unhealthy; audit mode forbids automatic repair and runner launch." >&2
    exit "$runtime_status"
  fi
  echo "Piles runtime is unhealthy; starting locked atomic repair."
  repair_status=0
  /bin/sh "$RUNTIME_PREPARE_SCRIPT" || repair_status=$?
  if [ "$repair_status" -ne 0 ]; then
    echo "Piles runtime repair failed; runner launch was blocked." >&2
    exit "$repair_status"
  fi
  runtime_status=0
  check_runtime || runtime_status=$?
  if [ "$runtime_status" -ne 0 ]; then
    echo "Piles runtime remained unhealthy after repair; runner launch was blocked." >&2
    exit "$runtime_status"
  fi
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
