# 01 — Interface Contracts

Contract version: **1.0.0**, frozen by the owner on 2026-10-15 (M1). Every
change from here on, including review findings from the parties, follows the
change-request process in `00-program-plan.md`. One item is known to come as
a minor change: WS-D's partner-policy mechanism (end of C4), version 1.1.0.

Amendments since the freeze:

| Date | Contract § | Change | CR | Compatibility |
|------|------------|--------|----|---------------|
| 2026-11-28 | C1 §Resources | A tenant may use up to 2304 MB of host swap next to its 2304 MB of RAM; the host backs that swap with zram. Was "no swap". | `change-requests/CR-WSA-006-tenant-swap-zram-pilot.md` | Backward compatible; nothing on the wire changes, so `contractVersion` stays 1.0.0 |

| Contract | Provider | Consumers |
|----------|----------|-----------|
| C1 Tenant runtime | WS-A (image), WS-C (runs it) | WS-B, WS-C |
| C2 Gateway protocol | WS-A | WS-B (proxies it), WS-E (speaks it) |
| C3 Control-plane public API | WS-B | WS-E |
| C4 Metaso bundle API | WS-D | WS-A (calls it), WS-E (shows it through IPC) |

Phase 0 values come from the spike report of 2026-10-14 (commit `e8653bac`)
and the S05b re-run of 2026-10-15. The results tarball
`phase0-linux-headless-results.tgz` (sha256
`ec684f1ce37e77e2ab38a3e9950347f8606f7950649ef5faffa48fef60c1088b`) was
checked locally on 2026-10-15: the hash matches, the secret scan is clean,
and the 16 patches are replayed on local branch `spike/linux-headless` at
`956f2b05`. That branch is not pushed.

---

## C1 — Tenant Runtime

One container per user runs the IDBots backend in server mode.

### Image

- Name: `{REGISTRY}/idbots/tenant:{appVersion}-{commit7}`, for example
  `registry.cn-hongkong.aliyuncs.com/idbots/tenant:0.12.0-1a2b3c4`.
- Labels:
  - `org.idbots.version` — app version from `package.json`.
  - `org.idbots.commit` — full commit hash.
  - `org.idbots.contract` — the C2 contract version, for example `1.0.0`.
  - `org.idbots.rollback-safe-to` — the oldest app version this image's data
    can be rolled back to without a database downgrade (empty if none).
- Runs as uid 1000, non-root. The entrypoint removes stale Xvfb locks, starts
  Xvfb on `:99` and D-Bus, then starts Electron with `--no-sandbox` on its
  command line. No remote debugging port is opened. Must be run with `--init`.
- Contains every system dependency the bundled skills need (the Phase 0
  report's "Tenant Image Requirements": LibreOffice, pandoc, poppler,
  tesseract, ffmpeg, CJK fonts, Debian `chromium`, and the skills Python venv).
  Phase 0's image was about 2.1 GB.

### Environment

| Variable | Required | Default | Meaning |
|----------|----------|---------|---------|
| `IDBOTS_SERVER_MODE` | yes | — | Must be `1`. |
| `IDBOTS_TENANT_ID` | yes | — | Opaque tenant ID from the control plane (`t_` plus 20 base32 characters). Logged with every line. |
| `IDBOTS_GATEWAY_SECRET` | yes | — | 32 random bytes, base64url. Required on every gateway request except `/healthz`. |
| `IDBOTS_GATEWAY_PORT` | no | `8790` | Gateway listen port inside the container. |
| `IDBOTS_GATEWAY_TIER` | no | `P1` | Highest allowlist tier enabled (`P1` or `P2`, see `02`). |
| `IDBOTS_USER_DATA_PATH` | no | `/data/userdata` | App user data (SQLite, skills, settings). |
| `IDBOTS_APP_DATA_PATH` | no | `/data/appdata` | App data. |
| `IDBOTS_WORKSPACE_PATH` | no | `/data/workspace` | Default and only allowed working directory root. |
| `IDBOTS_BOOTSTRAP_DISPLAY_NAME` | first boot | `IDBots User` | Name for the user identity (published on-chain). |
| `IDBOTS_BOOTSTRAP_LOCALE` | no | `zh` | `zh` or `en`; default UI and agent language. |
| `IDBOTS_BOOTSTRAP_TRAFFIC_REDEEM_CODE` | no | — | Single-use Metaso redeem code applied once on first boot (assigned to this user by the control plane). |
| `IDBOTS_METASO_API_BASE` | no | production URL | Metaso `assist-open-api` base URL (staging overrides it). |
| `IDBOTS_METASO_PARTNER_KEY` | no | — | Partner credential if WS-D requires one (REQ-D-6). |
| `TZ` | no | `Asia/Shanghai` | Time zone for scheduled tasks. |

Unknown `IDBOTS_*` variables are ignored. Secrets are never logged.

### Volume

The container mounts one named volume at `/data`:

```text
/data/userdata/    app user data (idbots.sqlite, SKILLs/, settings)
/data/appdata/     app data
/data/workspace/   agent working directory; uploads go to /data/workspace/uploads/
```

The volume is the only state. Deleting the container and starting the same
image (or a newer one) on the same volume must keep every user-visible piece
of data.

### Network

- Listens on `0.0.0.0:{IDBOTS_GATEWAY_PORT}` inside the container. No port is
  published on the host.
- Outbound internet is required (LLM, Metaso, MetaID, chains, skill
  downloads). Access to cloud metadata (`100.100.100.200`), private address
  ranges, and other tenants is blocked by WS-C.

### Resources (set by the control plane)

| Setting | Value |
|---------|-------|
| `--memory` | `2304m` (pptx peak 1630 MB × 1.3, rounded up to a multiple of 256. S05b's corrected web-search peak was 508 MB) |
| `--memory-swap` | `4608m` — the RAM cap plus up to 2304 MB of host swap, which the host backs with zram (CR-WSA-006). An idle tenant's cold memory compresses into it instead of pinning the host; the RAM cap itself is unchanged. On a host with no swap device the value is only an upper bound and changes nothing. |
| `--cpus` | `2` |
| `--pids-limit` | `2048` |
| `--shm-size` | `1g` (the value Phase 0 ran with) |
| `--cap-drop` | `ALL` |
| `--security-opt` | `no-new-privileges` |
| `--restart` | `unless-stopped` |
| Log driver | `json-file`, `max-size=20m`, `max-file=5` |

### HTTP Endpoints

All endpoints except `/healthz` require header
`X-IDBots-Gateway-Secret: {IDBOTS_GATEWAY_SECRET}` (compared in constant
time). A missing or wrong secret returns `401` with no body detail.

| Method and path | Purpose | Contract |
|-----------------|---------|----------|
| `GET /healthz` | Liveness | `200 {"ok":true}` once the process can answer; never blocks on the database |
| `GET /readyz` | Readiness | See below |
| `GET /gateway/v1/ws` | WebSocket gateway | C2 |
| `GET /gateway/v1/files/{token}` | Signed file download | C2 |
| `POST /gateway/v1/upload` | Attachment upload | C2 |
| `POST /gateway/v1/sensitive/reveal-mnemonic` | Mnemonic export | C2 |
| `GET /app/*` | Mobile web bundle (static) | C2 |

`GET /readyz` returns `200` when ready and `503` otherwise, always with:

```json
{
  "ready": true,
  "phase": "ready",
  "version": "0.12.0",
  "commit": "1a2b3c4…",
  "contractVersion": "1.0.0",
  "onboarding": {
    "identity": "done",
    "llmProvider": "done",
    "twinMetabot": "done",
    "workspace": "done",
    "trafficAccount": "done",
    "redeemCode": "skipped",
    "globalMetaId": "idq1…",
    "twinMetabotId": 1
  },
  "error": null
}
```

- `phase` is one of `starting`, `migrating`, `bootstrapping`, `ready`,
  `degraded`, `stopping`, `failed`.
- Each `onboarding` step is `pending`, `running`, `done`, `skipped`, or
  `failed`.
- `degraded` means ready for chat but an optional step failed (for example the
  redeem code); `error` then holds `{ "step": "...", "message": "..." }`.
- `failed` means the user cannot use the tenant; `error` explains why.

### Lifecycle

| Event | Requirement |
|-------|-------------|
| First start on an empty volume | `/healthz` within 60 s; `/readyz` ready within 300 s (includes the twin MetaBot's chain writes) |
| Restart on an existing volume | `/readyz` ready within 90 s |
| Bootstrap interrupted (crash, stop) | The next start resumes from the first step not `done`; no step runs twice with side effects |
| `SIGTERM` | Stops accepting gateway connections (close code 4012), finishes or checkpoints running turns, flushes SQLite, stops child processes, exits within 20 s |
| Upgrade (same volume, newer image) | Existing idempotent first-run migrations run before `ready`; no data loss |
| Downgrade | Allowed only to versions at or above `org.idbots.rollback-safe-to`; the control plane refuses others |

### Logs

One JSON object per line on stdout:
`{"ts":"…","level":"info|warn|error","tenant":"t_…","component":"…","msg":"…"}`.
No mnemonics, API keys, gateway secrets, phone numbers, or message contents.

---

## C2 — Gateway Protocol

How a client (the mobile app through the control plane) calls the tenant's
IPC handlers and receives its events. The control plane is a transparent
proxy for this protocol: it authenticates the user, adds the gateway secret,
and forwards frames unchanged.

### Transport and Authentication

- WebSocket at tenant path `/gateway/v1/ws` (public path `/ws` on the control
  plane, C3). Text frames only, UTF-8 JSON, one message per frame.
- Upstream headers added by the control plane:
  - `X-IDBots-Gateway-Secret` — required.
  - `X-IDBots-Client-Id` — opaque ID of the user's login session (stable
    across reconnects of the same login), used for logs and pending-state
    bookkeeping.
  - `X-Forwarded-For` — client IP.
- The tenant accepts at most 3 concurrent client sockets; a fourth is closed
  with code 4009.

### Frames

All frames carry `v: 1`. TypeScript notation:

```ts
// Server → client, first frame after the socket opens.
type Welcome = {
  v: 1; type: 'welcome';
  contractVersion: string;      // e.g. '1.0.0'
  appVersion: string;
  tenantId: string;
  serverTime: number;           // ms since epoch
  ready: boolean;               // same meaning as /readyz
  phase: string;
};

// Client → server.
type Invoke = {
  v: 1; type: 'invoke';
  id: string;                   // client-chosen, unique per socket, ≤ 64 chars
  channel: string;              // an allowlisted IPC channel, e.g. 'cowork:session:start'
  args: unknown[];              // positional arguments, exactly as the preload passes them
};

// Server → client, exactly one per Invoke.
type Result =
  | { v: 1; type: 'result'; id: string; ok: true; value: unknown }
  | { v: 1; type: 'result'; id: string; ok: false; error: GatewayError };

type GatewayError = { code: ErrorCode; message: string; retryable: boolean };

// Server → client, for every allowlisted main-process event.
type Event = {
  v: 1; type: 'event';
  channel: string;              // e.g. 'cowork:stream:message'
  args: unknown[];              // positional arguments as main sends them to renderers
};

// Either direction, application-level keepalive (optional; WebSocket pings are also used).
type Ping = { v: 1; type: 'ping'; ts: number };
type Pong = { v: 1; type: 'pong'; ts: number };
```

- `args` and `value` are the same values the desktop preload passes to and
  receives from `ipcRenderer.invoke`, after the existing `sanitizeIpcPayload`
  limits. The IPC handler sees a synthetic event object (see WS-A REQ-A-13),
  not a real `IpcMainInvokeEvent`.
- Results may arrive in any order. Events arrive in the order the main process
  emitted them on that socket.
- Every connected socket receives every allowlisted event. There is no
  per-channel subscription in version 1.

### Error Codes

| Code | Meaning | Retryable |
|------|---------|-----------|
| `CHANNEL_NOT_ALLOWED` | Channel is not in the allowlist | no |
| `CHANNEL_NOT_FOUND` | Allowlisted but no handler registered (a server bug) | no |
| `INVALID_FRAME` | Frame is not valid JSON or misses required fields | no |
| `INVALID_ARGS` | Arguments fail the channel's server-side validation | no |
| `ARG_RESTRICTED` | An argument points outside the tenant's allowed paths or uses a restricted field | no |
| `HANDLER_ERROR` | The handler threw; `message` is the error message | depends; `false` by default |
| `TIMEOUT` | No result within the channel's timeout | yes |
| `PAYLOAD_TOO_LARGE` | Inbound frame over the limit | no |
| `RATE_LIMITED` | Client exceeded the invoke rate | yes |
| `TENANT_NOT_READY` | Called a channel that needs `ready` before bootstrap finished | yes |
| `UPGRADING` | Server is shutting down for restart or upgrade | yes |

Handlers that already return `{ success: false, error }` keep doing so; that
is a successful `Result` with that value, not a gateway error.

### Limits

| Limit | Value |
|-------|-------|
| Inbound frame | 1 MiB (larger → `PAYLOAD_TOO_LARGE`, socket stays open) |
| Outbound frame | 8 MiB; larger event payloads are cut by `sanitizeIpcPayload` rules |
| In-flight invokes per socket | 32 |
| Invoke rate per socket | 50 per second, burst 100 |
| Default invoke timeout | 120 s |
| Long-running channel timeouts | `idbots:createMetaBotOnChain` 300 s; `chainBackup:backup` and `chainBackup:restore` 900 s; `gigSquare:sendOrder` 300 s; others listed in `02` |

Binary data never travels over the socket. Files go through the file and
upload routes; arguments that embed base64 are limited by the inbound frame
limit.

### Keepalive, Close Codes, and Reconnect

- The server sends WebSocket ping frames every 25 s and closes a socket that
  has not answered within 60 s.
- Close codes: `1000` normal, `1001` going away, `4001` unauthorized (control
  plane), `4003` origin not allowed (control plane), `4008` policy violation,
  `4009` too many clients, `4012` server restarting or upgrading, `4013`
  tenant not available (control plane: stopped, failed, or suspended).
- Client reconnect: exponential backoff 1, 2, 4, 8, 16, then every 30 s, with
  ±20% jitter; immediately on network change or app foreground.
- After every reconnect the client resynchronizes (WS-E REQ-E-5):
  1. `cowork:session:get` for the open session;
  2. `cowork:stream:liveContent` for any message still streaming (existing
     resync path);
  3. `mobile:permission:listPending` for permission requests it missed;
  4. refreshes of whatever list the current screen shows.

### Tool Permission Requests

- `cowork:stream:permission` events reach every connected client. Any client
  may answer with `cowork:permission:respond`; the first answer wins and
  `cowork:stream:permissionResolved` tells the others.
- `mobile:permission:listPending` (new, WS-A) returns
  `Array<{ sessionId: string; request: CoworkPermissionRequest; createdAt: number }>`
  so a reconnecting client can show requests it missed.
- Sessions started by scheduled tasks, long-term tasks, IM, and other
  background sources keep the existing unattended policy and never wait for a
  phone.

### File Download

1. The client calls `gateway:file:sign` (new, WS-A) with
   `[{ path: string; disposition?: 'inline' | 'attachment' }]`.
2. Result: `{ url: string; expiresAt: number; size: number; mime: string }`
   where `url` is `/files/{token}` relative to the control-plane origin.
3. `GET /gateway/v1/files/{token}` streams the file, honoring `Range`, with
   `Content-Type` from the extension and `Content-Disposition` from the token.

Rules:

- `path` must resolve (after `realpath`, following symlinks) inside `/data`;
  otherwise `ARG_RESTRICTED`.
- Token: `base64url(JSON.stringify({ p, d, e, t }))` + `.` +
  `base64url(HMAC-SHA256(gatewaySecret, payload))`, where `p` is the resolved
  path, `d` the disposition, `e` the expiry in ms (at most 10 minutes ahead),
  and `t` the tenant ID. A token for another tenant, an expired token, or a bad
  signature returns `404`.
- Desktop keeps `file://`; the renderer calls `resolveLocalFileUrl()` (WS-E
  REQ-E-7) which uses this route only on mobile.

### Upload

- `POST /gateway/v1/upload?name={urlencoded filename}` with the raw file bytes
  as the body and the file's `Content-Type`. Maximum 25 MB.
- Stored at `/data/workspace/uploads/{yyyy-mm-dd}/{uuid}-{sanitized name}`.
- Response `200 { "path": "/data/workspace/uploads/…", "size": 12345, "mime": "image/jpeg" }`.
  The client passes `path` wherever the desktop passes a local file path (for
  example message attachments or knowledge-base imports).
- Errors: `413` too large, `415` blocked type (executables), `507` volume
  quota exceeded.

### Sensitive Route: Mnemonic Export

Mnemonics never travel over the WebSocket. `userIdentity:revealMnemonic` and
`idbots:getMetaBotMnemonic` are not allowlisted.

- `POST /gateway/v1/sensitive/reveal-mnemonic` with body
  `{ "target": "user" }` or `{ "target": "metabot", "metabotId": 3 }` and
  header `X-IDBots-Reverify: {token}`.
- The control plane mints `token` only after a fresh SMS re-verification (C3):
  `base64url(JSON.stringify({ t, p: 'reveal-mnemonic', e, n }))` + `.` +
  `base64url(HMAC-SHA256(gatewaySecret, payload))`, with tenant ID `t`, expiry
  `e` at most 120 s ahead, and a random nonce `n`. The tenant rejects reused
  nonces (kept in memory until expiry).
- Response `200 { "mnemonic": "word1 … word12" }` with `Cache-Control: no-store`.
  Every call writes an audit line (tenant, target, time, client ID), never the
  mnemonic itself.

### Static Mobile Bundle

`GET /app/*` serves the mobile build output (`dist-mobile/`) baked into the
image, so the UI version always matches the backend. `index.html` is served
with `Cache-Control: no-cache`; hashed assets with
`Cache-Control: public, max-age=31536000, immutable`.

### Versioning

The `welcome` frame's `contractVersion` uses semantic versioning. A client
refuses to run against a different major version and shows "please update the
app". Minor versions add channels or optional fields only.

---

## C3 — Control-Plane Public API

Served by WS-B at `https://app.{APP_DOMAIN}` (staging:
`https://staging.{APP_DOMAIN}`). This is the only origin the phone talks to.

### Conventions

- JSON request and response bodies. Errors:
  `{"error":{"code":"…","message":"…"}}` with the HTTP status shown below.
- Session cookie `idb_session`: random 32 bytes, base64url; `HttpOnly`;
  `Secure`; `SameSite=Strict`; `Path=/`; 30-day sliding expiry. Stored only as
  a SHA-256 hash.
- State-changing requests and WebSocket upgrades must carry an `Origin` equal
  to the deployment origin; otherwise `403 ORIGIN_NOT_ALLOWED` (WebSocket:
  close 4003).
- Phone numbers are mainland China mobile numbers in E.164 form
  (`+861xxxxxxxxxx`) in this release.

### Endpoints

| Method and path | Auth | Request | Success | Errors |
|-----------------|------|---------|---------|--------|
| `GET /` and `GET /login` | none | — | Login page (static, built by WS-E) | — |
| `POST /api/v1/auth/sms/send` | none | `{ phone, purpose: 'login' }` | `200 { resendAfterSec: 60 }` | `400 INVALID_PHONE`, `429 RATE_LIMITED` |
| `POST /api/v1/auth/sms/verify` | none | `{ phone, code, inviteCode?, displayName? }` | `200 { user, tenant }` and the cookie | `400 CODE_INVALID`, `400 CODE_EXPIRED`, `403 INVITE_REQUIRED`, `403 INVITE_INVALID`, `403 INVITE_EXHAUSTED`, `403 USER_DISABLED`, `429 TOO_MANY_ATTEMPTS` |
| `GET /api/v1/me` | cookie | — | `200 { user, tenant }` | `401 UNAUTHORIZED` |
| `POST /api/v1/auth/logout` | cookie | — | `204`, cookie cleared | — |
| `POST /api/v1/reverify/send` | cookie | `{ purpose: 'reveal-mnemonic' }` | `200 { resendAfterSec: 60 }` | `429 RATE_LIMITED` |
| `POST /api/v1/reverify/verify` | cookie | `{ purpose: 'reveal-mnemonic', code }` | `200 { reverifyId, expiresAt }` (valid 120 s, single use) | `400 CODE_INVALID`, `429 TOO_MANY_ATTEMPTS` |
| `POST /api/v1/sensitive/reveal-mnemonic` | cookie | `{ reverifyId, target: 'user' } \| { reverifyId, target: 'metabot', metabotId }` | `200 { mnemonic }`, `Cache-Control: no-store` | `403 REVERIFY_REQUIRED`, `409 TENANT_NOT_READY` |
| `POST /api/v1/account/deletion-request` | cookie | `{ reason? }` | `202 { requestId }` | — |
| `GET /ws` | cookie | WebSocket upgrade | Proxied to C2 | Close `4001`, `4003`, `4013` |
| `GET /files/{token}` | cookie | — | Proxied to the tenant file route | `404` |
| `POST /upload?name=` | cookie | raw body | Proxied to the tenant upload route | `413`, `415`, `507` |
| `GET /app/*` | cookie | — | Proxied to the tenant static bundle; redirect to `/login` without a cookie | — |
| `GET /health` | none | — | `200 { ok, db, docker }` | `503` |

Objects:

```ts
type User = { id: string; phoneMasked: string; createdAt: number; locale: 'zh' | 'en' };
type Tenant = {
  status: 'provisioning' | 'booting' | 'onboarding' | 'ready' | 'degraded'
        | 'upgrading' | 'stopped' | 'failed' | 'suspended';
  phase: string | null;          // tenant /readyz phase while booting or onboarding
  appVersion: string | null;
  contractVersion: string | null;
  error: string | null;          // user-safe message for 'failed'
};
```

### Behavior

- `displayName` (1–24 characters, optional, used only at sign-up) becomes the
  tenant's `IDBOTS_BOOTSTRAP_DISPLAY_NAME`, which is published on-chain; it is
  never derived from the phone number.
- `sms/verify` for a phone with no account requires `inviteCode`. On success
  the control plane creates the user, consumes one invite use, and starts
  provisioning; `tenant.status` is `provisioning`. The client polls
  `GET /api/v1/me` every 3 s until `ready` or `degraded`, then opens `/app/`.
- Rate limits: SMS send 1 per 60 s and 10 per day per phone; 30 per day per
  IP; verify 5 attempts per code; 20 failed verifies per phone per day locks
  the phone for 24 h.
- `sensitive/reveal-mnemonic` turns `reverifyId` into the C2 reverify token and
  calls the tenant route; the mnemonic passes through without being logged or
  stored.
- `account/deletion-request` records a request for an operator; the operator
  exports the user's data on request and deletes the tenant and volume
  (runbook in WS-C).

---

## C4 — Metaso Bundle API

Additions to Metaso `assist-open-api` (production base
`https://www.metaso.network/assist-open-api`; staging base provided by WS-D).
Everything here follows the existing traffic API conventions: envelope
`{ "code": 0, "message": "ok", "data": … }`, identity headers
`X-Identity-Address`, `X-Timestamp` (seconds, ±300 s), and `X-Signature`
(BTC-style signed message, base64, signed by the user identity key
`m/44'/10001'/0'/0/0`).

### Existing Endpoints Used Unchanged

- Traffic account: `POST /v1/traffic/accounts`, bindings, balance, ledger,
  usage, pricing, recharge orders, free-grant status and claim, redeem code.
- LLM relay: `POST /v2/assist/llm/bootstrap` and `GET /v2/assist/llm/quota`.

### New: Bundle Plans

`GET /v1/bundle/plans` (no signature)

```json
{
  "code": 0, "message": "ok",
  "data": [
    {
      "planId": "bundle_basic_cny",
      "name": "基础包", "nameEn": "Basic",
      "payCurrency": "CNY", "payAmount": "19.90",
      "trafficBytes": 104857600,
      "llmQuota": 2000000, "llmQuotaUnit": "tokens",
      "status": 1, "sort": 10, "remark": ""
    }
  ]
}
```

`status` `1` means on sale. Amounts are decimal strings.

### New: Bundle Orders

`POST /v1/bundle/orders`, signed message
`bundle-order:{accountId}:{planId}:{timestamp}` (same pattern as
`traffic-recharge:{accountId}:{planId}:{timestamp}`)

Request `{ "planId": "bundle_basic_cny", "gateway": "alipay" }` (`"mock"` only
where `traffic.mock_payment_enabled` is on). The traffic account is resolved
from the identity headers, as for recharge orders.

Response `data`:

```json
{
  "orderId": "bo_…",
  "planId": "bundle_basic_cny",
  "payAmount": "19.90", "payCurrency": "CNY",
  "trafficBytes": 104857600, "llmQuota": 2000000,
  "gatewayParams": { "qrCode": "https://qr.alipay.com/…", "alipayOutTradeNo": "…" },
  "expiresAt": 1760000000
}
```

`GET /v1/bundle/orders/{orderId}` (no signature, same as recharge order
status; order ids are unguessable)

Response `data`: `{ orderId, planId, status, payAmount, trafficBytes, llmQuota, paidAt, creditedAt }`
with `status` `1` created, `2` paid, `3` credited, `4` closed (same codes as
traffic recharge orders).

`POST /v1/bundle/orders/{orderId}/mock-confirm` exists only where
`traffic.mock_payment_enabled` is on (staging), like the recharge
mock-confirm.

### Crediting Rules

- The Alipay webhook marks the order paid; crediting adds `trafficBytes` to
  the traffic account and `llmQuota` to the identity's LLM quota in one
  transaction. Repeated webhooks never credit twice.
- The client polls the order every 4 s for up to 10 minutes (existing traffic
  pattern). Unpaid orders are closed by the existing expiry janitor (about
  24 h), which also calls `alipay.trade.close`.

### Changed: LLM Quota Is Bound to the Identity

- Free and purchased LLM quota belong to the identity address, not to an API
  key. Every key issued by `bootstrap` for the same identity draws from the
  same pool. Re-bootstrapping (for example after a tenant is rebuilt from a
  backup) never loses purchased quota.
- `GET /v2/assist/llm/quota` adds fields:
  `{ quotaTotal, quotaUsed, quotaRemaining, quotaFree, quotaPurchased, unit: "tokens" }`.
- When the pool is empty the relay keeps today's signal, HTTP `429` with an
  OpenAI-style error body, so desktop builds already in the field keep
  working: code `free_quota_exhausted` when the identity has never had
  purchased quota (unchanged), and code `quota_exhausted` when purchased quota
  is used up (new).
- New `GET /v2/assist/llm/ledger?limit=50&cursor=…` (Bearer relay key, or
  identity headers signing `llm-relay-ledger:{identityAddress}:{timestamp}`)
  returns `{ items: [{ at, kind: 'grant' | 'purchase' | 'usage', amount, model?, orderId? }], nextCursor }`;
  `usage` items may be aggregated per day and model.

### Partner Policy for the Hong Kong Egress

All tenants reach Metaso from one or two egress IP addresses (published by
WS-C). Per-IP limits on bootstrap, free grants, and gas subsidy must not block
at least 50 new identities per day and 500 in total from those addresses.
Per-identity limits stay in force. WS-D chooses the mechanism (IP allowlist,
partner key in `IDBOTS_METASO_PARTNER_KEY`, or both) and documents it here
through change request CR-1 (contract version 1.1.0) before M2.
