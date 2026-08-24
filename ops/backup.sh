#!/bin/sh
# Nightly Postgres backup.
#
# PLAN.md §7 calls Postgres "the whole product": lose `baileys_auth` and every session must
# re-pair, which after tonight is not theoretical — a single serialisation bug silently emptied
# it. This runs pg_dump on a schedule, keeps a rolling window, and verifies each dump is
# readable rather than assuming it.
#
# Honest limitation: the default target is a Docker volume on the same host. That protects
# against the likely failures — a bad migration, an accidental DROP, Dokploy recreating the
# database container — but NOT against losing the box. Set BACKUP_S3_* to also ship off-host.
set -eu

DIR="${BACKUP_DIR:-/backups}"
KEEP="${BACKUP_KEEP:-7}"
INTERVAL="${BACKUP_INTERVAL_SECONDS:-86400}"

mkdir -p "$DIR"

dump_once() {
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  out="$DIR/wapi-$ts.sql.gz"
  echo "[backup] starting $ts"

  # --clean --if-exists so the dump restores over an existing database without hand-editing.
  if pg_dump --no-owner --no-privileges --clean --if-exists "$DATABASE_URL" | gzip -9 > "$out.tmp"; then
    mv "$out.tmp" "$out"
  else
    echo "[backup] pg_dump FAILED" >&2
    rm -f "$out.tmp"
    return 1
  fi

  # A dump nobody can read is not a backup. Verify the gzip stream and that the schema we
  # actually depend on is present, rather than trusting a zero exit code.
  if ! gzip -t "$out"; then
    echo "[backup] archive is corrupt, discarding" >&2
    rm -f "$out"
    return 1
  fi
  for table in baileys_creds signal_keys whatsapp_sessions; do
    if ! gzip -dc "$out" | grep -q "CREATE TABLE public.$table"; then
      echo "[backup] dump is missing $table, discarding" >&2
      rm -f "$out"
      return 1
    fi
  done

  size=$(wc -c < "$out")
  echo "[backup] ok $out ($size bytes)"

  # Optional off-host copy. Without this a host loss loses the backups too.
  if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
    if command -v aws >/dev/null 2>&1; then
      aws s3 cp "$out" "s3://$BACKUP_S3_BUCKET/$(basename "$out")" && echo "[backup] shipped off-host"
    else
      echo "[backup] BACKUP_S3_BUCKET set but aws CLI missing; keeping local only" >&2
    fi
  fi

  # Rolling window.
  ls -1t "$DIR"/wapi-*.sql.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
    echo "[backup] pruning $(basename "$old")"
    rm -f "$old"
  done
}

if [ "${BACKUP_ONCE:-}" = "1" ]; then
  dump_once
  exit $?
fi

echo "[backup] loop started; every ${INTERVAL}s, keeping $KEEP"
while true; do
  dump_once || echo "[backup] cycle failed; will retry next interval" >&2
  sleep "$INTERVAL"
done
