#!/usr/bin/env bash
# WS-C REQ-C-14 — nightly backup driver (03:00-05:00 Asia/Shanghai window,
# staggered). Run by idbots-backup.timer, or manually with --now.
#
#   backup-nightly.sh [--now] [--tenant t_x ...]
#
# Order: control-plane SQLite first, then every running tenant container
# (idb-t_*), evenly staggered across the remaining window. Any failure alerts;
# the exit code is non-zero if anything failed.
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib.sh"

NOW=0
TENANTS_ARG=()
while [ $# -gt 0 ]; do
  case "$1" in
    --now) NOW=1; shift ;;
    --tenant) TENANTS_ARG+=("${2:?}"); shift 2 ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

check_common_deps

# Single-flight: a stale previous run must not overlap.
LOCK=/tmp/idbots-backup.lock
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCK"
  flock -n 9 || die "another backup run holds $LOCK"
else
  # flock is Linux-only; mkdir is the portable atomic fallback (drill laptops).
  LOCKD="$LOCK.d"
  mkdir "$LOCKD" 2>/dev/null || die "another backup run holds $LOCKD"
  trap 'rmdir "$LOCKD" 2>/dev/null || true' EXIT
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FAILED=()

# --- 1. control-plane database ------------------------------------------------------
if "$HERE/backup-control-plane.sh"; then
  info "control-plane backup OK"
else
  err "control-plane backup FAILED"
  FAILED+=("control-plane")
fi

# --- 2. tenants ------------------------------------------------------------------------
if [ "${#TENANTS_ARG[@]}" -gt 0 ]; then
  TENANTS=("${TENANTS_ARG[@]}")
else
  TENANTS=()
  if have_docker; then
    while IFS= read -r name; do
      TENANTS+=("${name#idb-}")
    done < <(docker ps --filter "name=^/idb-t_" --format '{{.Names}}' | sort)
  fi
fi
info "tenants to back up: ${#TENANTS[@]}"

# Stagger across the 2-hour window, capped; --now compresses the spacing.
WINDOW_SECONDS=6900  # 03:00 -> 04:55, leaving slack before 05:00
if [ "${#TENANTS[@]}" -gt 1 ]; then
  STAGGER=$(( WINDOW_SECONDS / ${#TENANTS[@]} ))
  [ "$STAGGER" -gt "$BACKUP_STAGGER_MAX_SECONDS" ] && STAGGER="$BACKUP_STAGGER_MAX_SECONDS"
else
  STAGGER=0
fi
[ "$NOW" = 1 ] && STAGGER=0

i=0
for tenant in "${TENANTS[@]}"; do
  i=$((i + 1))
  if [ "$i" -gt 1 ] && [ "$STAGGER" -gt 0 ]; then
    info "stagger: sleeping ${STAGGER}s before tenant $i/${#TENANTS[@]}"
    sleep "$STAGGER"
  fi
  if "$HERE/backup-tenant.sh" "$tenant"; then
    info "tenant $tenant backup OK ($i/${#TENANTS[@]})"
  else
    err "tenant $tenant backup FAILED ($i/${#TENANTS[@]})"
    FAILED+=("$tenant")
  fi
done

# --- 3. summary ---------------------------------------------------------------------------
if [ "${#FAILED[@]}" -gt 0 ]; then
  alert backup "NIGHTLY BACKUP FAILED for: ${FAILED[*]} (host $(hostname), $(date '+%F %T %Z'))"
  err "failed: ${FAILED[*]}"
  exit 1
fi
info "nightly backup complete: control-plane SQLite + ${#TENANTS[@]} tenant(s), 0 failures"
