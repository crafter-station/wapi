#!/bin/sh
# Nightly Postgres backup, with restore verification.
#
# PLAN.md §7 calls Postgres "the whole product": lose `baileys_creds` and every session must
# re-pair, which is not theoretical — a single serialisation bug silently emptied it once
# already. §7 also says to test a restore before launch. Rather than doing that once by hand,
# every backup restores itself into a scratch database and compares row counts against the
# source. A backup that has never been restored is a guess.
#
# Outcomes are written to the `backup_runs` table because this container's logs are not
# reachable through the VPS CLI. An unobservable backup is barely better than no backup.
#
# Honest limitation: BACKUP_DIR is a volume on this host. That covers a bad migration, an
# accidental DROP, or Dokploy recreating the database container — but NOT losing the box.
# Set BACKUP_S3_BUCKET to also ship off-host.
set -eu

DIR="${BACKUP_DIR:-/backups}"
KEEP="${BACKUP_KEEP:-7}"
INTERVAL="${BACKUP_INTERVAL_SECONDS:-86400}"
VERIFY="${BACKUP_VERIFY_RESTORE:-1}"

mkdir -p "$DIR"

# Same server, different database. Built with POSIX parameter expansion rather than sed:
# busybox sed (alpine) lacks the GNU alternation the previous version used, so a sed-based
# build works when tested locally and silently yields a broken URL inside the container.
db_url_for() { echo "${DATABASE_URL%/*}/$1"; }

count() { psql -tAX "$1" -c "select count(*) from $2" 2>/dev/null || echo -1; }

record() {
  # $1 ok  $2 archive  $3 bytes  $4 restore_ok  $5 creds  $6 keys  $7 sessions  $8 error
  psql -qtAX "$DATABASE_URL" -c "
    insert into backup_runs (finished_at, archive, bytes, ok, restore_ok, creds_rows, key_rows, session_rows, error)
    values (now(), $(sqlstr "$2"), $3, $1, $4, $5, $6, $7, $(sqlstr "$8"))" >/dev/null 2>&1 || true
}

sqlstr() { [ -z "${1:-}" ] && echo NULL || printf "'%s'" "$(echo "$1" | sed "s/'/''/g")"; }

dump_once() {
  ts=$(date -u +%Y%m%dT%H%M%SZ)
  out="$DIR/wapi-$ts.sql.gz"
  echo "[backup] starting $ts"

  src_creds=$(count "$DATABASE_URL" baileys_creds)
  src_keys=$(count "$DATABASE_URL" signal_keys)
  src_sessions=$(count "$DATABASE_URL" whatsapp_sessions)

  # --clean --if-exists so the archive restores over an existing database unedited.
  if ! pg_dump --no-owner --no-privileges --clean --if-exists "$DATABASE_URL" | gzip -9 > "$out.tmp"; then
    rm -f "$out.tmp"
    record false "" NULL NULL NULL NULL NULL "pg_dump failed"
    echo "[backup] pg_dump FAILED" >&2
    return 1
  fi
  mv "$out.tmp" "$out"

  # A dump nobody can read is not a backup.
  if ! gzip -t "$out"; then
    rm -f "$out"
    record false "$(basename "$out")" NULL NULL NULL NULL NULL "archive corrupt"
    echo "[backup] archive corrupt, discarded" >&2
    return 1
  fi
  for table in baileys_creds signal_keys whatsapp_sessions; do
    if ! gzip -dc "$out" | grep -q "CREATE TABLE public.$table"; then
      rm -f "$out"
      record false "$(basename "$out")" NULL NULL NULL NULL NULL "dump missing $table"
      echo "[backup] dump missing $table, discarded" >&2
      return 1
    fi
  done

  bytes=$(wc -c < "$out")
  restore_ok=NULL
  err=""

  if [ "$VERIFY" = "1" ]; then
    scratch="wapi_verify_$(date -u +%s)"
    admin=$(db_url_for postgres)
    target=$(db_url_for "$scratch")

    if psql -qX "$admin" -c "CREATE DATABASE \"$scratch\"" >/dev/null 2>&1; then
      if gzip -dc "$out" | psql -qX --set ON_ERROR_STOP=on "$target" >/dev/null 2>&1; then
        r_creds=$(count "$target" baileys_creds)
        r_keys=$(count "$target" signal_keys)
        r_sessions=$(count "$target" whatsapp_sessions)
        if [ "$r_creds" = "$src_creds" ] && [ "$r_keys" = "$src_keys" ] && [ "$r_sessions" = "$src_sessions" ]; then
          restore_ok=true
          echo "[backup] restore verified: creds=$r_creds keys=$r_keys sessions=$r_sessions"
        else
          restore_ok=false
          err="row mismatch src($src_creds/$src_keys/$src_sessions) restored($r_creds/$r_keys/$r_sessions)"
          echo "[backup] RESTORE MISMATCH: $err" >&2
        fi
      else
        restore_ok=false
        err="restore failed to apply"
        echo "[backup] restore FAILED to apply" >&2
      fi
      # Guard the drop: only ever a database we just created under this prefix.
      case "$scratch" in
        wapi_verify_*) psql -qX "$admin" -c "DROP DATABASE IF EXISTS \"$scratch\"" >/dev/null 2>&1 || true ;;
      esac
    else
      restore_ok=false
      err="could not create scratch database"
      echo "[backup] could not create scratch database" >&2
    fi
  fi

  if [ -n "${BACKUP_S3_BUCKET:-}" ] && command -v aws >/dev/null 2>&1; then
    aws s3 cp "$out" "s3://$BACKUP_S3_BUCKET/$(basename "$out")" && echo "[backup] shipped off-host"
  fi

  record true "$(basename "$out")" "$bytes" "$restore_ok" "$src_creds" "$src_keys" "$src_sessions" "$err"
  echo "[backup] ok $out ($bytes bytes)"

  ls -1t "$DIR"/wapi-*.sql.gz 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
    echo "[backup] pruning $(basename "$old")"
    rm -f "$old"
  done
}

if [ "${BACKUP_ONCE:-}" = "1" ]; then
  dump_once
  exit $?
fi

# Heartbeat before anything else can fail.
#
# This container's logs are unreachable from the CLI, so a silent crash is indistinguishable
# from a silent no-op. A startup row makes the difference observable: no row at all means the
# script never ran (mount or entrypoint), a startup row with no completion means the dump path
# failed.
psql -qtAX "$DATABASE_URL" -c   "insert into backup_runs (archive, ok, error) values ('startup', false, 'service started')"   >/dev/null 2>&1 || echo "[backup] WARNING: cannot write backup_runs" >&2

echo "[backup] loop started; every ${INTERVAL}s, keeping $KEEP, verify=$VERIFY"
while true; do
  dump_once || echo "[backup] cycle failed; will retry next interval" >&2
  sleep "$INTERVAL"
done
