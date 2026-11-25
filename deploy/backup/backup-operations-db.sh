#!/usr/bin/env bash
# Nightly PostgreSQL rollout-queue backup (pg_dump custom format, zstd | age).
# Optional when the operations-db container is absent; REQUIRED=1 makes absence fatal.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

check_common_deps
CONTAINER="${OPERATIONS_DB_CONTAINER_NAME:-idbots-operations-db-1}"
REQUIRED="${OPERATIONS_DB_REQUIRED:-0}"
if ! have_docker || ! docker ps --filter "name=^/${CONTAINER}$" --format '{{.Names}}' | grep -qx "$CONTAINER"; then
  if [ "$REQUIRED" = 1 ]; then
    die "required operations database container $CONTAINER is not running"
  fi
  info "operations database not present; skipping PostgreSQL backup"
  exit 0
fi

DATE="$(date +%F)"
KEY="operations-db/$DATE.pgdump.zst.enc"
START_TS="$(date +%s)"
DB_NAME="${OPERATIONS_DB_NAME:-idbots_operations}"
DB_USER="${OPERATIONS_DB_USER:-idbots}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
info "backing up PostgreSQL rollout queue -> $KEY [backend=$BACKUP_BACKEND]"
docker exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB_NAME" --format=custom --file="/tmp/$DATE.pgdump"
docker cp "$CONTAINER:/tmp/$DATE.pgdump" "$WORK/payload.pgdump"
docker exec "$CONTAINER" rm -f "/tmp/$DATE.pgdump"
mkdir -p "$WORK/payload"
mv "$WORK/payload.pgdump" "$WORK/payload/operations.pgdump"
make_archive "$WORK/payload" "$WORK/archive.pgdump.zst.enc"
SIZE="$(stat -f%z "$WORK/archive.pgdump.zst.enc" 2>/dev/null || stat -c%s "$WORK/archive.pgdump.zst.enc")"
oss_upload "$WORK/archive.pgdump.zst.enc" "$KEY"
oss_object_exists "$KEY" || die "upload verification failed for $KEY"
DURATION=$(( $(date +%s) - START_TS ))
write_metric operations-db "" 1 "$DURATION" "$SIZE"
info "done: $KEY (${SIZE} bytes, ${DURATION}s)"
