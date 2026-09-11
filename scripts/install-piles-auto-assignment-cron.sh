#!/bin/sh
set -eu

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$ROOT_DIR"

SCHEDULE="${PILES_AUTO_ASSIGNMENT_CRON_SCHEDULE:-0 * * * *}"
LOG_DIR="${PILES_AUTO_ASSIGNMENT_CRON_LOG_DIR:-$ROOT_DIR/tmp}"
LOG_FILE="${PILES_AUTO_ASSIGNMENT_CRON_LOG:-$LOG_DIR/piles-auto-assignment-cron.log}"
ENV_FILE="${PILES_AUTO_ASSIGNMENT_ENV_FILE:-$ROOT_DIR/.env}"
MARKER="# piles-auto-assignment"

mkdir -p "$LOG_DIR"

if [ ! -f "$ENV_FILE" ]; then
  echo "Environment file not found: $ENV_FILE" >&2
  exit 1
fi

TMP_FILE="$(mktemp)"
trap 'rm -f "$TMP_FILE"' EXIT

(crontab -l 2>/dev/null || true) \
  | (grep -v "run-piles-auto-assignment.sh" || true) \
  | (grep -v "piles-auto-assignment-cron.log" || true) \
  | (grep -v "$MARKER" || true) \
  > "$TMP_FILE"

# Quote both the inner shell paths and the outer shell command. Cron interprets
# percent before shell quoting, so escape it only after constructing the command.
shell_quote() {
  printf "'"
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
  printf "'"
}
CRON_SCRIPT="cd $(shell_quote "$ROOT_DIR") && set -a && . $(shell_quote "$ENV_FILE") && set +a && ./scripts/run-piles-auto-assignment.sh --run-source schedule >> $(shell_quote "$LOG_FILE") 2>&1"
CRON_COMMAND="/bin/sh -c $(shell_quote "$CRON_SCRIPT")"
CRON_COMMAND="$(printf '%s' "$CRON_COMMAND" | sed 's/%/\\%/g')"
printf '%s %s %s\n' "$SCHEDULE" "$CRON_COMMAND" "$MARKER" >> "$TMP_FILE"

crontab "$TMP_FILE"

echo "Installed Piles Auto-Assignment cron:"
echo "  Schedule: $SCHEDULE"
echo "  Env file: $ENV_FILE"
echo "  Log file: $LOG_FILE"
