# 20 — WS-B: Control Plane

**Party:** control-plane development party (new). **Repository:** IDBots,
directory `cloud/control-plane/` as its own pnpm package.
**Implements:** C3 (control-plane public API). **Consumes:** C1 and C2 (from
WS-A). **Consumers:** WS-E (mobile client), WS-C (deploys it).

## Goal

A small service that owns users, invites, and login, creates and manages one
tenant container per user, and is the only public entry to those containers.
It holds no balances (Metaso is the source of truth) and never reads user
content.

## Background You Need

- `01-interface-contracts.md` C1, C2, and C3; `00-program-plan.md`
  (environments, secrets register).
- Repository rules in `AGENTS.md`: pnpm only, `<type>: <description>` commits,
  one branch plus worktree per task, no pushes to `main` without the owner.
- The control plane does not import any IDBots app code. It talks to tenants
  only through C1 and C2.

## Package Setup

- **REQ-B-1** `cloud/control-plane/` has its own `package.json`,
  `pnpm-lock.yaml`, and `pnpm-workspace.yaml` (pnpm settings live there, as for
  `dsh-runtime/`). The root `pnpm install` and its `postinstall` do not install
  it; it is installed with `pnpm --dir cloud/control-plane install --frozen-lockfile`.
- **REQ-B-2** Node `>=24 <25`, TypeScript, ES modules, compiled to
  `cloud/control-plane/dist/`. Keep dependencies few and maintained; expected
  set: an SQLite driver (`better-sqlite3`), a WebSocket library (`ws`), and the
  Alibaba Cloud SMS SDK or a hand-signed HTTP call. No web framework is
  required; if one is used, justify it in the README.
- **REQ-B-3** Root `pnpm run lint` must stay green: either the package passes
  the root ESLint config or its `dist/` and generated files are added to the
  root `ignorePatterns` and the package runs its own lint in CI. The package
  is not shipped in desktop builds (`electron-builder.json` does not include
  `cloud/`; keep it that way).
- **REQ-B-4** `cloud/control-plane/Dockerfile` builds
  `{REGISTRY}/idbots/control-plane:{version}-{commit7}`, runs as non-root, and
  exposes the public port (8080) and an internal metrics port (9100).

## Configuration

All configuration comes from environment variables (WS-C provides an env file):

| Variable | Meaning |
|----------|---------|
| `CP_PUBLIC_ORIGIN` | `https://app.{APP_DOMAIN}`; used for Origin checks and cookies |
| `CP_LISTEN`, `CP_METRICS_LISTEN` | `0.0.0.0:8080`, `0.0.0.0:9100` |
| `CP_DB_PATH` | SQLite file on a persistent volume, for example `/var/lib/idbots-cp/cp.sqlite` |
| `CP_MASTER_KEY` | 32 bytes, base64; encrypts gateway secrets at rest (AES-256-GCM) |
| `CP_DOCKER_URL` | Docker Engine API through the socket proxy, for example `http://docker-proxy:2375` |
| `CP_TENANT_IMAGE` | Default tenant image tag for new tenants |
| `CP_TENANT_NETWORK` | Docker network for tenants (from WS-C) |
| `CP_TENANT_MEMORY_MB`, `CP_TENANT_CPUS` | `2304` and `2` (C1 resources) |
| `CP_TENANT_ENV_*` | Extra env passed to every tenant, for example `CP_TENANT_ENV_IDBOTS_METASO_API_BASE` |
| `CP_SMS_MODE` | `aliyun` or `fake` |
| `CP_SMS_FAKE_ORIGIN_EXPLICIT` | `true` (or `1`) opts the deployer into fake SMS on ANY origin — time-boxed invite-test window until AliyunSmsProvider ships; unset = origin guard fully enforced |
| `CP_SMS_ACCESS_KEY_ID`, `CP_SMS_ACCESS_KEY_SECRET`, `CP_SMS_SIGN_NAME`, `CP_SMS_TEMPLATE_LOGIN`, `CP_SMS_TEMPLATE_REVERIFY` | Alibaba Cloud SMS |
| `CP_FAKE_SMS_NUMBERS` | Staging only: comma-separated test numbers that accept the fixed code `246810` |
| `CP_ALERT_WEBHOOK` | Feishu or DingTalk webhook for provisioning and upgrade failures |

`CP_SMS_MODE=fake` refuses to start when `CP_PUBLIC_ORIGIN` is the production
origin. The only escape is the explicit operator opt-in
`CP_SMS_FAKE_ORIGIN_EXPLICIT=true` (the origin is never spoofed); it exists for
the time-boxed invite-test window and goes away when `AliyunSmsProvider`
ships.

## Data Model

- **REQ-B-5** SQLite in WAL mode with versioned, idempotent migrations run at
  startup (`schema_migrations` table). Never drop or rewrite user rows in a
  migration.

| Table | Columns |
|-------|---------|
| `users` | `id` (`u_` + 20 base32), `phone_e164` (unique), `display_name`, `locale`, `status` (`active`, `disabled`), `invite_code`, `created_at`, `last_login_at` |
| `invites` | `code` (unique, 8–12 characters, no ambiguous letters), `max_uses`, `used_count`, `with_redeem` (0 or 1), `note`, `expires_at` (nullable), `disabled`, `created_at` |
| `redeem_codes` | `code_enc` (Metaso single-use traffic redeem code, encrypted like gateway secrets), `code_hash` (unique), `batch_note`, `imported_at`, `assigned_user_id` (nullable, unique), `assigned_at` |
| `sessions` | `token_hash` (SHA-256, primary key), `user_id`, `created_at`, `last_seen_at`, `expires_at`, `user_agent`, `ip` |
| `sms_codes` | `id`, `phone_e164`, `purpose` (`login`, `reverify`), `code_hash`, `attempts`, `expires_at`, `consumed_at`, `ip`, `created_at` |
| `tenants` | `id` (`t_` + 20 base32), `user_id` (unique), `host_id`, `container_name`, `volume_name`, `image`, `previous_image`, `gateway_secret_enc`, `status`, `phase`, `app_version`, `contract_version`, `last_error`, `created_at`, `updated_at` |
| `hosts` | `id`, `docker_url`, `capacity`, `status` (one row in v1; the code must not assume a single host) |
| `reverify` | `id`, `user_id`, `purpose`, `expires_at`, `consumed_at` |
| `deletion_requests` | `id`, `user_id`, `reason`, `status` (`open`, `exported`, `deleted`, `rejected`), `created_at`, `closed_at` |
| `audit_log` | `id`, `at`, `actor` (`system`, `admin:<name>`, `user:<id>`), `action`, `target`, `detail_json` |

## Requirements

### Authentication and Invites

- **REQ-B-6** C3 auth endpoints exactly as specified: SMS send and verify,
  `me`, logout, cookie attributes, error codes, and rate limits. SMS codes are
  6 digits, valid 5 minutes, stored hashed.
- **REQ-B-7** A first login for an unknown phone requires a valid invite with
  remaining uses; the user row, invite use, and tenant row are created in one
  transaction. Existing users log in without an invite.
- **REQ-B-8** Origin check on every state-changing request and WebSocket
  upgrade; `403 ORIGIN_NOT_ALLOWED` or close 4003.

### Provisioning and Tenant Lifecycle

- **REQ-B-9** Provisioning creates, through the Docker API: the volume
  `idb-{tenantId}-data`; the container `idb-{tenantId}` from `CP_TENANT_IMAGE`
  with every C1 setting (env, resources, security options, restart policy,
  log options, network, no published ports); then starts it. The gateway
  secret is 32 random bytes, stored encrypted. Bootstrap env comes from the
  user (`displayName` given at sign-up, default `IDBots User`; locale) and,
  when the invite has `with_redeem = 1`, one unassigned code from
  `redeem_codes` (`IDBOTS_BOOTSTRAP_TRAFFIC_REDEEM_CODE`). Metaso redeem codes
  are single-use, so each user gets their own code, assigned in the sign-up
  transaction; an empty pool provisions without a code, logs a warning, and
  alerts. The display name is written on-chain by the tenant, so it is never
  derived from the phone number.
- **REQ-B-10** A tenant status machine:

  ```text
  provisioning → booting → onboarding → ready
                                      ↘ degraded
  ready | degraded → upgrading → ready | degraded | failed
  any → stopped (admin) → booting
  any → suspended (admin, user disabled)
  provisioning | booting | onboarding → failed (timeout or container exit)
  ```

  A poller checks each non-stopped tenant: `/healthz` and `/readyz` every 3 s
  while booting or onboarding, every 30 s otherwise. `booting` until
  `/healthz` answers; `onboarding` while `/readyz` phase is `migrating` or
  `bootstrapping`; then `ready` or `degraded`. Timeouts: 60 s to healthy, 300 s
  to ready on first boot, 90 s on restarts. Failure sends an alert to
  `CP_ALERT_WEBHOOK`.
- **REQ-B-11** The control plane restarts cleanly without affecting tenants:
  on startup it reconciles the `tenants` table with the containers that exist
  (by name) and resumes polling. A container the table does not know is
  reported, never deleted.
- **REQ-B-12** Upgrade: for each selected tenant, set `upgrading`, stop the
  container (`SIGTERM`, 30 s), remove it, create it again from the new image on
  the same volume with the same secret, start, and wait for ready. If it does
  not become ready in 300 s, recreate it with `previous_image` when the new
  image's `org.idbots.rollback-safe-to` label allows that version; otherwise
  mark `failed` and alert. Batches run one tenant at a time by default
  (`--batch` raises it). Downgrades below `rollback-safe-to` are refused.

### Proxy

- **REQ-B-13** `GET /ws`: validate the cookie and Origin; look up the tenant;
  if the tenant is not `ready` or `degraded`, accept and close with 4013. Open
  the upstream socket to `ws://{container_name}:8790/gateway/v1/ws` with the
  C2 upstream headers and pipe frames unchanged in both directions. Enforce the
  1 MiB inbound frame limit at the proxy too. Keepalive is hop by hop: the
  proxy pings the phone every 25 s and answers the tenant's pings. Close codes
  from the tenant are passed through to the phone.
- **REQ-B-14** `GET /files/{token}`, `POST /upload`, and `GET /app/*` are
  streamed (no full buffering) to the tenant routes with the secret header;
  uploads over 25 MB are cut off at the proxy with `413`. `/app/*` without a
  valid cookie redirects to `/login`.
- **REQ-B-15** One user maps to exactly one tenant. The proxy derives the
  tenant only from the session, never from a client-supplied ID.

### Sensitive Operations

- **REQ-B-16** Re-verification and mnemonic export exactly as C3: SMS to the
  user's own phone, a single-use `reverifyId` valid 120 s, then a C2 reverify
  token minted with the tenant's gateway secret. The mnemonic passes through
  memory only; responses carry `Cache-Control: no-store`; the audit log records
  the action without the mnemonic.
- **REQ-B-17** `POST /api/v1/account/deletion-request` records a request and
  alerts the operator.

### Admin CLI

- **REQ-B-18** `node dist/cli.js` (run inside the control-plane container),
  every mutating command written to `audit_log` with the operator name from
  `--as`:

  | Command | Effect |
  |---------|--------|
  | `invite create --uses N [--with-redeem] [--expires DATE] [--note TEXT]` | Prints the new code |
  | `invite list`, `invite disable CODE` | |
  | `redeem import --file CODES.csv [--note TEXT]` | Imports single-use codes exported from the Metaso admin console; duplicates are skipped |
  | `redeem stats` | Imported, assigned, and remaining counts (never prints codes) |
  | `user list [--phone]`, `user disable ID`, `user enable ID` | Disabling suspends the tenant |
  | `tenant list [--status]`, `tenant show ID` | Status, image, versions, last error |
  | `tenant restart ID`, `tenant stop ID`, `tenant start ID` | |
  | `tenant upgrade (ID ... \| --all) --image TAG [--batch N]` | REQ-B-12 |
  | `tenant rotate-secret ID` | New secret, container recreated |
  | `tenant logs ID [--since 1h]` | Container logs through the Docker API |
  | `tenant export ID --to PATH` | Archive of the tenant volume (stops the container briefly, then restarts it) |
  | `deletion list`, `deletion complete ID --confirm PHONE` | Removes container and volume only after an export exists and `--confirm` matches |

### Static Login Page and Observability

- **REQ-B-19** Serve the login bundle built by WS-E (`dist-mobile-login/`,
  copied into the image) at `/` and `/login`. A visitor with a valid cookie and
  a ready tenant is redirected to `/app/`; with a provisioning tenant, the
  login bundle shows the "preparing your Bot" state using `GET /api/v1/me`.
- **REQ-B-20** JSON logs with request IDs; no phone numbers in full (masked),
  no codes, no secrets. `/health` as C3. `/metrics` on the internal port in
  Prometheus text format: tenants by status, open sockets, requests by route
  and status, SMS sends and failures, provisioning and upgrade durations.

### Testing

- **REQ-B-21** A fake tenant in `cloud/control-plane/test/fake-tenant/`
  (a Node script and a tiny image) implementing C1 `/healthz` and `/readyz`
  with scripted phases and a C2 server that sends `welcome`, answers invokes
  with echo results, and emits a test event. Integration tests cover
  provisioning, status transitions, proxying, upgrade, and rollback against it.
- **REQ-B-22** Unit tests for rate limits, invite consumption and redeem-code
  assignment under concurrency (no code assigned twice), cookie handling,
  Origin checks, secret encryption, reverify expiry and single use, and the
  status machine.
- **REQ-B-23** On staging, WS-A's conformance kit passes through the public
  `/ws` route (`node cloud/conformance/run.mjs --via-control-plane …`).

## Deliverables

1. Branches in the order in `21-ws-b-implementation-plan.md`, merged on the
   owner's instruction.
2. Control-plane image in the registry (built by WS-C's CI).
3. `cloud/control-plane/README.md`: configuration, running locally with the
   fake tenant, admin CLI reference.
4. A delivery note listing each requirement with evidence.

## Acceptance Criteria

- **AC-B-1** On staging with the real tenant image: a new phone with a valid
  invite reaches the app in under 5 minutes (P95 over 5 runs); the same phone
  logs in again later without an invite and lands in the same tenant.
- **AC-B-2** Wrong code, expired code, missing invite, exhausted invite, and
  disabled user each return the C3 error; SMS and verify rate limits trigger at
  the stated thresholds.
- **AC-B-3** The conformance kit passes through `/ws`; a request with a wrong
  Origin is rejected; the cookie has `HttpOnly`, `Secure`, `SameSite=Strict`.
- **AC-B-4** A database dump contains no plaintext gateway secret, SMS code,
  session token, or redeem code.
- **AC-B-5** Restarting the control plane while three phones are connected:
  tenants keep running, the phones reconnect within 30 s, no tenant is
  recreated.
- **AC-B-6** Upgrading five tenants to a new image completes with all five
  ready; an image that never becomes ready is rolled back automatically and
  alerts the webhook.
- **AC-B-7** Mnemonic export works only after a fresh re-verification, fails
  on reuse of the same `reverifyId`, and leaves no mnemonic in logs or the
  database.
- **AC-B-8** A deletion request can be exported and completed with the CLI;
  completing without an export or with a wrong `--confirm` is refused; both
  are in the audit log.

## Out of Scope

Billing and balances (WS-D, read by the app through IPC), host firewalling,
TLS, and backups (WS-C), multi-host scheduling beyond keeping `host_id`,
idle sleep of tenants, a web admin UI.
