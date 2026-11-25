# Runbook: commercial cloud acceptance before promotion

Use a build produced from `main`, never a feature branch. This is the acceptance
gate for the commercial operations implementation, not a claim that these live
checks have already run.

## 1. Separate failure domains

- Staging and production use different ECS hosts, databases, credentials, and
  tenant data. Do not run both public environments on the shared 16 GB host.
- Run `deploy/hosts/commercial-preflight.sh staging` and `... production`.
  Supply `PEER_HOST_ID` when checking that the two environments are distinct.
- Required result: control plane, Prometheus, Alertmanager, node-exporter, and
  cAdvisor are running; memory is below 75%, Docker disk is at least 20% free,
  and no Docker/PostgreSQL public listener exists.

## 2. Back up and prove restore

- Run the nightly control-plane and tenant backup and verify the uploaded
  objects, then complete a tenant restore drill.
- With PostgreSQL enabled, set `OPERATIONS_DB_REQUIRED=1`, run
  `backup-operations-db.sh`, and verify `operations-db/DATE.pgdump.zst.enc`.
- Restore the decrypted custom-format dump into a NEW empty PostgreSQL instance
  with `pg_restore --clean --if-exists --create --dbname postgres`. Never test
  restore into the live database. Start a candidate control plane against the
  restored copy and verify jobs, waves, attempts, and leases.
- Required result: RPO/RTO evidence and no change to production user data.

## 3. Verify additive migrations

- Take a copy of the current SQLite database and open it with the new control
  plane. Migrations 7–11 add metadata and operational tables without resetting
  existing users or tenants.
- Verify existing users can sign in and existing tenants remain ready.
- Verify customer/internal/synthetic/demo and canary/early/stable classification
  is explicit; do not bulk-classify accounts merely from a display-name guess.

## 4. Verify release and rollout safety

- Register the CI-generated `cloud-release-manifest.json`; conflicting content
  for the same release identity must fail.
- Run synthetic canary → internal → percentage rollout. Confirm same-digest
  canaries are skipped and stopped/suspended/failed tenants are not selected by
  the fleet selector.
- Inject a bad canary, two consecutive failures, and a missing image. Expansion
  must pause and affected tenants must roll back without losing their volumes.
- Stop and restart the control plane during a running job. A running job resumes
  without duplicate successful items; a paused job does not silently continue.

## 5. Verify RBAC and the Web admin backend

- Enroll viewer/support/operator/admin accounts with TOTP. Verify role denial,
  session expiry, Origin enforcement, and masked phone/audit access.
- Verify self-approval, approval replay, expired approval, and payload
  substitution all fail. A second operator must approve every full upgrade and
  rollback plan.
- Build the visual Web admin only against these APIs. The backend delivery is
  not evidence that a visual UI exists.

## 6. Verify host agents and PostgreSQL for real

- Enroll a second host with a unique client certificate. Revoke it and confirm
  the connection fails. Rotate certificates without exposing Docker or agent
  ports publicly.
- Execute remote canary upgrade, rollback, disconnect, and reconnect drills.
  Agent logs must not contain tenant gateway secrets.
- Enable `CP_ROLLOUT_DATABASE_URL` against the internal PostgreSQL container.
  Run concurrent workers, restart the database and control plane, and prove no
  duplicate tenant execution. `pg-mem` tests are not a substitute for this gate.

## 7. Scale evidence

Repository gate: the 1,000-synthetic-tenant drill verifies wave persistence,
global concurrency 50, per-host concurrency 2, and scheduler restart recovery.
It uses a controlled executor and does not claim 1,000 real Electron containers.

Staging gate: run real-container capacity tests separately, record memory,
CPU, disk, registry pull time, readiness P50/P95, reconnect success, backup
duration, and failure recovery. Do not enable new-user placement across hosts
until placement, migration, and proxy routing pass their own end-to-end gate;
remote rollout execution alone is not multi-host serving acceptance.

## 8. Promotion decision

Record image digests, source SHA, environment, operator, timestamps, test
counts, live probe evidence, open defects, and rollback outcome. Any S1/S2
failure, missing backup restore, unverified mTLS/PostgreSQL, or unresolved
multi-host serving gap keeps commercial promotion blocked.
