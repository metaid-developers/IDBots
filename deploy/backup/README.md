# deploy/backup — nightly backups and restores (REQ-C-14, REQ-C-15)

Every archive is `tar | zstd | age` (client-side encrypted) and uploaded to
OSS Hong Kong:

```
tenants/{tenantId}/{yyyy-mm-dd}.tar.zst.enc      one per tenant per night
control-plane/{yyyy-mm-dd}.sqlite.zst.enc        control-plane db and rollout queue (online backup)
```

The bucket is provisioned once (SSE, versioning, 30-day lifecycle) with
`oss-bucket-setup.sh`. Retention lives in the bucket lifecycle rule
(`oss-lifecycle.json`), not in the scripts.

| File | Purpose |
|---|---|
| `backup-nightly.sh` | Driver (systemd timer 03:05 Asia/Shanghai): control-plane first, then every `idb-t_*` container staggered across the 03:00–05:00 window; alerts on any failure. `--now` for manual runs, `--tenant t_x` to scope. |
| `backup-tenant.sh` | Crash-consistent per-tenant backup: live snapshot, `docker pause` (≤ 60 s), delta snapshot, fidelity manifest (`_backup-manifest.json`) embedded, archive, upload. |
| `backup-control-plane.sh` | SQLite online backup (`.backup` / `VACUUM INTO`) of `cp.sqlite`, including users, metadata, RBAC, and rollout jobs, archive, upload. |
| `restore-tenant.sh` | `--mode drill` (default): restore into a NEW volume, `PRAGMA integrity_check`, **fidelity compare against the archived manifest (files/bytes/row counts)**, boot a throwaway container, tear down. `--mode replace --confirm-replace`: disaster path through the control-plane CLI with a safety volume. |
| `lib.sh` | Shared: logging, Feishu/DingTalk alerts, OSS/local object layer, age helpers, textfile metrics, docker helpers. |
| `integrity-check.mjs` / `cp-online-backup.mjs` | node:sqlite tools for helper containers (Docker Desktop / remote docker, where the host cannot read volume paths). |
| `oss-bucket-setup.sh` + `oss-lifecycle.json` | One-time bucket provisioning (run by the ops team, admin side). |
| `idbots-backup.service` / `.timer` | systemd units installed by `bootstrap.sh`. |
| `drill/` | Restore drill records. Latest: `2026-10-20-local-restore-drill.md`. |

Configuration: `/etc/idbots/backup.env` (see `backup.env.example`, 0600,
never committed). Metrics for Prometheus: `idbots_backup_*` via the
node-exporter textfile collector (alert rules in `deploy/monitoring/`).

Restore drills must run on a schedule: local drills prove the scripts, the
staging drill before M4/M5 proves the environment (AC-C-5, A-21).
