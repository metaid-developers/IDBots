# @idbots/control-plane

WS-B control plane for the IDBots cloud/mobile program. It owns users,
invites, and login; creates and manages one tenant container per user; and is
the only public entry to those containers. It implements contract **C3**
(control-plane public API), consumes **C1** (tenant runtime) and **C2**
(gateway protocol), and never reads user content.

This directory is its own pnpm package with its own lockfile (REQ-B-1): the
repository-root `pnpm install` does not install it.

## Layout

- `src/config.ts` — environment parsing/validation (`loadConfig`, pure)
- `src/ids.ts` — `u_`/`t_` id and invite-code generators
- `src/crypto.ts` — AES-256-GCM secret encryption, SHA-256, phone masking
- `src/db/` — better-sqlite3 open helper, WAL, versioned migrations
- `src/rateLimit.ts` — C3 SMS/verify rate-limit rules (pure, `now` injected)
- `src/cookies.ts` — `idb_session` cookie build/parse/clear
- `src/origin.ts` — Origin header checks for state-changing requests
- `src/sms.ts` — SMS provider interface, fake provider, code hashing
- `src/services/signup.ts` — invite-consuming sign-up transaction core
- `src/docker/client.ts` — Docker Engine API client (volume/container/image/logs + `tenantBaseUrl`)
- `src/server.ts`, `src/main.ts` — minimal node:http server and entry point
- `test/fake-tenant/fake-tenant.mjs` — dependency-free fake tenant (C1/C2 surface)
- `test/fake-docker/` — in-process fake Docker Engine API backed by child processes
- `scripts/dev-loop.mjs` — runnable local loop: control plane + fakes, no daemon

## Requirements

- Node.js `>=24 <25`
- pnpm `11.24.0` (pinned by the root; `corepack enable`)

## Install, build, test, lint

```sh
pnpm install                # generates pnpm-lock.yaml; builds better-sqlite3
pnpm build                  # tsc -> dist/
pnpm test                   # node:test via tsx (fresh temp SQLite per file)
pnpm lint                   # eslint flat config
pnpm start                  # node dist/main.js (after build)
```

## Configuration

All configuration comes from environment variables (WS-C provides an env
file). See REQ-B in `docs/cloud-mobile/20-ws-b-control-plane.md` for the
authoritative table.

| Variable | Meaning |
|----------|---------|
| `CP_PUBLIC_ORIGIN` | `https://app.{APP_DOMAIN}`; Origin checks and cookies |
| `CP_LISTEN` | public listen address (default `0.0.0.0:8080`) |
| `CP_METRICS_LISTEN` | internal metrics listen address (default `0.0.0.0:9100`) |
| `CP_DB_PATH` | SQLite file on a persistent volume |
| `CP_MASTER_KEY` | 32 bytes base64; AES-256-GCM key for gateway secrets, redeem codes, and device push tokens |
| `CP_DOCKER_URL` | Docker Engine API, e.g. `http://docker-proxy:2375` or `http+unix:///var/run/docker.sock` |
| `CP_TENANT_IMAGE` | default tenant image tag |
| `CP_TENANT_NETWORK` | Docker network for tenants |
| `CP_TENANT_MEMORY_MB` | default `2304` (C1 resources) |
| `CP_TENANT_CPUS` | default `2` |
| `CP_TENANT_ENV_*` | extra env passed to every tenant (prefix stripped) |
| `CP_SMS_MODE` | `aliyun` or `fake` |
| `CP_SMS_ACCESS_KEY_ID`, `CP_SMS_ACCESS_KEY_SECRET`, `CP_SMS_SIGN_NAME`, `CP_SMS_TEMPLATE_LOGIN`, `CP_SMS_TEMPLATE_REVERIFY` | Alibaba Cloud SMS |
| `CP_FAKE_SMS_NUMBERS` | staging-only test numbers for the fixed code `246810` |
| `CP_ALERT_WEBHOOK` | Feishu/DingTalk webhook for provisioning and upgrade failures |
| `CP_PUSH_PROVIDER` | `disabled` (default), `fcm`, or `fake` for local/staging tests |
| `CP_FCM_SERVICE_ACCOUNT_JSON` | FCM service-account JSON with `project_id`, `client_email`, and `private_key`; required for `fcm`, secret environment only |

The additive device routes are `POST /api/v1/devices/register`, `POST /api/v1/devices/unregister`, and `GET/PUT /api/v1/notification-preferences`. Tenant notification ingest is `POST /internal/v1/tenants/:tenantId/notifications` using the existing tenant gateway bearer credential. Delivery is persisted per `(eventId, deviceId)` with retries and invalid-token revocation. See `docs/cloud-mobile/change-requests/CR-WSE-004-device-push-delivery.md`. Fake push is not a production delivery implementation; Chinese OEM and APNs acceptance remain separate launch gates.

`CP_SMS_MODE=fake` refuses to start unless `CP_PUBLIC_ORIGIN` is
`localhost`, `127.0.0.1`, `[::1]`, or a `*.staging` origin.

Minimal local run (SQLite in /tmp, no docker required — `/health` reports
`docker: false` then):

```sh
CP_PUBLIC_ORIGIN=http://localhost:8080 \
CP_DB_PATH=/tmp/cp.sqlite \
CP_MASTER_KEY="$(node -e 'console.log(Buffer.alloc(32,7).toString("base64"))')" \
CP_DOCKER_URL=http+unix:///var/run/docker.sock \
CP_TENANT_IMAGE=example/idbots-tenant:0.1.0 \
CP_TENANT_NETWORK=idbots-tenants \
CP_SMS_MODE=fake CP_FAKE_SMS_NUMBERS=+8613900000000 \
pnpm start
```

## Dockerfile

`Dockerfile` is a multi-stage build: `node:24-bookworm-slim` build stage
(corepack pnpm, `pnpm install --frozen-lockfile`, `pnpm build`) and a runtime
stage with production `node_modules` only, running as uid 1000. It exposes
8080 (public) and 9100 (internal metrics). Image tagging
(`{REGISTRY}/idbots/control-plane:{version}-{commit7}`) is WS-C CI's job.

## Local loop with the fake tenant (REQ-B-21)

Prerequisites: Node `>=24 <25` and `pnpm install` (dev deps include `tsx`,
which provides `esbuild`). No Docker daemon is needed — the loop runs
against the in-process fake engine.

```sh
pnpm build && node scripts/dev-loop.mjs
```

The script starts the fake Docker engine on an ephemeral port, starts the
built control plane (`dist/main.js`) with `CP_DOCKER_URL` pointed at it,
creates a fake tenant container through the docker client (what T2
provisioning will do), waits for `/readyz` to turn `ready`, prints `GET
/health` from the control plane, and tears everything down. The step list is
a `STEPS` array, so T2 can extend it into the full
register → provision → reconnect loop.

### What the fake docker is and why

`test/fake-docker/index.mjs` implements the subset of the Docker Engine API
the control plane uses (`/_ping`, volumes, container create/start/stop/
remove/inspect/list, image labels, logs) over `node:http`, with each
"container" backed by a child process running `fake-tenant.mjs`. It exists
because the dev machine has no Docker daemon; integration tests and the dev
loop get the same control-plane code paths either way. Run it standalone
with `node test/fake-docker/main.mjs --port 2375`.

### How the real-docker path differs

Real containers publish no ports (C1), so `tenantBaseUrl()` resolves the
tenant through the container **network IP at 8790** — that branch is the
production path. The fake engine maps container 8790 to an ephemeral
`127.0.0.1` port instead, so the host-port-mapping branch is local-only.

### Fake tenant script reference

`test/fake-tenant/fake-tenant.mjs` implements the C1/C2 surface:
`/healthz`, `/readyz` (full C1 body with scripted phases), the `/gateway/v1/ws`
socket (welcome/result/event/ping-pong, 1 MiB inbound limit), constant-time
secret checks, JSON logs, SIGTERM → close 4012 → exit 0. Knobs (env):

| Variable | Default | Meaning |
|----------|---------|---------|
| `IDBOTS_TENANT_ID` | `t_test` | tenant id in logs and the welcome frame |
| `IDBOTS_GATEWAY_SECRET` | `test-secret` | required on every route except `/healthz` |
| `IDBOTS_GATEWAY_PORT` | `8790` | listen port; `0` = ephemeral, reported on the `listening` log line |
| `FAKE_TENANT_HEALTH_AFTER_MS` | `0` | `/healthz` answers 503 before this |
| `FAKE_TENANT_PHASES` | `ready:0` | comma list `{phase}:{ms}`; `/readyz` walks it, final phase sticky |
| `FAKE_TENANT_EXIT_AFTER_MS` | — | exit(1) after this (crash tests) |
| `FAKE_TENANT_APP_VERSION` | `0.12.0` | reported version |
| `FAKE_TENANT_CONTRACT_VERSION` | `1.0.0` | reported C2 contract version |

Example: `FAKE_TENANT_HEALTH_AFTER_MS=100 FAKE_TENANT_PHASES=migrating:200,bootstrapping:300,ready:0 node test/fake-tenant/fake-tenant.mjs`.

`test/fake-tenant/Dockerfile` builds the same script as a tiny
`node:24-alpine` image. It cannot be built on the dev machine (no Docker
daemon); CI (WS-C) builds it with this directory as the context.

## Login bundle (REQ-B-19)

`/` and `/login` serve the mobile login bundle WS-E builds with
`pnpm build:mobile` (`dist-mobile-login/` at the repo root). Set
`CP_LOGIN_BUNDLE_DIR` to override; when neither exists, a built-in English
placeholder (`static-login/`) that polls `/api/v1/me` is served. A visitor
with a valid cookie and a ready/degraded tenant is redirected to `/app/`.

The image build context is the **repository root** so the Dockerfile can
`COPY dist-mobile-login/` (CI builds the bundle first — see the Dockerfile
header). The package-local `.dockerignore` only applies to package-context
builds; a root-context build is governed by the repository-root
`.dockerignore`.

## Operations notes

- **Never expose the control plane directly.** Client IPs come from
  `X-Forwarded-For` and are trusted unconditionally — safe only behind the
  WS-C reverse proxy, which must be the single public entry. A directly
  exposed port lets an attacker rotate `X-Forwarded-For` to bypass the
  per-IP SMS daily limit.
- **Upgrade recreation failure leaves the tenant `failed` and offline** (the
  old container is already gone; an alert fires). Operator remediation:
  check `tenant show ID` and `tenant logs ID`, then bring it back with
  `tenant start ID` or `tenant upgrade ID --image <known-good>` after
  pinning a known-good image tag.
- **An image without the `org.idbots.rollback-safe-to` label downgrades
  freely.** The downgrade refusal only applies when the current image
  declares a floor — pin image tags deliberately and keep that label
  accurate on every release.

## Note

The package is not shipped in desktop builds; `electron-builder.json` does
not include `cloud/`. The root ESLint config ignores `cloud/**` and this
package lints itself (`pnpm lint`).
