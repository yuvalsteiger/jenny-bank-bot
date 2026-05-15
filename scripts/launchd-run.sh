#!/usr/bin/env bash
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

export PATH="/Users/yuvalsteiger/.nvm/versions/node/v22.22.2/bin:$PATH"

mkdir -p logs
LOG="$REPO_ROOT/logs/launchd.log"

{
  echo
  echo "===== $(date '+%Y-%m-%d %H:%M:%S %z') launchd run starting ====="
} >> "$LOG"

bash scripts/run-once.sh >> "$LOG" 2>&1
EXIT_CODE=$?

if [ "$EXIT_CODE" -ne 0 ]; then
  echo "===== $(date '+%Y-%m-%d %H:%M:%S %z') run failed with exit $EXIT_CODE =====" >> "$LOG"
  /usr/bin/osascript -e 'display notification "Jenny run failed — check logs/launchd.log" with title "Jenny"' || true
else
  echo "===== $(date '+%Y-%m-%d %H:%M:%S %z') run finished ok =====" >> "$LOG"
fi

exit "$EXIT_CODE"
