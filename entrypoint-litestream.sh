#!/bin/sh
set -e
DB_PATH="/app/data/agent.db"
CONFIG="/etc/litestream.yml"
READY_FLAG="/app/data/.litestream-ready"

# Prevent stale readiness from previous runs before restore decision.
rm -f "$READY_FLAG"

if [ ! -f "$DB_PATH" ]; then
  echo "[litestream] Restore attempted: local database missing at $DB_PATH"
  litestream restore -config "$CONFIG" -if-replica-exists "$DB_PATH"
  echo "[litestream] Restore step completed (database restored or no backup found)."
else
  echo "[litestream] Existing local database found at $DB_PATH; skipping restore."
fi

touch "$READY_FLAG"
echo "[litestream] Restore gate ready file created at $READY_FLAG."

echo "[litestream] Replication start: launching continuous Litestream replication."
exec litestream replicate -config "$CONFIG"
