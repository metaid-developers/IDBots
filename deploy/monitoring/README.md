# deploy/monitoring — metrics, alerts, and the robot relay (REQ-C-16, C-17)

Runs from `deploy/hosts/compose.monitoring.yml`: Prometheus, Alertmanager,
blackbox-exporter, and `alert-relay` (Alertmanager webhook → Feishu/DingTalk
robot). Nothing publishes a host port; reach the UIs through an SSH tunnel:

```bash
ssh -L 9090:127.0.0.1:9090 -L 9093:127.0.0.1:9093 {host} \
  docker exec idbots-prometheus-1 wget -qO- http://127.0.0.1:9090/-/ready
# or forward the container IPs onto the host loopback via the compose network:
ssh -L 19090:$(docker -H ssh://{host} inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' idbots-prometheus-1):9090 {host} -N
```

## Control-plane metric names (convention)

REQ-B-20 fixes the metric CONTENT but not the names. These rules assume:

| Name | Type | Meaning |
|---|---|---|
| `cp_tenants_by_status{status=...}` | gauge | tenants per C3 status (powers TenantFailed + TenantsNearCapacity) |
| `cp_http_requests_total{route,status}` | counter | HTTP requests (powers ControlPlane5xxHigh) |
| `cp_host_capacity` | gauge | this host's `capacity` from REQ-C-19 |
| `cp_tenants_by_kind` / `cp_tenants_by_cohort` | gauge | tenant commercial classification counts |
| `cp_rollout_jobs{status=...}` / `cp_rollout_items{status=...}` | gauge | persistent rollout job and item state |
| `cp_host_agents_connected` / `cp_host_agent_last_seen_timestamp_seconds` | gauge | remote agent presence and heartbeat age |

If WS-B ships different names, adjust `alert-rules.yml` in one place — the
rule logic stays.

## Backup metrics (textfile collector)

`backup/*.sh` writes `idbots_backup_last_result`,
`idbots_backup_last_success_timestamp_seconds`,
`idbots_backup_last_duration_seconds`, `idbots_backup_last_size_bytes` into
`/var/lib/idbots/node-exporter-textfile/`. Alerts: `BackupFailed`,
`BackupStale` (no success in 26 h).

## External uptime check (REQ-C-17)

The blackbox job on the host probes `https://{APP_HOST}/health` from the host
itself. REQ-C-17 additionally requires probes from **at least two mainland
locations** with latency recording — that is an external service, not a repo
asset: Alibaba Cloud **CloudMonitor → 站点监控** (site monitoring) with probe
points in at least two mainland provinces, target `https://{APP_DOMAIN}/health`,
and its alarm linked to the same robot. Setup steps live in
`runbooks/host-bootstrap.md` § "External uptime check"; the P95 number is
recorded in the M5 go-live checklist (`60`).

## alert-relay

Dependency-free Node service (`alert-relay/`). Auto-detects Feishu vs DingTalk
from `ALERT_WEBHOOK_URL`, supports robot 加签 (`ALERT_SECRET`), retries once,
and prefixes every message with `[IDBots]` (use it as the robot keyword if the
robot has no signing secret). The same message format is used by the backup
scripts' failure alerts (`deploy/backup/lib.sh`), so one robot serves both.

`notify-test.sh` proves the delivery path on demand — run it after filling
`monitoring.env`, after every webhook rotation, and before the AC-C-6 fire
drill:

```bash
sudo /opt/idbots/monitoring/notify-test.sh
# prints cwd/script, the webhook host (token stripped), HTTP status, and the
# robot's response body; exit 0 only on HTTP 200.
```

## Testing an alert end to end (AC-C-6)

On the host, after the stack is up:

```bash
# fire a synthetic Alertmanager notification through the real relay:
docker exec idbots-alert-relay-1 node -e '
  fetch("http://127.0.0.1:9080/alert", {method:"POST",
    headers:{"content-type":"application/json"},
    body: JSON.stringify({version:"4",groupKey:"manual",status:"firing",
      alerts:[{status:"firing",labels:{alertname:"ManualTest",severity:"warning"},
      annotations:{summary:"relay self-test"},startsAt:new Date().toISOString()}]})
  }).then(r=>console.log("relay:",r.status))'
# the robot group should receive "[IDBots] ALERT ManualTest — relay self-test"
```

Each REQ-C-16 rule must still be triggered for real once on staging (AC-C-6);
the triggers are listed in `runbooks/host-bootstrap.md` § "Alert fire drill".
