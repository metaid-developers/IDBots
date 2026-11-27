#!/usr/bin/env bash
# WS-C — one-command bootstrap for a fresh IDBots relay host (REQ-C-1..C-7).
#
#   sudo deploy/hosts/bootstrap.sh [--role staging|production] [--skip-ssh-hardening]
#
# Target OS: Ubuntu 24.04 LTS (Phase 0 system; Alibaba Cloud Linux 3 works with
# minor differences — see runbooks/host-bootstrap.md). Idempotent: safe to
# re-run; it never overwrites a filled /etc/idbots/*.env file.
#
# What it does:
#   1. installs packages (Docker CE + buildx/compose plugins, zstd, sqlite3,
#      age, rsync, jq, fail2ban, auditd, unattended-upgrades, earlyoom)
#   2. installs /etc/docker/daemon.json (REQ-C-2 DNS, C1 log rotation)
#   3. installs sysctl settings (bridge-nf-call-iptables for REQ-C-6)
#   4. installs + enables idbots-firewall.service (REQ-C-6)
#   5. hardens sshd (keys only, no root login) with an authorized_keys guard
#   6. enables fail2ban (sshd), auditd, automatic security updates (REQ-C-3)
#   7. copies deploy assets to /opt/idbots, env examples to /etc/idbots
#      (0600), renders prometheus.yml from deploy.env
#   8. installs the nightly-backup systemd timer (disabled until backup.env)
#   9. installs zram swap + earlyoom (CR-WSA-006): tenant swap is zram-backed,
#      and earlyoom keeps acting on RAM alone (-s 100,100)
#
# It does NOT: create docker networks/containers (compose does that), write any
# secret, or contact any cloud API. After it finishes, follow
# runbooks/host-bootstrap.md § "Bring the stack up".
set -euo pipefail

ROLE="production"
HARDEN_SSH=1
while [ $# -gt 0 ]; do
  case "$1" in
    --role) ROLE="${2:?}"; shift 2 ;;
    --skip-ssh-hardening) HARDEN_SSH=0; shift ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ "$ROLE" = staging ] || [ "$ROLE" = production ] || { echo "--role must be staging or production" >&2; exit 2; }
[ "$(id -u)" = 0 ] || { echo "run as root (sudo $0 ...)" >&2; exit 1; }

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"          # deploy/hosts
DEPLOY_ROOT="$(cd "$SRC/.." && pwd)"                        # deploy/
OPT=/opt/idbots
ETC=/etc/idbots
TEXTFILE_DIR=/var/lib/idbots/node-exporter-textfile

log() { printf '\033[1;34m[bootstrap]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[bootstrap WARNING]\033[0m %s\n' "$*" >&2; }

log "cwd:      $(pwd)"
log "script:   $(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -r /etc/os-release ]; then
  . /etc/os-release
  log "OS: ${PRETTY_NAME:-unknown}"
  case "${ID:-}:${VERSION_ID:-}" in
    ubuntu:24.04) : ;;
    alinux:3*) warn "Alibaba Cloud Linux 3: package names may differ; verified target is Ubuntu 24.04." ;;
    *) warn "Untested OS. Verified target: Ubuntu 24.04 LTS." ;;
  esac
fi
export DEBIAN_FRONTEND=noninteractive

# --- 1. packages ---------------------------------------------------------------
log "installing base packages"
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg zstd sqlite3 age rsync jq \
  fail2ban auditd unattended-upgrades apt-transport-https earlyoom

if ! command -v docker >/dev/null 2>&1; then
  log "installing Docker CE"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io \
    docker-buildx-plugin docker-compose-plugin
else
  log "docker already present: $(docker --version)"
fi

# --- 2. docker daemon config ---------------------------------------------------
install -d -m 0755 /etc/docker
if [ -f /etc/docker/daemon.json ] && ! cmp -s "$SRC/daemon.json" /etc/docker/daemon.json; then
  cp -a /etc/docker/daemon.json "/etc/docker/daemon.json.bak.$(date +%Y%m%d%H%M%S)"
  warn "existing /etc/docker/daemon.json backed up; replaced with the IDBots baseline (REQ-C-2, C1 log opts)"
fi
install -m 0644 "$SRC/daemon.json" /etc/docker/daemon.json

# --- 3. sysctl ------------------------------------------------------------------
install -m 0644 /dev/stdin /etc/sysctl.d/90-idbots.conf <<'EOF'
# REQ-C-6: bridged tenant traffic must traverse iptables (DOCKER-USER).
net.bridge.bridge-nf-call-iptables = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.ipv4.ip_forward = 1
EOF
sysctl --system -q

systemctl enable docker >/dev/null
systemctl restart docker

# --- 4. firewall -----------------------------------------------------------------
install -d -m 0755 "$OPT"
install -m 0755 "$SRC/firewall.sh" "$OPT/firewall.sh"
install -m 0644 "$SRC/idbots-firewall.service" /etc/systemd/system/idbots-firewall.service
systemctl daemon-reload
systemctl enable --now idbots-firewall.service
log "firewall rules applied via idbots-firewall.service"

# --- 5. sshd hardening (REQ-C-3) ---------------------------------------------------
if [ "$HARDEN_SSH" = 1 ]; then
  if ! grep -RqsE '^(ssh-ed25519|ssh-rsa|ecdsa-)' /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys 2>/dev/null; then
    warn "no authorized_keys found for any user — REFUSING to disable password login."
    warn "install your SSH key first, then re-run bootstrap (or rerun with the key in place)."
  else
    install -m 0644 /dev/stdin /etc/ssh/sshd_config.d/60-idbots.conf <<'EOF'
# REQ-C-3: keys only, no root login.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
    if sshd -t; then
      systemctl reload ssh 2>/dev/null || systemctl reload sshd
      log "sshd hardened (PasswordAuthentication no, PermitRootLogin no)"
    else
      rm -f /etc/ssh/sshd_config.d/60-idbots.conf
      warn "sshd -t failed with the drop-in; reverted. Fix sshd config manually."
    fi
  fi
fi

# --- 6. REQ-C-3 services -----------------------------------------------------------
systemctl enable --now fail2ban auditd
install -m 0644 /dev/stdin /etc/apt/apt.conf.d/20auto-upgrades-idbots <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF

# --- 7. deploy assets + env templates ----------------------------------------------
install -d -m 0755 "$OPT/deploy" "$ETC" "$TEXTFILE_DIR"
chmod 0700 "$ETC"
rsync -a --delete "$DEPLOY_ROOT/hosts/" "$OPT/deploy/"
rsync -a "$DEPLOY_ROOT/monitoring/" "$OPT/monitoring/"
rsync -a "$DEPLOY_ROOT/backup/" "$OPT/backup/"
chmod 0755 "$OPT"/backup/*.sh

for f in deploy.env cp.env; do
  if [ ! -f "$ETC/$f" ]; then
    install -m 0600 "$OPT/deploy/$f.example" "$ETC/$f"
    log "created $ETC/$f from example — EDIT IT before bringing the stack up"
  else
    log "$ETC/$f exists — left untouched"
  fi
done
if [ ! -f "$ETC/backup.env" ]; then
  install -m 0600 "$OPT/backup/backup.env.example" "$ETC/backup.env"
fi
if [ ! -f "$ETC/monitoring.env" ]; then
  install -m 0600 "$OPT/monitoring/monitoring.env.example" "$ETC/monitoring.env"
fi

# Render prometheus.yml from deploy.env (APP_HOST, ENV_ROLE).
if grep -q 'example.com' "$ETC/deploy.env" 2>/dev/null; then
  warn "$ETC/deploy.env still holds placeholder APP_HOST — prometheus.yml NOT rendered yet."
  warn "Fill deploy.env, then re-run bootstrap (idempotent) or run: $OPT/deploy/render-prometheus.sh"
else
  set -a; . "$ETC/deploy.env"; set +a
  sed -e "s|__APP_HOST__|${APP_HOST}|g" -e "s|__ENV_ROLE__|${ROLE}|g" \
    "$OPT/monitoring/prometheus.yml.template" > "$OPT/deploy/prometheus.yml"
  log "rendered $OPT/deploy/prometheus.yml for ${APP_HOST} (${ROLE})"
fi

# --- 8. nightly backup timer ----------------------------------------------------------
install -m 0644 "$DEPLOY_ROOT/backup/idbots-backup.service" /etc/systemd/system/idbots-backup.service
install -m 0644 "$DEPLOY_ROOT/backup/idbots-backup.timer" /etc/systemd/system/idbots-backup.timer
systemctl daemon-reload
if grep -q 'REPLACE_ME' "$ETC/backup.env" 2>/dev/null; then
  warn "backup.env not configured — idbots-backup.timer installed but NOT enabled."
  warn "Fill /etc/idbots/backup.env, then: systemctl enable --now idbots-backup.timer"
else
  systemctl enable --now idbots-backup.timer
  log "idbots-backup.timer enabled (03:00 Asia/Shanghai, staggered)"
fi

# --- 9. zram swap + earlyoom (CR-WSA-006) --------------------------------------------
# An idle tenant holds about 235 MiB of cold anonymous memory. With no swap
# that memory can never be reclaimed, and a full host can only thrash page
# cache (2026-11-27 livelock). zram gives it somewhere to compress into;
# earlyoom keeps a lid on RAM with its swap tests disabled.
install -m 0755 "$SRC/zram-swap.sh" "$OPT/zram-swap.sh"
install -m 0644 "$SRC/idbots-zram-swap.service" /etc/systemd/system/idbots-zram-swap.service
install -m 0644 "$SRC/sysctl.d/99-idbots-zram.conf" /etc/sysctl.d/99-idbots-zram.conf
if [ -f /etc/default/earlyoom ] && ! cmp -s "$SRC/earlyoom.default" /etc/default/earlyoom; then
  cp -a /etc/default/earlyoom "/etc/default/earlyoom.bak.$(date +%Y%m%d%H%M%S)"
  warn "existing /etc/default/earlyoom backed up; replaced with the IDBots baseline (-m 8,6 -s 100,100)"
fi
install -m 0644 "$SRC/earlyoom.default" /etc/default/earlyoom
install -d -m 0755 /etc/systemd/system/earlyoom.service.d
install -m 0644 "$SRC/earlyoom-priority.conf" /etc/systemd/system/earlyoom.service.d/10-idbots-priority.conf
systemctl daemon-reload
systemctl enable --now earlyoom
systemctl restart earlyoom
systemctl enable --now idbots-zram-swap.service
# Only the two zram keys. `sysctl --system` would also replay every other file
# over anything an operator tuned by hand since boot.
sysctl -q -p /etc/sysctl.d/99-idbots-zram.conf
log "zram swap + earlyoom enabled: $(swapon --show=NAME,SIZE,USED --noheadings | tr -s ' ' | tr '\n' ' ')"
# The file name must keep sorting AFTER the cloud image's 99-apsara-sysctl.conf
# (vm.swappiness = 0); sysctl.d applies files in lexical order.
if [ "$(sysctl -n vm.swappiness)" != "150" ]; then
  warn "vm.swappiness is $(sysctl -n vm.swappiness), expected 150 — a later sysctl.d file overrides 99-idbots-zram.conf"
fi

cat <<EOF

========================================================================
 Bootstrap complete (role: ${ROLE}).

 Next steps (runbooks/host-bootstrap.md § "Bring the stack up"):
   1. Edit   ${ETC}/deploy.env   (APP_HOST, REGISTRY, CP_IMAGE_TAG)
   2. Edit   ${ETC}/cp.env       (ALL placeholders; chmod stays 0600)
   3. Edit   ${ETC}/monitoring.env and ${ETC}/backup.env
   4. Re-run this script to render prometheus.yml + enable the backup timer.
   5. docker login ${REGISTRY:-<registry>} with the ACR PULL RAM credential
   6. cd ${OPT}/deploy && docker compose --env-file ${ETC}/deploy.env \
        -f compose.yml -f compose.monitoring.yml pull
      docker compose --env-file ${ETC}/deploy.env \
        -f compose.yml -f compose.monitoring.yml up -d
   7. Verify per the runbook: TLS, firewall, /health.
========================================================================
EOF
