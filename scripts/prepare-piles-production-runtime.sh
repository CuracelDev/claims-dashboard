#!/bin/sh

set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
VENV_DIR=${PILES_RUNTIME_VENV_DIR:-"$SCRIPT_DIR/../.venv-piles-auto-assignment"}
REQUIREMENTS_FILE=${PILES_RUNTIME_REQUIREMENTS_FILE:-"$SCRIPT_DIR/piles-auto-assignment-requirements.txt"}
READY_MARKER=${PILES_RUNTIME_READY_MARKER:-"$VENV_DIR/.piles-runtime-ready"}
MAX_ATTEMPTS=${PILES_RUNTIME_MAX_ATTEMPTS:-6}
RETRY_DELAY_SECONDS=${PILES_RUNTIME_RETRY_DELAY_SECONDS:-10}

case "$MAX_ATTEMPTS" in
  ''|*[!0-9]*|0) echo "PILES_RUNTIME_MAX_ATTEMPTS must be a positive integer." >&2; exit 2 ;;
esac
case "$RETRY_DELAY_SECONDS" in
  ''|*[!0-9]*) echo "PILES_RUNTIME_RETRY_DELAY_SECONDS must be a non-negative integer." >&2; exit 2 ;;
esac

retry_command() {
  attempt=1
  while :; do
    if "$@"; then
      return 0
    else
      status=$?
    fi
    if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
      echo "Runtime preparation failed after $attempt attempts (exit $status)." >&2
      return "$status"
    fi
    echo "Runtime preparation attempt $attempt/$MAX_ATTEMPTS failed; retrying in ${RETRY_DELAY_SECONDS}s." >&2
    sleep "$RETRY_DELAY_SECONDS"
    attempt=$((attempt + 1))
  done
}

if [ -x "$VENV_DIR/bin/python" ]; then
  :
else
  retry_command sudo apt-get update
  retry_command sudo apt-get install -y python3 python3-pip python3-venv
  python3 -m venv "$VENV_DIR"
fi

retry_command npm install --omit=dev
retry_command "$VENV_DIR/bin/python" -m pip install --upgrade pip
retry_command "$VENV_DIR/bin/python" -m pip install -r "$REQUIREMENTS_FILE"
retry_command "$VENV_DIR/bin/python" -m playwright install chromium chromium-headless-shell

probe_browser() {
  "$VENV_DIR/bin/python" -c 'from playwright.sync_api import sync_playwright
with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    browser.close()'
}

# A real browser launch is positive evidence that both the browser revision and
# its OS libraries work. Legacy healthy hosts avoid APT; interrupted or broken
# bootstraps fall through to the bounded full dependency repair.
if ! probe_browser; then
  retry_command "$VENV_DIR/bin/python" -m playwright install --with-deps chromium chromium-headless-shell
  retry_command probe_browser
fi

mkdir -p "$(dirname -- "$READY_MARKER")"
marker_tmp="${READY_MARKER}.tmp.$$"
trap 'rm -f "$marker_tmp"' EXIT HUP INT TERM
printf 'ready\n' > "$marker_tmp"
mv "$marker_tmp" "$READY_MARKER"
trap - EXIT HUP INT TERM
