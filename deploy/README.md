# deploy/ — WS-C deployment and operations assets

One command brings up a relay host: `sudo deploy/hosts/bootstrap.sh`, then
`docker compose up -d`. Everything here is files and scripts — no cloud
account is touched by this repository, and no real secret ever is
(placeholders only; the scanner checks).

| Directory | Contents | Requirements |
|---|---|---|
| `hosts/` | `compose.yml` + monitoring/host-agent/PostgreSQL overlays, `Caddyfile` (REQ-C-5), `firewall.sh` + systemd unit (REQ-C-6), `daemon.json` (REQ-C-2), `bootstrap.sh`, env templates | C1, C-2..C-7, C-10..C-12 |
| `tenant-image/` | Production IDBots server-mode tenant image with the PWA, skills, DSH runtime, and C2 gateway + build/verification scripts | C1, REQ-C-9 |
| `backup/` | Nightly backup driver + per-tenant/control-plane backups, restore script (drill/replace), OSS bucket provisioning, systemd timer, drill records | REQ-C-13..C-15 |
| `monitoring/` | Prometheus rules (one per REQ-C-16 bullet), Alertmanager, blackbox probes, Feishu/DingTalk `alert-relay` | REQ-C-16, C-17 |
| `runbooks/` | Operator runbooks (see below) | REQ-C deliverables |

Runbooks: `host-bootstrap.md` (start here), `deploy-control-plane.md`,
`tenant-image-rollout.md`, `backup-and-restore.md`, `incident-response.md`,
`secret-rotation.md`, `user-data-export-and-deletion.md`, `add-host.md`,
`staging-reset.md`, `commercial-operations.md` (RBAC/MFA, approvals, and the
Web admin backend).

## Conventions

- Environments: staging ≈ 4 vCPU/16 GB (capacity 27), production 8 vCPU/32 GB
  (capacity 58), `cn-hongkong`, Ubuntu 24.04, Docker CE.
- Compose project `idbots`; networks `edge`, `cp-docker` (internal),
  `tenants` (172.30.0.0/16, control plane fixed at 172.30.0.2), `monitoring`
  (internal). Only caddy publishes ports (80/443).
- Images: `{REGISTRY}/idbots/{tenant,control-plane}:{version}-{commit7}`,
  built and scanned by `.github/workflows/cloud-images.yml` (tags `cloud-v*`).
- Secrets live only in `/etc/idbots/*.env` (0600, root) on hosts and in the
  CI secret store — per the secrets register in
  `docs/cloud-mobile/00-program-plan.md`. `cp.env.example`,
  `deploy.env.example`, `backup.env.example`, `monitoring.env.example` are the
  canonical variable lists.
- Objects in OSS: `tenants/{tenantId}/{yyyy-mm-dd}.tar.zst.enc`,
  `control-plane/{yyyy-mm-dd}.sqlite.zst.enc`, 30-day lifecycle, SSE +
  versioning on the bucket.

## From zero to serving (summary)

1. Procurement done by the owner's team (`docs/cloud-mobile/15`): host, EIP,
   domain DNS, ACR, SMS, OSS bucket, robot webhook, RAM users.
2. `sudo deploy/hosts/bootstrap.sh --role staging|production` on the host.
3. Fill `/etc/idbots/*.env`; re-run bootstrap (renders prometheus.yml,
   enables the backup timer).
4. `docker login` (ACR pull), then
   `docker compose --env-file /etc/idbots/deploy.env -f compose.yml -f compose.monitoring.yml up -d`.
5. Verify per `runbooks/host-bootstrap.md` § 6–10 (edge, isolation, alert
   fire drill, uptime check, first-night backups).

Latest restore drill: `backup/drill/2026-10-20-local-restore-drill.md`.
