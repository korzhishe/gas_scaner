#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")/.."

if [ -f .collector.env ]; then
  set -a
  . ./.collector.env
  set +a
fi

: "${COLLECTOR_URL:=http://127.0.0.1:8090}"

if [ -z "${BENZUP_TOKEN:-}" ]; then
  echo "BENZUP_TOKEN is empty. Add BENZUP_TOKEN to .collector.env before enabling sync." >&2
  exit 1
fi

node scripts/import-benzup.mjs "$@"
