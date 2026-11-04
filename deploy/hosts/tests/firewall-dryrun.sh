#!/usr/bin/env bash
# WS-C — Docker-free dry-run check for firewall.sh: runs the production script
# with a recording iptables stub (IDBOTS_IPTABLES_BIN) and a stub `ip`, then
# asserts the emitted rule SEQUENCE for single- and dual-stack configurations.
# Complements tests/firewall-sim.sh (which needs a privileged Docker host);
# run both when touching firewall.sh:
#
#   bash deploy/hosts/tests/firewall-dryrun.sh
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIREWALL="$HERE/../firewall.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Stub iptables: -C exits 1 ("no such rule") so the DOCKER-USER detach loop is a
# single pass; every other invocation is recorded and succeeds.
cat >"$WORK/ipt-stub" <<'EOF'
#!/usr/bin/env bash
if [ "${1:-}" = "-C" ]; then exit 1; fi
echo "$*" >>"${IPT_LOG:?}"
exit 0
EOF
chmod +x "$WORK/ipt-stub"

# Stub ip: one global host address so the host-drop leg is emitted per stack.
mkdir -p "$WORK/bin"
cat >"$WORK/bin/ip" <<'EOF'
#!/usr/bin/env bash
echo "2: eth0    inet 203.0.113.10/24 scope global eth0\\       valid_lft forever preferred_lft forever"
EOF
chmod +x "$WORK/bin/ip"

PASS=0; FAIL=0
check() { # name condition-result(0=ok)
  if [ "$2" = 0 ]; then PASS=$((PASS+1)); echo "PASS  $1";
  else FAIL=$((FAIL+1)); echo "FAIL  $1"; fi
}

run_firewall() { # env... -> rules on stdout via $WORK/rules
  rm -f "$WORK/rules"
  IPT_LOG="$WORK/rules" PATH="$WORK/bin:$PATH" \
    IDBOTS_IPTABLES_BIN="$WORK/ipt-stub" bash "$FIREWALL" >"$WORK/stdout" 2>&1
}

# --- 1. single stack (defaults): historical rule set unchanged -----------------
run_firewall
rc=$?
check "single-stack: script exits 0" $([ $rc = 0 ] && echo 0 || echo 1)
grep -qxe '-A IDBOTS-TENANT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT' "$WORK/rules"
check "single-stack: rule 1 established-accept present" $?
[ "$(grep -c '^-A IDBOTS-TENANT -s 172.30.0.2 -d 172.30.0.0/16' "$WORK/rules")" = 1 ]
check "single-stack: exactly one cp->tenant accept" $?
[ "$(grep -c ' 172.16.0.0/12 ' "$WORK/rules")" = 1 ]
check "single-stack: one private-range 172.16/12 drop" $?
[ "$(tail -1 "$WORK/rules")" = '-A IDBOTS-TENANT -j RETURN' ]
check "single-stack: RETURN is the final rule" $?

# --- 2. dual stack: per-stack blocks, staging rules first, one RETURN ----------
run_firewall_env() { :; }
rm -f "$WORK/rules"
IPT_LOG="$WORK/rules" PATH="$WORK/bin:$PATH" \
  IDBOTS_IPTABLES_BIN="$WORK/ipt-stub" \
  IDBOTS_TENANT_SUBNET="172.30.0.0/16 172.31.0.0/16" \
  IDBOTS_CP_IP="172.30.0.2 172.31.0.2" \
  bash "$FIREWALL" >"$WORK/stdout" 2>&1
rc=$?
check "dual-stack: script exits 0" $([ $rc = 0 ] && echo 0 || echo 1)
[ "$(grep -c '^-A IDBOTS-TENANT -s 172.31.0.2 -d 172.31.0.0/16 -p tcp --dport 8790 -m conntrack --ctstate NEW -j ACCEPT' "$WORK/rules")" = 1 ]
check "dual-stack: prod cp->prod tenant accept present" $?
[ "$(grep -c '^-A IDBOTS-TENANT -s 172.30.0.0/16 -d 172.30.0.0/16 -m conntrack --ctstate NEW -j DROP' "$WORK/rules")" = 1 ] && \
[ "$(grep -c '^-A IDBOTS-TENANT -s 172.31.0.0/16 -d 172.31.0.0/16 -m conntrack --ctstate NEW -j DROP' "$WORK/rules")" = 1 ]
check "dual-stack: intra-subnet drop per stack" $?
# cross-stack isolation: each stack's 172.16/12 drop covers the other subnet
[ "$(grep -c '^-A IDBOTS-TENANT -s 172.30.0.0/16 -d 172.16.0.0/12 -j DROP' "$WORK/rules")" = 1 ] && \
[ "$(grep -c '^-A IDBOTS-TENANT -s 172.31.0.0/16 -d 172.16.0.0/12 -j DROP' "$WORK/rules")" = 1 ]
check "dual-stack: private-range drop per stack (covers cross-stack)" $?
[ "$(grep -c '^-A IDBOTS-TENANT -s 172.30.0.0/16 -j ACCEPT' "$WORK/rules")" = 1 ] && \
[ "$(grep -c '^-A IDBOTS-TENANT -s 172.31.0.0/16 -j ACCEPT' "$WORK/rules")" = 1 ]
check "dual-stack: outbound accept per stack" $?
[ "$(grep -c ' -j RETURN$' "$WORK/rules")" = 1 ]
check "dual-stack: exactly one RETURN at the end" $?
s1=$(grep -n ' 172.30.0.0/16 ' "$WORK/rules" | head -1 | cut -d: -f1)
s2=$(grep -n ' 172.31.0.0/16 ' "$WORK/rules" | head -1 | cut -d: -f1)
[ -n "$s1" ] && [ -n "$s2" ] && [ "$s1" -lt "$s2" ]
check "dual-stack: staging rules emitted before prod rules" $?
grep -q 'stack applied: subnet=172.30.0.0/16 cp=172.30.0.2' "$WORK/stdout" && \
grep -q 'stack applied: subnet=172.31.0.0/16 cp=172.31.0.2' "$WORK/stdout"
check "dual-stack: per-stack log lines present" $?

# --- 3. mismatched parallel lists refuse to run --------------------------------
rm -f "$WORK/rules"
IPT_LOG="$WORK/rules" PATH="$WORK/bin:$PATH" \
  IDBOTS_IPTABLES_BIN="$WORK/ipt-stub" \
  IDBOTS_TENANT_SUBNET="172.30.0.0/16 172.31.0.0/16" \
  IDBOTS_CP_IP="172.30.0.2" \
  bash "$FIREWALL" >"$WORK/stdout" 2>&1
rc=$?
check "mismatch: exits non-zero" $([ $rc != 0 ] && echo 0 || echo 1)
grep -q 'ERROR: IDBOTS_TENANT_SUBNET' "$WORK/stdout"
check "mismatch: names the two env lists in the error" $?
[ ! -s "$WORK/rules" ]
check "mismatch: no rules emitted" $?

echo "== dry-run result: $PASS passed, $FAIL failed =="
exit $([ "$FAIL" = 0 ] && echo 0 || echo 1)
