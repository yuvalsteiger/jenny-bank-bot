#!/usr/bin/env bash
set -eu

retry() {
  local label="$1"; shift
  local attempt=1
  local max=3
  until "$@"; do
    if [ "$attempt" -ge "$max" ]; then
      echo "$label failed after $max attempts" >&2
      return 1
    fi
    echo "$label attempt $attempt failed; retrying in 60s" >&2
    sleep 60
    attempt=$((attempt + 1))
  done
}

retry "Hapoalim scrape" npm start
retry "Cal scrape"      npm run next-debit
npm run wa:summary
