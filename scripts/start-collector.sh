#!/usr/bin/env sh
set -eu

cd "$(dirname "$0")/.."

if [ -f .collector.env ]; then
  set -a
  . ./.collector.env
  set +a
fi

: "${COLLECTOR_PORT:=8090}"
: "${COLLECTOR_DB:=/home/deploy/projects/gas_scaner/collector/stations.sqlite3}"

if [ -z "${COLLECTOR_TOKEN:-}" ]; then
  echo "Warning: COLLECTOR_TOKEN is empty; POST /api/reports will be public." >&2
fi

if command -v ss >/dev/null 2>&1 && ss -tulpn | grep -q ":${COLLECTOR_PORT}"; then
  echo "Collector already appears to be listening on port ${COLLECTOR_PORT}."
  exit 0
fi

setsid -f sh -c 'exec python3 collector/server.py >>/tmp/gas_scaner_collector.log 2>&1'
echo "Collector started on port ${COLLECTOR_PORT}. Log: /tmp/gas_scaner_collector.log"
