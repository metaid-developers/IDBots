#!/usr/bin/env bash
# WS-C — LOCAL simulation of the REQ-C-6 tenant firewall, for drills and
# development machines without a real host. Runs inside a PRIVILEGED Ubuntu
# container (needs NET_ADMIN + ip netns):
#
#   docker run --rm --privileged -v "$PWD":/w -w /w ubuntu:24.04 \
#     bash deploy/hosts/tests/firewall-sim.sh
#
# Topology (Linux network namespaces bridged by br-sim / br-sim2):
#   tenant1 172.30.0.5 ─┐
#   tenant2 172.30.0.6 ─┼─ br-sim 172.30.0.1 (this root ns) ── NAT ── internet
#   cp      172.30.0.2 ─┘
#   ptenant1 172.31.0.5 ─┐  (second stack: production-shaped 172.31/16)
#   pcp      172.31.0.2 ─┴─ br-sim2 172.31.0.1
# FORWARD jumps into DOCKER-USER exactly like a Docker host, then
# deploy/hosts/firewall.sh applies the production rules unchanged (dual-stack
# parallel lists, exactly like the production host's idbots-firewall.service).
set -uo pipefail

export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq iptables iproute2 iputils-ping curl netcat-openbsd >/dev/null

modprobe br_netfilter 2>/dev/null || true
sysctl -w net.bridge.bridge-nf-call-iptables=1 2>/dev/null || true
sysctl -w net.ipv4.ip_forward=1 >/dev/null

# REQ-C-2 fidelity: the tenant namespaces use the public resolvers directly,
# exactly like tenant containers under the shipped daemon.json.
mkdir -p /etc/netns/tenant1 /etc/netns/tenant2 /etc/netns/cp /etc/netns/ptenant1 /etc/netns/pcp
for ns in tenant1 tenant2 cp ptenant1 pcp; do
  printf 'nameserver 223.5.5.5\nnameserver 223.6.6.6\n' > "/etc/netns/$ns/resolv.conf"
done

# --- topology -------------------------------------------------------------------
ip link add br-sim type bridge 2>/dev/null || true
ip addr add 172.30.0.1/16 dev br-sim 2>/dev/null || true
ip link set br-sim up
ip link add br-sim2 type bridge 2>/dev/null || true
ip addr add 172.31.0.1/16 dev br-sim2 2>/dev/null || true
ip link set br-sim2 up

make_ns() { # name bridge gw ip
  local ns="$1" br="$2" gw="$3" ip="$4"
  ip netns del "$ns" 2>/dev/null || true
  ip netns add "$ns"
  ip link add "v-$ns" type veth peer name "p-$ns"
  ip link set "v-$ns" master "$br" up
  ip link set "p-$ns" netns "$ns"
  ip netns exec "$ns" ip addr add "$ip/16" dev "p-$ns"
  ip netns exec "$ns" ip link set "p-$ns" up
  ip netns exec "$ns" ip link set lo up
  ip netns exec "$ns" ip route add default via "$gw"
}
make_ns tenant1  br-sim  172.30.0.1 172.30.0.5
make_ns tenant2  br-sim  172.30.0.1 172.30.0.6
make_ns cp       br-sim  172.30.0.1 172.30.0.2
make_ns ptenant1 br-sim2 172.31.0.1 172.31.0.5
make_ns pcp      br-sim2 172.31.0.1 172.31.0.2

# Sim-only: NAT so tenant outbound can reach the real internet.
for subnet in 172.30.0.0/16 172.31.0.0/16; do
  iptables -t nat -C POSTROUTING -s "$subnet" -o eth0 -j MASQUERADE 2>/dev/null \
    || iptables -t nat -A POSTROUTING -s "$subnet" -o eth0 -j MASQUERADE
done

# DOCKER-USER exists on real Docker hosts; create it here and hook FORWARD.
iptables -N DOCKER-USER 2>/dev/null || true
iptables -C FORWARD -j DOCKER-USER 2>/dev/null || iptables -I FORWARD 1 -j DOCKER-USER

# Apply the PRODUCTION script unchanged (dual-stack parallel lists, exactly
# like the production host runs it via idbots-firewall.service).
IDBOTS_TENANT_SUBNET="172.30.0.0/16 172.31.0.0/16" \
IDBOTS_CP_IP="172.30.0.2 172.31.0.2" \
  bash "$(dirname "$0")/../firewall.sh"

PASS=0; FAIL=0
verdict() { # name expected(ok|blocked) actual_rc(0=connected)
  local good
  if [ "$2" = ok ]; then good=$([ "$3" = 0 ] && echo yes || echo no);
  else good=$([ "$3" != 0 ] && echo yes || echo no); fi
  if [ "$good" = yes ]; then PASS=$((PASS+1)); echo "PASS  $1 (expected $2)";
  else FAIL=$((FAIL+1)); echo "FAIL  $1 (expected $2, rc=$3)"; fi
}

# listeners
ip netns exec tenant1  sh -c 'while true; do printf ok | nc -l -p 8790; done' &
ip netns exec cp       sh -c 'while true; do printf ok | nc -l -p 8080; done' &
ip netns exec ptenant1 sh -c 'while true; do printf ok | nc -l -p 8790; done' &
ip netns exec pcp      sh -c 'while true; do printf ok | nc -l -p 8080; done' &
sleep 1

t1() { ip netns exec tenant1 "$@"; }
t_cp() { ip netns exec cp "$@"; }
pt1() { ip netns exec ptenant1 "$@"; }
p_cp() { ip netns exec pcp "$@"; }

t1 nc -w 3 172.30.0.2 8080 < /dev/null >/dev/null 2>&1;        verdict "tenant1 -> control-plane:8080" blocked $?
t1 nc -w 3 172.30.0.6 8790 < /dev/null >/dev/null 2>&1;        verdict "tenant1 -> tenant2:8790" blocked $?
t1 nc -w 3 100.100.100.200 80 < /dev/null >/dev/null 2>&1;     verdict "tenant1 -> metadata 100.100.100.200" blocked $?
t1 nc -w 3 10.0.0.1 22 < /dev/null >/dev/null 2>&1;            verdict "tenant1 -> private 10.0.0.1" blocked $?
t1 nc -w 3 169.254.169.254 80 < /dev/null >/dev/null 2>&1;     verdict "tenant1 -> link-local" blocked $?
t1 nc -w 3 172.30.0.1 8790 < /dev/null >/dev/null 2>&1;        verdict "tenant1 -> host gw 172.30.0.1" blocked $?
t_cp nc -w 3 172.30.0.5 8790 < /dev/null >/dev/null 2>&1;      verdict "control-plane -> tenant1:8790" ok $?
t1 getent hosts api.deepseek.com >/dev/null 2>&1
verdict "tenant1 -> DNS resolve via 223.5.5.5" ok $?
t1 nc -w 5 223.5.5.5 53 < /dev/null >/dev/null 2>&1;           verdict "tenant1 -> TCP 53 to 223.5.5.5" ok $?
t1 nc -w 8 api.deepseek.com 443 < /dev/null >/dev/null 2>&1;   verdict "tenant1 -> api.deepseek.com:443" ok $?
t1 nc -w 8 www.metaso.network 443 < /dev/null >/dev/null 2>&1; verdict "tenant1 -> www.metaso.network:443" ok $?
t1 curl -m 10 -fsSI https://example.com >/dev/null 2>&1;       verdict "tenant1 -> full HTTPS GET example.com" ok $?

# --- second stack (production-shaped 172.31/16) --------------------------------
pt1 nc -w 3 172.31.0.2 8080 < /dev/null >/dev/null 2>&1;       verdict "ptenant1 -> prod control-plane:8080" blocked $?
pt1 nc -w 3 172.31.0.1 8790 < /dev/null >/dev/null 2>&1;       verdict "ptenant1 -> host gw 172.31.0.1" blocked $?
p_cp nc -w 3 172.31.0.5 8790 < /dev/null >/dev/null 2>&1;      verdict "prod control-plane -> ptenant1:8790" ok $?
pt1 nc -w 8 www.metaso.network 443 < /dev/null >/dev/null 2>&1; verdict "ptenant1 -> www.metaso.network:443" ok $?
pt1 nc -w 3 172.30.0.5 8790 < /dev/null >/dev/null 2>&1;       verdict "ptenant1 -> staging tenant1:8790 (cross-stack)" blocked $?
t1 nc -w 3 172.31.0.5 8790 < /dev/null >/dev/null 2>&1;        verdict "tenant1 -> ptenant1:8790 (cross-stack)" blocked $?
t1 nc -w 3 172.31.0.2 8080 < /dev/null >/dev/null 2>&1;        verdict "tenant1 -> prod control-plane:8080 (cross-stack)" blocked $?
p_cp nc -w 3 172.30.0.5 8790 < /dev/null >/dev/null 2>&1;      verdict "prod control-plane -> staging tenant1:8790 (cross-stack)" blocked $?

echo "== sim result: $PASS passed, $FAIL failed =="
exit $([ "$FAIL" = 0 ] && echo 0 || echo 1)
