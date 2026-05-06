#!/sh
set -e
DB_PATH="/app/data/agent.db"
CONFIG="/etc/litestream.yml"
if [ ! -f "$DB_PATH" ]; then
  echo "[litestream] No local database found — attempting restore…"
  litestream restore -config "$CONFIG" -if-replica-exists "$DB_PATH" || true
fi
echo "[litestream] Starting continuous replication…"
exec litestream replicate -config "$CONFIG"
