#!/usr/bin/env bash
# CR-WSA-006 pilot — zram compressed swap for the tenant host.
#
# Tenant containers are long-lived and mostly idle. Each one holds roughly
# 235 MiB of anonymous memory that is cold but can never be reclaimed without
# swap, so under memory pressure the kernel can only drop page-cache pages
# (the 2026-11-27 livelock: constant 233 MB/s file reads, zero writes). This
# script creates one zram device so cold anonymous pages are compressed into
# RAM instead. The disk is never touched.
#
# Installed to /opt/idbots/zram-swap.sh and started by
# idbots-zram-swap.service. Idempotent: `start` is a no-op while the device is
# active.
#
# Rollback under memory pressure: do NOT call `stop` (swapoff pulls every
# swapped page back into RAM). Run `systemctl disable idbots-zram-swap` and let
# the next reboot remove it, or stop it once MemAvailable is comfortable.
set -euo pipefail

DEVICE="${IDBOTS_ZRAM_DEVICE:-/dev/zram0}"
SIZE="${IDBOTS_ZRAM_SIZE:-6G}"
ALGORITHM="${IDBOTS_ZRAM_ALGORITHM:-zstd}"
PRIORITY="${IDBOTS_ZRAM_PRIORITY:-100}"

log() { printf '[zram-swap] %s\n' "$*"; }

is_active() {
  swapon --show=NAME --noheadings | grep -qx "$DEVICE"
}

start() {
  modprobe zram
  if is_active; then
    log "$DEVICE already active"
    zramctl "$DEVICE" --output NAME,ALGORITHM,DISKSIZE,DATA,COMPR,TOTAL
    return 0
  fi
  [ -b "$DEVICE" ] || { echo "[zram-swap] $DEVICE missing after modprobe" >&2; exit 1; }
  # A device left over from an earlier run keeps its size and algorithm otherwise.
  zramctl --reset "$DEVICE" 2>/dev/null || true
  zramctl "$DEVICE" --algorithm "$ALGORITHM" --size "$SIZE"
  mkswap "$DEVICE" >/dev/null
  swapon --priority "$PRIORITY" "$DEVICE"
  log "enabled"
  zramctl "$DEVICE" --output NAME,ALGORITHM,DISKSIZE,DATA,COMPR,TOTAL
}

stop() {
  if is_active; then
    swapoff "$DEVICE"
  fi
  zramctl --reset "$DEVICE" 2>/dev/null || true
  log "disabled"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac
