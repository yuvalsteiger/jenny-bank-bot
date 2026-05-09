#!/usr/bin/env bash
set -eu

attempt=1
max=3

until npm run scrape:all; do
  if [ "$attempt" -ge "$max" ]; then
    echo "scrape:all failed after $max attempts" >&2
    exit 1
  fi
  echo "scrape attempt $attempt failed; retrying in 60s" >&2
  sleep 60
  attempt=$((attempt + 1))
done

set +e
npx tsx src/check-new-transactions.ts
gate=$?
set -e

case "$gate" in
  0)
    npm run wa:summary
    mv state/current-fingerprint.json state/notified-fingerprint.json
    echo "wa:summary sent; fingerprint promoted"
    ;;
  78)
    echo "no new transactions; skipping wa:summary"
    ;;
  *)
    echo "check-new-transactions failed with exit $gate" >&2
    exit "$gate"
    ;;
esac
