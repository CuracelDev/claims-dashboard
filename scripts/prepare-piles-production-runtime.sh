#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPOSITORY_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
RUNTIME_ROOT=${PILES_RUNTIME_ROOT:-"$REPOSITORY_ROOT/.piles-runtime"}
GENERATIONS_DIR="$RUNTIME_ROOT/generations"
CURRENT_LINK="$RUNTIME_ROOT/current"
PREVIOUS_LINK="$RUNTIME_ROOT/previous"
LOCK_PATH="$RUNTIME_ROOT/repair.lock"
REQUIREMENTS_FILE=${PILES_RUNTIME_REQUIREMENTS_FILE:-"$SCRIPT_DIR/piles-auto-assignment-requirements.txt"}
HEALTH_SCRIPT="$SCRIPT_DIR/piles_runtime_health.py"
BASE_PYTHON=${PILES_RUNTIME_BASE_PYTHON:-python3}
CONTROL_PYTHON=${PILES_RUNTIME_CONTROL_PYTHON:-python3}
BUILDER_VERSION=${PILES_RUNTIME_BUILDER_VERSION:-1}
BROWSER_CONFIG=${PILES_RUNTIME_BROWSER_CONFIG:-chromium}
MAX_ATTEMPTS=${PILES_RUNTIME_MAX_ATTEMPTS:-6}
RETRY_DELAY_SECONDS=${PILES_RUNTIME_RETRY_DELAY_SECONDS:-10}
REPAIR_WAIT_SECONDS=${PILES_RUNTIME_REPAIR_WAIT_SECONDS:-900}
INSTALL_OS_DEPS=${PILES_RUNTIME_INSTALL_OS_DEPS:-false}

case "${PILES_ASSIGNMENT_PROVENANCE_V2:-}" in
  ''|disabled|shadow|enabled) ;;
  *) echo "PILES_ASSIGNMENT_PROVENANCE_V2 must be disabled, shadow, or enabled." >&2; exit 2 ;;
esac
case "$INSTALL_OS_DEPS" in
  false|true) ;;
  *) echo "PILES_RUNTIME_INSTALL_OS_DEPS must be false or true." >&2; exit 2 ;;
esac
case "$MAX_ATTEMPTS" in
  ''|*[!0-9]*|0) echo "PILES_RUNTIME_MAX_ATTEMPTS must be a positive integer." >&2; exit 2 ;;
esac
case "$RETRY_DELAY_SECONDS" in
  ''|*[!0-9]*) echo "PILES_RUNTIME_RETRY_DELAY_SECONDS must be a non-negative integer." >&2; exit 2 ;;
esac
case "$REPAIR_WAIT_SECONDS" in
  ''|*[!0-9]*|0) echo "PILES_RUNTIME_REPAIR_WAIT_SECONDS must be a positive integer." >&2; exit 2 ;;
esac
if [ ! -f "$REQUIREMENTS_FILE" ]; then
  echo "Piles runtime requirements file is unavailable." >&2
  exit 2
fi

mkdir -p "$GENERATIONS_DIR"
COMMAND_OUTPUT="$RUNTIME_ROOT/.prepare-command.$$.log"
TEMP_GENERATION=""
LOCK_HELD=false

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  rm -f "$COMMAND_OUTPUT"
  if [ -n "$TEMP_GENERATION" ] && [ -d "$TEMP_GENERATION" ]; then
    rm -rf "$TEMP_GENERATION"
  fi
  if [ "$LOCK_HELD" = true ]; then
    owner=$(readlink "$LOCK_PATH" 2>/dev/null || true)
    if [ "$owner" = "$$" ]; then
      rm -f "$LOCK_PATH"
    fi
  fi
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

retry_quiet() {
  label=$1
  shift
  attempt=1
  while :; do
    status=0
    "$@" >"$COMMAND_OUTPUT" 2>&1 || status=$?
    if [ "$status" -eq 0 ]; then
      return 0
    fi
    if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
      echo "$label failed after $attempt attempt(s), exit $status; subprocess output suppressed." >&2
      return "$status"
    fi
    echo "$label attempt $attempt/$MAX_ATTEMPTS failed; retrying in ${RETRY_DELAY_SECONDS}s." >&2
    sleep "$RETRY_DELAY_SECONDS"
    attempt=$((attempt + 1))
  done
}

python_version=$(
  "$BASE_PYTHON" -c '# RUNTIME_BASE_VERSION
import sys
print(f"{sys.version_info.major}.{sys.version_info.minor}")'
)
fingerprint=$(
  PYTHONPATH="$REPOSITORY_ROOT${PYTHONPATH:+:$PYTHONPATH}" "$CONTROL_PYTHON" -c '
import sys
from scripts.piles_runtime_health import compute_runtime_fingerprint
print(compute_runtime_fingerprint(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]))
' "$REQUIREMENTS_FILE" "$python_version" "$BUILDER_VERSION" "$BROWSER_CONFIG"
)

verify_generation() {
  generation=$1
  verification_output=$(
    "$CONTROL_PYTHON" "$HEALTH_SCRIPT" \
      --runtime-root "$RUNTIME_ROOT" \
      --requirements "$REQUIREMENTS_FILE" \
      --python-bin "$generation/bin/python" \
      --mode full \
      --builder-version "$BUILDER_VERSION" \
      --browser-config "$BROWSER_CONFIG" \
      --json 2>/dev/null
  ) || {
    printf '%s\n' "$verification_output" >&2
    return 1
  }
  return 0
}

resolve_current() {
  if [ ! -L "$CURRENT_LINK" ]; then
    return 1
  fi
  (CDPATH= cd -- "$RUNTIME_ROOT" && CDPATH= cd -- "$(readlink "$CURRENT_LINK")" 2>/dev/null && pwd -P)
}

current_generation=$(resolve_current || true)
if [ -n "$current_generation" ] && verify_generation "$current_generation"; then
  echo "Piles runtime generation $fingerprint is already healthy."
  exit 0
fi

acquire_lock() {
  waited=0
  while ! ln -s "$$" "$LOCK_PATH" 2>/dev/null; do
    owner=$(readlink "$LOCK_PATH" 2>/dev/null || true)
    case "$owner" in
      ''|*[!0-9]*) rm -f "$LOCK_PATH" 2>/dev/null || true; continue ;;
    esac
    if ! kill -0 "$owner" 2>/dev/null; then
      rm -f "$LOCK_PATH" 2>/dev/null || true
      continue
    fi
    if [ "$waited" -ge "$REPAIR_WAIT_SECONDS" ]; then
      echo "Timed out waiting for the Piles runtime repair lock." >&2
      return 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  LOCK_HELD=true
}

acquire_lock
current_generation=$(resolve_current || true)
if [ -n "$current_generation" ] && verify_generation "$current_generation"; then
  echo "Piles runtime generation $fingerprint is already healthy after waiting for repair."
  exit 0
fi

generation_id="${fingerprint}-$(date -u '+%Y%m%dT%H%M%SZ')-$$"
TEMP_GENERATION="$RUNTIME_ROOT/.build-$generation_id"
FINAL_GENERATION="$GENERATIONS_DIR/$generation_id"

retry_quiet "Virtual environment creation" "$BASE_PYTHON" -m venv "$TEMP_GENERATION"
retry_quiet "pip bootstrap" "$TEMP_GENERATION/bin/python" -m ensurepip --upgrade
retry_quiet "pip upgrade" "$TEMP_GENERATION/bin/python" -m pip install --upgrade pip
retry_quiet "Pinned dependency installation" "$TEMP_GENERATION/bin/python" -m pip install -r "$REQUIREMENTS_FILE"
if [ "$INSTALL_OS_DEPS" = true ]; then
  retry_quiet "Playwright browser and OS dependency installation" "$TEMP_GENERATION/bin/python" -m playwright install --with-deps chromium chromium-headless-shell
else
  retry_quiet "Playwright browser installation" "$TEMP_GENERATION/bin/python" -m playwright install chromium chromium-headless-shell
fi

PYTHONPATH="$REPOSITORY_ROOT${PYTHONPATH:+:$PYTHONPATH}" "$CONTROL_PYTHON" -c '
import sys
from scripts.piles_runtime_health import write_runtime_manifest
write_runtime_manifest(sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5])
' "$TEMP_GENERATION" "$REQUIREMENTS_FILE" "$python_version" "$BUILDER_VERSION" "$BROWSER_CONFIG"

mv "$TEMP_GENERATION" "$FINAL_GENERATION"
TEMP_GENERATION=""
if ! verify_generation "$FINAL_GENERATION"; then
  rm -rf "$FINAL_GENERATION"
  echo "Candidate Piles runtime failed full verification; active pointers were not changed." >&2
  exit 1
fi

old_target=""
if [ -L "$CURRENT_LINK" ]; then
  old_target=$(readlink "$CURRENT_LINK")
fi
atomic_symlink() {
  target=$1
  destination=$2
  "$CONTROL_PYTHON" -c '
import os, sys
target, destination = sys.argv[1], sys.argv[2]
temporary = destination + ".tmp." + str(os.getpid())
try:
    os.symlink(target, temporary)
    os.replace(temporary, destination)
finally:
    try:
        os.unlink(temporary)
    except FileNotFoundError:
        pass
' "$target" "$destination"
}
if [ -n "$old_target" ]; then
  atomic_symlink "$old_target" "$PREVIOUS_LINK"
fi
atomic_symlink "generations/$generation_id" "$CURRENT_LINK"

echo "Runtime generation promoted: $fingerprint"
