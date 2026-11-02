#!/usr/bin/env bash
# WS-C REQ-C-6 — tenant network isolation rules for the DOCKER-USER chain.
#
# Design: all rules live in a dedicated IDBOTS-TENANT chain jumped to from the
# top of DOCKER-USER, so re-running this script is idempotent and never
# clobbers unrelated rules an operator may have added to DOCKER-USER.
#
# Traffic inside a bridge network only reaches DOCKER-USER while
# net.bridge.bridge-nf-call-iptables=1 (bootstrap.sh installs
# /etc/sysctl.d/90-idbots.conf); this script warns when it is off.
#
# Installed to /opt/idbots/firewall.sh and re-applied after every Docker start
# by idbots-firewall.service.
set -euo pipefail

CHAIN="IDBOTS-TENANT"
# One or more tenant stacks, space-separated PARALLEL lists: subnet i belongs
# to control-plane IP i (dual-stack hosts run staging 172.30/16 + production
# 172.31/16 side by side on one Docker daemon). Single values keep the
# historical single-stack behavior.
read -ra SUBNETS <<<"${IDBOTS_TENANT_SUBNET:-172.30.0.0/16}"
read -ra CP_IPS <<<"${IDBOTS_CP_IP:-172.30.0.2}"
if [ "${#SUBNETS[@]}" -ne "${#CP_IPS[@]}" ]; then
  log "ERROR: IDBOTS_TENANT_SUBNET (${#SUBNETS[@]} entries) and IDBOTS_CP_IP" \
    "(${#CP_IPS[@]} entries) must list the same number of space-separated stacks"
  exit 1
fi
TENANT_GATEWAY_PORT="${IDBOTS_TENANT_PORT:-8790}"
# REQ-C-2 resolvers (must match /etc/docker/daemon.json).
DNS_SERVERS="${IDBOTS_DNS_SERVERS:-223.5.5.5 223.6.6.6}"

IPT="${IDBOTS_IPTABLES_BIN:-iptables}"

log() { echo "[idbots-firewall] $*"; }
log "cwd: $(pwd) script: $(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$(cat /proc/sys/net/bridge/bridge-nf-call-iptables 2>/dev/null || echo 0)" != "1" ]; then
  log "WARNING: net.bridge.bridge-nf-call-iptables is not 1 — bridged tenant traffic"
  log "         will bypass these rules. Run: sysctl --system  (see 90-idbots.conf)"
fi

# --- create / reset our chain -------------------------------------------------
$IPT -N "$CHAIN" 2>/dev/null || true
$IPT -F "$CHAIN"

# Detach old jump(s) from DOCKER-USER, then re-attach once at the top.
while $IPT -C DOCKER-USER -j "$CHAIN" 2>/dev/null; do
  $IPT -D DOCKER-USER -j "$CHAIN"
done
$IPT -I DOCKER-USER 1 -j "$CHAIN"

# 1. Accept established and related traffic (stack-independent).
$IPT -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# --- REQ-C-6 rules, in the specified order, once per stack ---------------------
# Cross-stack isolation needs no extra rules: every stack's private-range drop
# (172.16.0.0/12) covers the OTHER stack's subnet as a destination, so a tenant
# or control plane of stack A cannot open new connections into stack B.

for i in "${!SUBNETS[@]}"; do
  TENANT_SUBNET="${SUBNETS[$i]}"
  CP_IP="${CP_IPS[$i]}"

  # 2. Accept new connections from the control plane's fixed IP to the tenant
  #    subnet on the tenant gateway port.
  $IPT -A "$CHAIN" -s "$CP_IP" -d "$TENANT_SUBNET" -p tcp --dport "$TENANT_GATEWAY_PORT" \
    -m conntrack --ctstate NEW -j ACCEPT

  # 3. Drop new connections between any two addresses in the tenant subnet
  #    (tenant -> tenant, tenant -> control plane).
  $IPT -A "$CHAIN" -s "$TENANT_SUBNET" -d "$TENANT_SUBNET" \
    -m conntrack --ctstate NEW -j DROP

  # 4. Accept DNS (UDP and TCP 53) from the tenant subnet to the configured
  #    resolvers.
  for dns in $DNS_SERVERS; do
    $IPT -A "$CHAIN" -s "$TENANT_SUBNET" -d "$dns" -p udp --dport 53 -j ACCEPT
    $IPT -A "$CHAIN" -s "$TENANT_SUBNET" -d "$dns" -p tcp --dport 53 -j ACCEPT
  done

  # 5. Drop tenant traffic to cloud metadata, link-local, private ranges, CGNAT,
  #    and the host's own addresses (the host is a tenant's default gateway on
  #    every docker bridge, so it is reachable unless blocked explicitly).
  for dst in \
    "100.100.100.200/32" \
    "169.254.0.0/16" \
    "10.0.0.0/8" \
    "172.16.0.0/12" \
    "192.168.0.0/16" \
    "100.64.0.0/10"; do
    $IPT -A "$CHAIN" -s "$TENANT_SUBNET" -d "$dst" -j DROP
  done

  # Host's own IPv4 addresses (primary NIC, docker bridges, ...).
  if command -v ip >/dev/null 2>&1; then
    ip -4 -o addr show scope global | awk '{print $4}' | while read -r cidr; do
      $IPT -A "$CHAIN" -s "$TENANT_SUBNET" -d "${cidr%/*}/32" -j DROP
    done
  fi

  # 6. Accept everything else from the tenant subnet (outbound internet).
  $IPT -A "$CHAIN" -s "$TENANT_SUBNET" -j ACCEPT

  log "stack applied: subnet=$TENANT_SUBNET cp=$CP_IP port=$TENANT_GATEWAY_PORT dns=[$DNS_SERVERS]"
done

# Non-tenant traffic falls through to whatever follows DOCKER-USER.
$IPT -A "$CHAIN" -j RETURN
