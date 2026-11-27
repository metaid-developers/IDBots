# Runbook: host bootstrap — fresh ECS to a running edge and control plane

Covers REQ-C-1..C-7. Follow top to bottom; every step has a verification.
Placeholders: `{APP_DOMAIN}` (owner's domain), `{ENV}` = staging|production,
`{REGISTRY}` = `registry.cn-hongkong.aliyuncs.com`, `{HOST_EIP}` = this host's
Elastic IP.

Expected procurement inputs (from `15-ops-procurement.md`, already done by the
owner's team before you start): ECS instance id, EIP, ACR pull RAM credential,
SMS RAM credential, OSS bucket name + OSS write RAM credential, robot webhook
URL, domain DNS zone access.

## 1. Host baseline (console / first SSH)

1. Confirm the instance shape: staging ≈ 4 vCPU / 16 GB, production 8 vCPU /
   32 GB, region `cn-hongkong`, Ubuntu 24.04, encrypted ESSD mounted at
   `/var/lib/docker` (REQ-C-1). If Docker is not yet installed, mount the data
   disk at `/var/lib/docker` BEFORE installing Docker (its data root lives
   there).
2. Security group (REQ-C-3): inbound 80/tcp and 443/tcp from 0.0.0.0/0;
   22/tcp only from the owner's listed IPs; nothing else. Outbound: all.
3. EIP (REQ-C-4): fixed EIP, billed by traffic, peak ≥ 100 Mbps. Record the
   egress IP and send it to WS-D (C4 partner policy) — staging before M2.
4. Set the timezone: `timedatectl set-timezone Asia/Shanghai`.
5. Install your operator SSH key for the sudo user, then verify
   `ssh {user}@{HOST_EIP}` works in a NEW terminal before hardening sshd.

## 2. One-command bootstrap

Copy the repository (or just the `deploy/` directory) to the host, then:

```bash
cd IDBots            # the repo checkout on the host
sudo deploy/hosts/bootstrap.sh --role {ENV}
```

What it does: packages (Docker CE, zstd, sqlite3, age, rsync, jq, fail2ban,
auditd, unattended-upgrades, earlyoom), `/etc/docker/daemon.json` (REQ-C-2 DNS
`223.5.5.5/223.6.6.6`, C1 log rotation), sysctl bridge settings, the
`idbots-firewall.service` tenant isolation (REQ-C-6), sshd hardening
(keys only, no root — skipped with a loud warning if no key exists),
fail2ban/auditd/auto-upgrades (REQ-C-3), assets to `/opt/idbots`, env
templates to `/etc/idbots` (0600), zram swap + earlyoom (CR-WSA-006: tenant
swap is zram-backed, and earlyoom keeps acting on RAM alone). Re-runnable
(idempotent); it never overwrites a filled env file, and an edited
`/etc/docker/daemon.json` or `/etc/default/earlyoom` is backed up before it is
replaced with the baseline.

Verify:

```bash
docker --version                                   # CE 29-ish
cat /etc/docker/daemon.json                        # dns + log opts
sysctl net.bridge.bridge-nf-call-iptables          # = 1
systemctl status idbots-firewall.service           # active
sudo iptables -L DOCKER-USER -n | head             # jump to IDBOTS-TENANT
sudo iptables -L IDBOTS-TENANT -nv                 # the 6 REQ-C-6 rule groups
fail2ban-client status sshd                        # sshd jail enabled
swapon --show                                      # /dev/zram0 — tenant swap (CR-WSA-006)
systemctl is-active idbots-zram-swap earlyoom      # both "active"
sysctl vm.swappiness                               # = 150 (99-idbots-zram.conf)
journalctl -u earlyoom -n 4 | grep swap            # BOTH lines read "swap <= 100.00%"
```

## 3. Fill the secrets files

All files under `/etc/idbots` are created by `bootstrap.sh` (root:root, 0600;
`/etc/idbots` itself is 0700). `deploy.env` holds no secrets (hostnames and
image tags only) but gets the same 0600 treatment — do not loosen it. Re-run
of bootstrap never overwrites a filled file. Each file maps to the secrets
register in `00-program-plan.md`:

| File | Fill | Secret source |
|---|---|---|
| `deploy.env` | `APP_HOST=app.{APP_DOMAIN}` or `staging.{APP_DOMAIN}`, `REGISTRY`, `CP_IMAGE_TAG` | no secrets |
| `cp.env` | every `CP_*` from `cp.env.example` | master key: `openssl rand -base64 32` (offline copy to the owner's password manager); SMS RAM credential; robot webhook |
| `backup.env` | `OSS_BUCKET`, OSS write RAM credential, `BACKUP_AGE_RECIPIENT` | age key pair: `age-keygen -o idbots-backup.key` on YOUR machine; private key offline with the owner |
| `monitoring.env` | `ALERT_WEBHOOK_URL` (+ optional `ALERT_SECRET`) | Feishu/DingTalk group robot |

Then re-run `sudo deploy/hosts/bootstrap.sh --role {ENV}` — it renders
`prometheus.yml` from `deploy.env` and enables `idbots-backup.timer` once
`backup.env` is real.

## 4. Registry login (pull only)

```bash
docker login {REGISTRY} --username {ACR_PULL_RAM_USER}
# password: the ACR pull RAM user's password/token (password manager)
```

The push credential never lands on hosts (CI only) — REQ-C-8.

## 5. Bring the stack up

```bash
cd /opt/idbots/deploy
docker compose --env-file /etc/idbots/deploy.env -f compose.yml -f compose.monitoring.yml pull
docker compose --env-file /etc/idbots/deploy.env -f compose.yml -f compose.monitoring.yml up -d
docker compose --env-file /etc/idbots/deploy.env -f compose.yml ps     # all Up/healthy
```

The control plane needs its first-run state (invites, redeem codes, host row)
— that is WS-B's admin CLI; see `deploy-control-plane.md` § first boot.

## 6. Verify the edge (AC-C-2)

```bash
curl -sI http://{APP_HOST}/health | head -1        # 301/308 to https
curl -sI https://{APP_HOST}/health | grep -i strict-transport-security
curl -s https://{APP_HOST}/health                  # {"ok":true,...} once cp is up
openssl s_client -connect {APP_HOST}:443 -servername {APP_HOST} </dev/null 2>/dev/null \
  | openssl x509 -noout -dates                     # cert issued + dates sane
```

Caddy obtains the certificate automatically on first HTTPS hit (DNS must
already point `{APP_HOST}` at the EIP). WebSocket idle behavior and the
26 MB body limit are exercised during M2 acceptance (AC-C-2).

## 7. Verify tenant isolation (AC-C-1)

One command (prints the live ruleset, then expected-vs-actual probes):

```bash
sudo /opt/idbots/firewall-verify.sh       # exit 0 only if every probe matches
```

Manual spot-checks if you want to see it by hand (after WS-B provisions a
first tenant, or with the stand-in image started manually on the
`idbots_tenants` network):

```bash
# from inside a tenant these must FAIL:
docker exec idb-t_xxx sh -c 'curl -m 3 -s http://100.100.100.200/latest/meta-data/'   # blocked
docker exec idb-t_xxx sh -c 'curl -m 3 -s http://10.0.0.1/'                             # blocked
docker exec idb-t_xxx sh -c 'curl -m 3 -s http://172.30.0.2:8080/health'                # blocked
docker exec idb-t_xxx sh -c 'curl -m 3 -s http://172.30.0.3:8790/healthz'               # blocked (tenant->tenant)
# and these must SUCCEED:
docker exec idb-t_xxx sh -c 'curl -m 5 -sI https://api.deepseek.com | head -1'
docker exec idb-t_xxx sh -c 'getent hosts api.deepseek.com'                             # DNS works
# from the control plane:
docker exec idbots-control-plane-1 sh -c 'curl -m 3 -s http://idb-t_xxx:8790/healthz'   # answers
```

If tenant-side traffic is NOT blocked, check
`sysctl net.bridge.bridge-nf-call-iptables` (=1) and
`iptables -L IDBOTS-TENANT -nv`, then `systemctl restart idbots-firewall`.

## 8. Alert fire drill (AC-C-6)

Each REQ-C-16 rule must reach the robot once on staging. Triggers:

| Rule | How to trigger |
|---|---|
| HostMemoryHigh | `stress-ng --vm 2 --vm-bytes 80% --timeout 12m` (then watch recovery) |
| HostCPUHigh | `stress-ng --cpu 0 --timeout 12m` |
| HostDiskHigh | `fallocate -l 85%` of free space in a temp file on the data disk; delete after |
| TenantCPUSaturated | `docker exec idb-t_xxx sh -c 'yes > /dev/null & yes > /dev/null &'` for 15 min |
| TenantRestarting | `docker restart idb-t_xxx` 4 times within 15 min |
| TenantFailed | provision a tenant with a deliberately broken image tag on staging |
| TenantOOMKilled | `docker exec` a memory bomb exceeding 2304m inside one tenant |
| ControlPlaneDown / HealthFailing | `docker stop idbots-control-plane-1` for 3 min |
| ControlPlane5xxHigh | loop bad requests against `/api/v1/...` on staging |
| TLSCertificateExpiringSoon | point blackbox at a host with a short-lived cert (or lower the threshold on staging) |
| BackupFailed / BackupStale | run `backup-tenant.sh` for a fake tenant id |
| TenantsNearCapacity | fill staging to 22+ of 27 (fake tenants) or lower the threshold |

Relay self-test (robot round-trip without Prometheus):
`deploy/monitoring/README.md` § "Testing an alert end to end".

## 9. External uptime check (REQ-C-17)

Not a repo asset — configure in the Alibaba Cloud console:
CloudMonitor → 站点监控 (site monitoring), task
`https://{APP_HOST}/health`, HTTP GET every 1 minute, probe points in at
least two mainland provinces (e.g. 杭州 + 深圳), alarm on 3 consecutive
failures to the same robot. Record the P95 RTT for the M5 go-live checklist.

## 10. Nightly backup first-night checks

```bash
systemctl list-timers idbots-backup.timer          # next run 03:05
journalctl -u idbots-backup.service -n 50          # after the first night
ossutil -i ... -k ... -e {ENDPOINT} ls oss://{OSS_BUCKET}/tenants/   # objects exist
```

Then run a staging restore drill per `backup-and-restore.md`.
