# CR-WSE-005: Mobile Invite-Only Registration, Trial Grant & Weekly Refill Channels

- **Status**: Proposed (implemented on `feat/mobile-invite`)
- **Affected frozen contracts**:
  - `docs/cloud-mobile/01-interface-contracts.md` (C3 Control Plane Auth + internal `/api/v1/tenant/*` routes)
  - `docs/cloud-mobile/02-ipc-allowlist-v1.md` (C2 Gateway Invoke Allowlist)
- **Author**: WS-E / WS-C / WS-A
- **Date**: 2026-04-20

## Motivation

Mobile users run on dedicated cloud tenant containers (`2304 MB` RAM per tenant). To protect server capacity while enabling controlled viral growth, mobile onboarding requires:
1. Invite-only signup for new phone numbers with a configurable daily capacity cap and real Alibaba Cloud SMS delivery.
2. Automatic first-boot activation of a configurable ME subscription trial (`ID.Student · 14 days` by default, `sourceType = 'invite_trial'`) inside the tenant container using the user's locally generated MetaID identity.
3. A mobile-only Invite Center (`Me -> Invite Friends`) where eligible users (active veterans or paid subscribers) can generate their invite code, share dual-theme posters, and claim earned "Immediate Weekly Quota Refill" rewards when invited friends activate their cloud bots.
4. Post-trial container hibernation (`> 7` days after trial expiry without a paid subscription) preserving `/data` and waking transparently on login or traffic.

## Additive Contract Changes

### 1. C3 Control Plane Public & Tenant Endpoints (Additive)

- `GET /api/v1/auth/invite/preview?code=<CODE>` (unauthenticated, rate-limited):
  - Previews invite validity, daily capacity status, and granted trial plan/duration (`valid`, `reasonCode`, `code`, `planId`, `planName`, `planNameEn`, `periodDays`, `dailyCapFull`).
- `POST /api/v1/auth/sms/send` (backward-compatible optional field):
  - Accepts optional `inviteCode?: string`. For existing phones, sends login SMS directly. For new phones when ABS invite partner config is enabled, pre-validates `inviteCode` and daily cap before sending SMS so invalid codes or full daily caps never burn SMS quota or invite uses. Surfaces real delivery errors (`502 SMS_SEND_FAILED`) and rolls back rate-limit counters on provider failure.
- `GET /api/v1/tenant/invite-grant/pending` & `POST /api/v1/tenant/invite-grant/claimed`:
  - Internal tenant-authenticated (`Authorization: Bearer <IDBOTS_GATEWAY_SECRET>` + `X-Tenant-Id`) endpoints modeled on `/api/v1/tenant/credit/*`, blocked at the public Caddy edge (`@tenantCredit path /api/v1/tenant/*`).

### 2. C2 Gateway Invoke Allowlist (Additive P1 Channels)

All signing uses the main-process local user identity (`me:<action>:<tsSeconds>`); mnemonics never cross IPC or the mobile gateway:

| Channel | Tier | Restrictions | Purpose |
| --- | --- | --- | --- |
| `me:getInviteStatus` | `P1` | — | Read invite eligibility progress, issued invite codes, invitee activation status, and available weekly refill count. |
| `me:generateInviteCode` | `P1` | — | Issue a single-use invite code for an eligible identity. |
| `me:claimInviteRefill` | `P1` | — | Redeem one earned weekly quota refill opportunity to restore current-cycle `remainingMilli` to `amountMilli`. |

## Security & Compatibility Notes

- Existing `sendCode(phone, purpose)` callers without `inviteCode` remain wire-identical.
- `SERVER_BOOTSTRAP_ONBOARDING_STEP_IDS` in C1 `/readyz` is untouched; `inviteGrantPullService` runs alongside `creditPullService` in server mode and triggers immediately once `serverBootstrapRun.finished` resolves.
- `invite_trial` subscriptions carry `isTrial: true` and `sourceType: "invite_trial"` from ABS so they never unlock paid-subscriber invite privileges or cash upgrade proration credits.
