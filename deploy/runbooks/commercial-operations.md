# Runbook: commercial operations and Web admin backend

The commercial control plane adds tenant classification, immutable releases,
persistent staged rollouts, administrator RBAC/MFA, and two-person approvals.
It is additive to C1–C3; the frozen mobile contracts are unchanged. Deploy the
control plane and run its additive migrations before using these commands.

## Bootstrap administrators

Create the first administrator through the restricted, in-container break-glass
CLI. The token and TOTP secret are printed once; store them in the company
password manager and enroll the secret in an authenticator. Do not send them in
chat or write them into deployment logs.

```bash
CP="docker exec idbots-control-plane-1 node dist/cli.js"
$CP admin create ops-owner --role admin --as admin:bootstrap
$CP admin list
```

| Role | Read | Audit | Tenant lifecycle/classify | Rollouts and approvals | Admin users |
|---|---|---|---|---|---|
| viewer | yes | no | no | no | no |
| support | yes | yes | yes | no | no |
| operator | yes | yes | yes | yes | no |
| admin | yes | yes | yes | yes | yes |

Disable an account with `$CP admin disable ID --as admin:operator`; this revokes
its existing sessions. Web/API login is `POST /api/v1/admin/session` with
`username`, the one-time bootstrap `token`, and the current six-digit `mfaCode`.
It returns a 30-minute session and also sets an HttpOnly, SameSite=Strict cookie
(Secure on HTTPS). Failed login attempts are rate-limited. All mutating Web API
requests still require the deployment Origin header.

The existing `CP_ADMIN_API_TOKEN` credit integration is a separate legacy
server-to-server surface, not an administrator identity and not a substitute
for MFA. Do not use it for the future Web admin UI.

## Read-only backend for the Web admin

The following endpoints are available for the planned Web UI:

- `GET /api/v1/admin/overview` — tenant/version/status totals and host capacity.
- `GET /api/v1/admin/tenants` — paginated, filterable inventory with masked phones.
- `GET /api/v1/admin/releases` — immutable release provenance and channels.
- `GET /api/v1/admin/rollouts[/id]` — waves, attempts, outcomes, and stop reasons.
- `GET /api/v1/admin/approvals` — approval state and actor separation.
- `GET /api/v1/admin/audit` — support and above only.
- `GET/POST /api/v1/admin/users` — admin-role account management.

Tenant classification and lifecycle operations live under
`/api/v1/admin/tenants/:id/classify` and `:id/lifecycle`.

## Two-person rollout approval

1. Operator A requests an approval with an action, reason, and the exact rollout
   payload (`releaseId`, `mode`, optional tenant/filter/concurrency fields).
2. Operator B approves `POST /api/v1/admin/approvals/:id/decision`. The requester
   cannot approve their own request. Pending approvals expire after 10 minutes.
3. `POST /api/v1/admin/rollouts` with the approved payload plus `approvalId`.
   The approval hash binds the action and canonical payload. A mismatch, expired
   approval, or replay is rejected. The created job starts paused.
4. Start/resume through `POST /api/v1/admin/rollouts/:id/actions`. Pause, retry,
   and cancel use the same route. `mode=rollback` requires a separate
   `rollout.rollback` approval.

The CLI equivalents remain available for restricted disaster recovery:

```bash
$CP rollout create RELEASE_ID --mode upgrade --as admin:operator
$CP rollout start RO_ID --as admin:operator
$CP rollout show RO_ID
```

## Web UI follow-up

The visual Web admin is a separate deliverable, not represented as shipped by
this backend. Build it against these APIs with no direct database access and no
tenant content, mnemonic, gateway-secret, SMS-code, or unmasked-phone views.
Recommended pages are Overview, Tenants, Hosts, Releases, Rollout detail,
Approvals, and Audit. Reuse the server-side roles; client-side hiding is not an
authorization boundary.

## PostgreSQL rollout queue and host agents

`CP_ROLLOUT_DATABASE_URL` moves the durable rollout queue to PostgreSQL;
`compose.operations-db.yml` provides an internal-only database on the same
operations host. This does not migrate users, login sessions, tenant secrets,
or tenant metadata out of SQLite. Add `pg_dump` backup/restore acceptance before
enabling it commercially. The SQL store is exercised with `pg-mem` in the
repository suite; a real PostgreSQL migration, lock, restart, and restore drill
remains a staging gate.

Remote host agents use the VPC-only mTLS listener and execute remote preflight,
container recreation, readiness, and rollback. See `add-host.md` for enrollment,
credential handling, and the explicit new-user placement/proxy-routing boundary.

## Safety checks before commercial promotion

Use `commercial-acceptance.md` as the live gate and
`deploy/hosts/commercial-preflight.sh` for the host-level checks.

- Verify additive migrations and a control-plane backup on a copy first.
- Verify viewer/support/operator/admin permissions and MFA expiry on staging.
- Prove self-approval, approval replay, payload substitution, and expired
  sessions are rejected.
- Run the staged-rollout failure drills in `tenant-image-rollout.md`.
- Do not expose Prometheus, Docker, PostgreSQL, or host-agent ports publicly.
