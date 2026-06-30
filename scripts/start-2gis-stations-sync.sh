#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")/.."

if [ -f .collector.env ]; then
  set -a
  . ./.collector.env
  set +a
fi

: "${COLLECTOR_URL:=http://127.0.0.1:8090}"

if [ -z "${DGIS_API_KEY:-}" ]; then
  echo "DGIS_API_KEY is empty. Add DGIS_API_KEY to .collector.env before enabling sync." >&2
  exit 1
fi

node scripts/import-2gis-stations.mjs "$@"
