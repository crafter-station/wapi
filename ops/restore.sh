#!/bin/sh
# Restore a wapi backup.
#
# PLAN.md §7 says to test a restore before launch, so this is a real script rather than a note.
#
#   docker compose run --rm -e BACKUP_FILE=/backups/wapi-<ts>.sql.gz backup /ops/restore.sh
#
# It refuses to run without CONFIRM=yes: restoring drops and recreates every object, and doing
# that to a live database by accident costs every session a re-pair.
set -eu

: "${BACKUP_FILE:?set BACKUP_FILE to the archive to restore}"
[ "${CONFIRM:-}" = "yes" ] || { echo "refusing without CONFIRM=yes — this DROPs existing objects" >&2; exit 2; }

echo "[restore] verifying $BACKUP_FILE"
gzip -t "$BACKUP_FILE"

echo "[restore] applying (this drops and recreates objects)"
gzip -dc "$BACKUP_FILE" | psql --set ON_ERROR_STOP=on "$DATABASE_URL"

echo "[restore] verifying the auth tables survived"
psql "$DATABASE_URL" -tAc "select 'creds=' || count(*) from baileys_creds"
psql "$DATABASE_URL" -tAc "select 'keys='  || count(*) from signal_keys"
psql "$DATABASE_URL" -tAc "select 'sessions=' || count(*) from whatsapp_sessions"
echo "[restore] done"
