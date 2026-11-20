# CM0/CM1 Notification Foundation and CM4 Login Experience — Delivery Note

- **Branch:** `feat/mobile-notification-foundation`
- **Scope:** CM0 contract/storage, CM1 inbox/deep links, and CM4 login/cold-start/information hierarchy
- **Production deployment:** not performed from this branch; merge and deployment must use the reviewed `main` commit

## Delivered

### CM0 — Contract and persistent event foundation

- Added CR-WSE-002 for notification IPC and CR-WSE-003 for staged Bot automation parity.
- Added idempotent `notification_events` and `notification_outbox` migrations with stable event IDs and dedupe.
- Added cowork terminal, scheduled-run terminal, and permission request/resolved producers. Recording is best-effort and never blocks Agent execution.
- Added notification list/get/unread/read APIs, `notification:changed`, P1 gateway rules, and generated IPC contract 1.1.0.

### CM1 — Notification center and deep links

- Added unread bell, filtered inbox, Me entry, mark-read/mark-all-read, and automatic read-through for the currently visible session.
- Added typed notification targets for sessions, long-term tasks, and scheduled runs. Taps open existing result/permission surfaces; they never approve an action.
- Added direct notification URLs, SPA fallbacks, controller-ready handling, and control-plane login return paths.
- Added mock notification production for completed scheduled runs and permission lifecycle events.

### CM4 — Login, cold start, and daily information hierarchy

- React now mounts while remote settings hydrate in the background; a disconnected settings read cannot hold the splash for the gateway's offline timeout.
- Added visible login labels, field-level errors, phone/code autocomplete, async button states, safe preparing progress, elapsed time, retry, and support navigation.
- Preserved sanitized notification/session return paths through sign-up, session recovery, and unauthorized redirects.
- Legal/support URLs now follow the deployed environment instead of pinning production to staging.
- The Me primary page uses a compact plan/balance row. The full points hero, ledger, upgrade/renew, and top-up actions live on Usage.
- Fixed Usage purchase return navigation, subscription refresh, order-list refresh, and mock order-array serialization so purchase/order recovery stays live.
- Split login copy into a shared canonical dictionary used by both App and login. Production login bundle is 55.0 KB gzip, within the 80 KB budget.

## Verification

| Check | Result |
|---|---|
| Notification storage/main/contract focused tests | 16/16 passed |
| Full `test:mobile` | 466 unit tests + 8 static tests passed, zero failures |
| Control-plane full suite | 233/233 passed |
| Notification + login return-path E2E (iPhone/WebKit) | 5/5 passed |
| Notification + login return-path E2E (Pixel/Chromium) | 5/5 passed |
| Me / settings / purchase E2E (iPhone/WebKit) | 17/17 passed |
| `build:mobile` | Passed; login 55.0 KB gzip, App initial JS 122.6 KB gzip, mock notice and Twemoji checks passed |
| `compile:electron` | Exit code 0 |
| DSH dependency and kernel-patch checks | Passed |
| Control-plane ESLint | Passed |
| `git diff --check` | Passed |

## Boundaries and follow-up

- CM2 native device registration, FCM/APNs/OEM delivery, and physical-device push acceptance are not implemented or claimed here.
- CM3 Surf, daily-report, and broader Bot automation settings are documented through CR-WSE-003 but not part of this implementation.
- No physical-device, real-tenant, or production push-provider acceptance was run.
- Root `pnpm run lint` is red on the pre-existing unrelated `src/main/services/walletTxStatusService.ts:410` unused disable directive. The changed TypeScript files and control-plane lint pass.
- Local worktree dependency installation used `ELECTRON_SKIP_BINARY_DOWNLOAD=1` after repeated Electron/CDN timeouts. This was environment-only and was not used for packaging or deployment.
