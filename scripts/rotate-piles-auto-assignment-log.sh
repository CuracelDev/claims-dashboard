#!/bin/sh
set -eu

LOG_FILE=${1:-}
MAX_BYTES=${PILES_AUTO_ASSIGNMENT_CRON_LOG_MAX_BYTES:-10485760}
MAX_AGE_DAYS=${PILES_AUTO_ASSIGNMENT_CRON_LOG_MAX_AGE_DAYS:-7}
RETAIN=${PILES_AUTO_ASSIGNMENT_CRON_LOG_RETAIN:-7}

case "$LOG_FILE" in '') echo "Log file path is required." >&2; exit 2 ;; esac
case "$MAX_BYTES" in ''|*[!0-9]*|0) echo "Log max bytes must be a positive integer." >&2; exit 2 ;; esac
case "$MAX_AGE_DAYS" in ''|*[!0-9]*|0) echo "Log max age must be a positive integer." >&2; exit 2 ;; esac
case "$RETAIN" in ''|*[!0-9]*|0) echo "Log retention must be a positive integer." >&2; exit 2 ;; esac

[ -f "$LOG_FILE" ] || exit 0
size=$(wc -c < "$LOG_FILE" | tr -d ' ')
rotate=false
if [ "$size" -ge "$MAX_BYTES" ]; then
  rotate=true
elif find "$LOG_FILE" -prune -mtime "+$MAX_AGE_DAYS" -print | grep -q .; then
  rotate=true
fi
[ "$rotate" = true ] || exit 0

index=$RETAIN
while [ "$index" -gt 1 ]; do
  previous=$((index - 1))
  if [ -f "$LOG_FILE.$previous" ]; then
    mv -f "$LOG_FILE.$previous" "$LOG_FILE.$index"
  fi
  index=$previous
done
mv -f "$LOG_FILE" "$LOG_FILE.1"
: > "$LOG_FILE"
