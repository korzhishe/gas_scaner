#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")/.."

if [ -f .collector.env ]; then
  set -a
  . ./.collector.env
  set +a
fi

: "${COLLECTOR_URL:=http://127.0.0.1:8090}"

node scripts/import-public-signals.mjs "$@"
