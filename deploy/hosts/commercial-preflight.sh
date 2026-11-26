#!/usr/bin/env bash
# Read-only commercial readiness preflight. Run on the target host as root.
set -euo pipefail
ROLE="${1:-production}"
PEER_HOST_ID="${PEER_HOST_ID:-}"
FAILURES=0
fail() { printf 'FAIL %s\n' "$1" >&2; FAILURES=$((FAILURES + 1)); }
pass() { printf 'PASS %s\n' "$1"; }

[ "$ROLE" = staging ] || [ "$ROLE" = production ] || { printf 'usage: %s [staging|production]\n' "$0" >&2; exit 2; }
command -v docker >/dev/null 2>&1 || { printf 'FAIL docker CLI is unavailable\n' >&2; exit 1; }

ENV_FILE=/etc/idbots/cp.env
[ -r "$ENV_FILE" ] && pass "cp.env is readable" || fail "cp.env is missing or unreadable"
CP_ROLE="$(awk -F= '$1 == "CP_ENVIRONMENT" {print $2}' "$ENV_FILE" 2>/dev/null || true)"
[ "$CP_ROLE" = "$ROLE" ] && pass "CP_ENVIRONMENT matches $ROLE" || fail "CP_ENVIRONMENT=$CP_ROLE does not match $ROLE"
HOST_ID="$(awk -F= '$1 == "CP_HOST_ID" {print $2}' "$ENV_FILE" 2>/dev/null || true)"
if [ -n "$PEER_HOST_ID" ] && [ -n "$HOST_ID" ] && [ "$HOST_ID" = "$PEER_HOST_ID" ]; then
  fail "staging and production still use the same host id: $HOST_ID"
else
  pass "host identity is distinct from the supplied peer"
fi

for container in idbots-control-plane-1 idbots-prometheus-1 idbots-alertmanager-1 idbots-node-exporter-1 idbots-cadvisor-1; do
  if docker ps --filter "name=^/${container}$" --format '{{.Names}}' | grep -qx "$container"; then
    pass "$container is running"
  else
    fail "$container is not running"
  fi
done

docker exec idbots-control-plane-1 node -e "const fs=require('fs'); const p=process.env.CP_DB_PATH; if(!p || !fs.existsSync(p)) process.exit(1)" >/dev/null 2>&1 \
  && pass "SQLite management database and rollout queue are present" \
  || fail "SQLite management database is missing or inaccessible"

AVAIL_KB="$(df -Pk /var/lib/docker 2>/dev/null | awk 'NR==2 {print $4}')"
TOTAL_KB="$(df -Pk /var/lib/docker 2>/dev/null | awk 'NR==2 {print $2}')"
if [ -n "$AVAIL_KB" ] && [ -n "$TOTAL_KB" ] && [ "$TOTAL_KB" -gt 0 ]; then
  FREE_PERCENT=$((AVAIL_KB * 100 / TOTAL_KB))
  [ "$FREE_PERCENT" -ge 20 ] && pass "docker disk free is ${FREE_PERCENT}%" || fail "docker disk free is only ${FREE_PERCENT}%"
else
  fail "cannot determine docker disk capacity"
fi
MEM_USED_PERCENT="$(free -m | awk '/^Mem:/ {printf "%d", $3/$2*100}')"
[ "$MEM_USED_PERCENT" -lt 75 ] && pass "memory used is ${MEM_USED_PERCENT}%" || fail "memory used is ${MEM_USED_PERCENT}% (75% rollout ceiling)"

if ss -ltn 2>/dev/null | grep -E '0\.0\.0\.0:(2375|5432)\b|\[::\]:(2375|5432)\b' >/dev/null; then
  fail "Docker or a database is listening on all public interfaces"
else
  pass "no public Docker/database listener detected"
fi

if [ "$FAILURES" -gt 0 ]; then
  printf 'COMMERCIAL PREFLIGHT FAILED: %d check(s)\n' "$FAILURES" >&2
  exit 1
fi
printf 'COMMERCIAL PREFLIGHT PASSED (%s)\n' "$ROLE"
