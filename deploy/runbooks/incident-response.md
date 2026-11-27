# Runbook: incident response

First principles: tenants are disposable, volumes are not; the control plane
is stateless except `cp-data`; alerts already told you something — read the
robot message before the dashboards. Always note the time (+08:00) and your
actions for the post-incident note.

## 1. Tenant failed (`TenantFailed`, or a user reports their Bot is dead)

```bash
CP="docker exec idbots-control-plane-1 node dist/cli.js"
$CP tenant show t_xxx            # status, last error, image
$CP tenant logs t_xxx --since 1h # container logs through the Docker API
```

- Image/crash loop → `$CP tenant restart t_xxx`. If it keeps failing, roll
  the tenant back: `$CP tenant upgrade t_xxx --image {previous_image}`
  (see `tenant-image-rollout.md`).
- Volume corruption → restore: `backup-and-restore.md` replace mode.
- Onboarding stuck (gas sponsor down, Metaso down) → the tenant recovers on
  its own once the dependency is back (WS-A REQ-A-8); communicate, don't
  recreate.

## 2. Host memory pressure (`HostMemoryHigh`)

1. `docker stats --no-stream | sort -k4 -h | tail` — find the hogs.
2. A tenant holding > 1.5 GB idle for > 30 min is abnormal (the post-turn
   tail should fall back within 10 min, WS-A REQ-A-31): restart that one
   tenant — user impact is a reconnect.
3. Fleet-wide pressure near capacity: this host is full — start the
   `add-host.md` procedure and stop new provisioning (set the host row's
   capacity to the current tenant count via the control plane).
4. `HostSwapMissing` — the host lost its zram device, so idle tenants pin
   their cold memory again (CR-WSA-006): `systemctl status idbots-zram-swap`,
   then `systemctl restart idbots-zram-swap` and confirm with `swapon --show`.
5. `HostSwapNearlyFull` — zram is more than 90 % used: `zramctl` shows the
   compression ratio, `free -m` the swap line. Cold tenant memory has nowhere
   left to go, so this is the moment for step 3, not for adding tenants. To
   take swap out of service entirely follow CR-WSA-006 §6 — and never
   `swapoff` while memory is tight; it pulls every page back into RAM.
6. earlyoom acts on RAM alone (`-s 100,100`): SIGTERM at 8 % available,
   SIGKILL at 6 %. `journalctl -u earlyoom` lists what it killed and when.

## 3. Control plane down (`ControlPlaneDown`, 502 at the edge)

Tenants keep serving established sessions; logins/provisioning/proxy stop.

1. `docker logs idbots-control-plane-1 --tail 100`.
2. Bad config/image → `deploy-control-plane.md` § rollback.
3. Healthy but unreachable → check docker-socket-proxy:
   `docker logs idbots-docker-socket-proxy-1 --tail 50`; the control plane
   polls containers through it. Restart order: proxy, then control plane.
4. Still down after 15 min → declare in the robot group, escalate to WS-B.

## 4. SMS provider failure (login codes not arriving)

1. Send a test code through the Alibaba Cloud SMS console — isolates us vs
   them.
2. Check the RAM credential quota/limits in the console; check
   `cp.env` template codes match the approved templates.
3. Provider incident → status page + robot notice; staging can flip
   `CP_SMS_MODE=fake` with allowlisted numbers — PRODUCTION MUST NEVER
   (the control plane refuses fake mode on the production origin, SEC-06).

## 5. Metaso outage (balance/LLM quota/bundle errors in the app)

1. `curl -sI https://www.metaso.network/assist-open-api/health` from the host.
2. Confirmed outage → robot notice: balances and recharge degrade, chat on
   remaining quota continues. Tenants retry on their own.
3. If onboarding stalls (gas sponsor down), new sign-ups wait — do NOT
   recreate tenants; recovery is automatic (§1).

## 6. Suspected compromise (tenant or host)

1. Freeze: stop the affected tenants (`$CP tenant stop t_xxx`), or isolate
   the host in the security group (deny all inbound except your IP) if host
   compromise is suspected.
2. Preserve evidence: `docker logs`, `journalctl -u auditd`, snapshot the
   disk from the console BEFORE changes.
3. Rotate everything that could be exposed, in this order:
   `secret-rotation.md` — gateway secret of affected tenants → CP master key
   → SMS/OSS/ACR RAM credentials → the alert webhook.
4. Rebuild: compromised tenant volumes are treated as hostile — restore the
   user from last night's backup into a fresh volume (replace mode), never
   re-attach the old one.
5. Report: timeline, blast radius (which tenants, what data classes), actions
   — to the owner within 24 h.
