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
# idbots-zram-swap.service. Idempotent: `start` is a no-op while a zram swap
# device is active.
#
# Rollback under memory pressure: do NOT call `stop` (swapoff pulls every
# swapped page back into RAM). Run `systemctl disable idbots-zram-swap` and let
# the next reboot remove it, or stop it once MemAvailable is comfortable.
set -euo pipefail

SIZE="${IDBOTS_ZRAM_SIZE:-6G}"
ALGORITHM="${IDBOTS_ZRAM_ALGORITHM:-zstd}"
PRIORITY="${IDBOTS_ZRAM_PRIORITY:-100}"

log() { printf '[zram-swap] %s\n' "$*"; }

# zram devices currently in use as swap, one per line.
active_devices() {
  swapon --show=NAME --noheadings | awk '{print $1}' | grep -E '^/dev/zram[0-9]+$' || true
}

start() {
  modprobe zram
  local active
  active="$(active_devices)"
  if [ -n "$active" ]; then
    log "already active: $(echo "$active" | tr '\n' ' ')"
    # shellcheck disable=SC2086  # one device path per word is intended
    zramctl $active --output NAME,ALGORITHM,DISKSIZE,DATA,COMPR,TOTAL
    return 0
  fi
  # --find takes an unused zram device or adds one. Deliberately no pre-reset:
  # on util-linux 2.39 `zramctl --reset` REMOVES a device that was never sized.
  local device
  device="$(zramctl --find --algorithm "$ALGORITHM" --size "$SIZE")"
  mkswap "$device" >/dev/null
  swapon --priority "$PRIORITY" "$device"
  log "enabled"
  zramctl "$device" --output NAME,ALGORITHM,DISKSIZE,DATA,COMPR,TOTAL
}

stop() {
  local device
  for device in $(active_devices); do
    swapoff "$device"
    zramctl --reset "$device" 2>/dev/null || true
  done
  log "disabled"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac
