# Backend Requirements — ME Subscription Checkout and Plan Catalog (assist-base-service)

## Status

Draft v0.1 for backend development, 2026-11-07. Requested by the IDBots desktop team as the blocking dependency of the Settings > Models > ID.Bots Subscription checkout. Target project: `assist-base-service` (the ME service behind `/v1/me/*`).

This document is a requirements contract, not an implementation spec. The client side already ships against the S9-A contract (`src/main/services/mePointsService.ts`, `src/renderer/components/me/MePurchaseFlow.tsx`, pinned by `tests/meSubscriptionOrder.test.mjs`); what is missing is server-side deployment, not client work.

## 1. Background and problem

The desktop purchase panel (upgrade / renew) is fully wired: the user picks a plan and period, picks Alipay or PayPal, and the client POSTs a signed order, opens the returned approval URL or shows the QR, then polls order status until the payment is credited — exactly the flow already live for ME top-up (`/v1/me/topup/orders`).

Today clicking "前往支付" fails with `支付订单处理失败：ME service returned invalid JSON (HTTP 404)`. Root cause: `POST /v1/me/subscription/order` is not implemented on the server, and the server answers with an HTML 404 page instead of the JSON envelope, which the client reports as "invalid JSON". The plan catalog likewise lacks the free tier and (in part) the discount fields the panel's price display reads.

Goal: make subscription checkout work end to end, reusing the existing top-up payment-gateway integration, and complete the plan catalog.

Non-goals: the manual voucher channel (S9 §5) is unchanged; no new auth model (signed identity headers as today); the client never sends prices and the server must continue to price every order itself.

## 2. R1 — Plan catalog (`GET /v1/me/plans`)

### R1.1 ID.Free tier entry

Add the free tier to the catalog (or confirm it is intentionally client-side; the server entry is preferred as the single source of truth):

| Field | Value |
|---|---|
| `tier` | `free` |
| `name` | `ID.Free`（`nameEn: "ID.Free"`） |
| `priceCny` | `0` |
| `weeklyAmountMilli` | `2000000`（= 2000 ME/周） |
| `saleStatus` | `1`（可见） |

The client renders a local fallback with exactly these values when the entry is absent, so this is a data-completion requirement, not a display blocker. **A free-tier planId must never be orderable** — see R2.4.

### R1.2 Discount fields for paid plans

The panel renders a product-style price tag (current price + struck-through original + discount badge + per-month equivalent) from these per-plan fields:

| Field | Meaning | Example |
|---|---|---|
| `desktopPriceCny` / `priceCny` | Monthly price in CNY (desktop price wins when both exist) | `100` |
| `quarterlyDiscountPct` | Percent of the full quarterly price (monthly × 3) actually charged; `90` = pay 90%. Absent/`0`/`100` = no discount | `90` |
| `annualPriceCny` | Absolute annual price in CNY; compared against monthly × 12 | `960` |
| `weeklyAmountMilli` | Weekly ME grant in milliME | `5000000` |

The client computes: quarter price = `round(monthly × 3 × pct / 100)` with original `monthly × 3`; year price = `annualPriceCny` with original `monthly × 12`; the original price is only shown when it is strictly greater. Server-side order pricing (R2) must use the same arithmetic so the amount the user saw matches the amount charged.

## 3. R2 — Create subscription order (`POST /v1/me/subscription/order`)

Contract already shipped by the client (S9-A §1.6); implement to match exactly.

### Request

Signed identity headers as today: `X-Identity-Address`, `X-Timestamp` (ms), `X-Signature` over `me:subscription_order:<timestamp>`.

```json
{
  "planId": "me_standard",
  "period": "month | quarter | year",
  "channel": "desktop | cloud | mobile",
  "gateway": "alipay | paypal",
  "idempotencyKey": "desktop-subscribe-me_standard-month-1730…"
}
```

The client sends **no amount**. The server prices the order from `planId` + `period` + `channel` (S9-A §1.3) using R1.2 arithmetic, and must reject any client-supplied amount field rather than trust it.

### Response

Standard `{code, message, data}` envelope; `code: 0` with:

```json
{
  "orderId": "…",
  "planId": "me_standard",
  "period": "quarter",
  "channel": "desktop",
  "status": "created",
  "amountCny": 270,
  "payAmount": 270,
  "payCurrency": "CNY",
  "gatewayParams": { "…": "…" },
  "createdAt": 1762500000000
}
```

### gatewayParams (R2.1)

The client checkout extracts, in this key order:

- approval URL: `approvalUrl`, `approval_url`, `approveLink`, `approve_url`, `paymentUrl`, `payment_url`
- QR content: `qrCode`, `qr_code`, `qrCodeContent`, `codeUrl`, `code_url`

`gateway: "alipay"` → provide `qrCode`/`code_url` (native QR string or https URL; the client renders https URLs as both QR and a reopen link) and/or a `paymentUrl`. `gateway: "paypal"` → provide the PayPal `approvalUrl`. At least one of the two must be present or the client treats the order as unusable.

### R2.2 Idempotency and retries

The client retries the POST once on transient network failure **with the same `idempotencyKey`**. The server must deduplicate: the same `(identity, idempotencyKey)` returns the original order instead of creating a second one.

### R2.3 Gateway integration

Reuse the existing top-up / traffic-recharge Alipay + PayPal integration (same merchants, same async callback pipeline). CNY is the pricing currency for every plan; for PayPal, charge the CNY-equivalent and report the settled `payAmount`/`payCurrency` back on the order.

### R2.4 Free tier is not orderable

A POST whose `planId` resolves to a `tier: "free"` plan must be rejected with the standard error envelope (suggest `errorCode: "PLAN_NOT_PURCHASABLE"`). The client hides the CTA for the free tier, but the server must enforce this independently.

## 4. R3 — Order status polling (`GET /v1/me/subscription/order/{orderId}`)

Same signed auth. Returns the same order view as R2. The client maps `status` to a payment phase:

| Client phase | Accepted statuses |
|---|---|
| credited (stop polling, refresh subscription) | `confirmed`, `credited`, `active`, `completed`, `3` |
| closed (terminal) | `closed`, `rejected`, `expired`, `cancelled`, `canceled`, `failed`, `4` |
| pending (keep polling) | anything else (`created`, `submitted`, `paid`, …) |

Only the confirmed-payment path opens the subscription (spec §2) — a created/paid order must not grant quota early.

## 5. R4 — Error semantics

- Non-2xx responses must return the standard **JSON** envelope (`{code, message, data}`), never an HTML error page. HTML bodies surface to users as "ME service returned invalid JSON (HTTP 404)", which hides the real cause.
- "Feature not deployed / not configured" should map to HTTP 404 **with** a JSON envelope carrying a machine-readable `data.errorCode`, matching the existing convention (e.g. `SUBSCRIPTION_REQUIRED`); the client already special-cases known codes and shows a generic localized message otherwise.
- Order pricing/validation failures (unknown planId, inactive plan, bad period) → 400 + `errorCode`.

## 6. Acceptance checklist

1. `GET /v1/me/plans` returns ID.Free (tier `free`, weekly 2000 ME) plus paid plans carrying `quarterlyDiscountPct` / `annualPriceCny` where discounts apply.
2. Desktop: upgrade panel → pick ID.Pupil → 季付 → the tag shows the discounted price, the struck-through original and the discount badge; 前往支付 with Alipay returns an order whose `gatewayParams.qrCode` renders a scannable QR; with PayPal returns an `approvalUrl` that opens the PayPal checkout.
3. After paying, the 4s poller observes `status` transition to a credited value and the subscription activates without a second confirmation step for the user.
4. Replaying the same `idempotencyKey` never creates a second order.
5. POST with a free-tier `planId` is rejected with a JSON error envelope.
6. `POST /v1/me/subscription/order` before gateway configuration exists returns a JSON 4xx/5xx (not an HTML page).

## 7. Client reference (IDBots repo, for contract cross-checking)

- `src/main/services/mePointsService.ts` — endpoint constants (`ME_SUBSCRIPTION_ORDER_PATH = '/v1/me/subscription/order'`), signing, normalization, "invalid JSON" error origin.
- `src/renderer/components/me/MePurchaseFlow.tsx` — panel UX: plan cards (ID.Free + 3 paid tiers), period + gateway selectors, price tag with original/discount, QR/approval-URL checkout, 4s polling for 10 minutes.
- `src/renderer/components/me/mePayment.ts` — `gatewayParams` extractors, status→phase mapping, period-pricing arithmetic (must stay in sync with server pricing).
- `tests/meSubscriptionOrder.test.mjs`, `tests/meDesktopPayment.test.ts` — contract pins.

---

## Amendment v0.2 — uniform monthly-rate pricing (2026-11-07, owner decision)

**Supersedes the R1.2 pricing arithmetic and §6 item 2's "original price" reading.** The price tag now always shows a per-month rate, and every tier uses the same discount rule — the per-plan `quarterlyDiscountPct` / `annualPriceCny` fields are **no longer read for pricing** (they may stay in the catalog; harmless).

### New pricing rule (owner: 2026-11-07)

| Period | Billed months | Discount off monthly price | Formula (one-payment total) |
|---|---|---|---|
| month | 1 | none | `monthly` |
| quarter | 3 | 10% off (9折) | `round2(monthly × 3 × 0.90)` |
| year | 12 | 20% off (8折) | `round2(monthly × 12 × 0.80)` |

`round2` = round half-up to 2 decimals (cents). The client displays `round2(monthly × pct)` as the monthly rate (e.g. ID.Pupil quarterly: **¥44.1/月**, struck-through `¥49`, badge `9折`, lump-sum line "一次性支付 3 个月，合计 ¥132.3"). The client `mePayment.ts` (`mePeriodPricing`, constants 90/80) already implements exactly this — the server must match to the cent.

### Required server change (assist-base-service)

Rewrite `service/me_service/subscription_order_service.go` `PriceSubscriptionOrderCny` (currently: quarter = `math.Round(monthly×3×pct/100)` from the plan's `quarterlyDiscountPct`, year = the plan's absolute `annualPriceCny`):

```go
// Owner pricing rule (2026-11-07): uniform monthly-rate model — the tag
// shows a per-month rate; quarter bills 3 months at 90%, year 12 at 80%.
const (
	subscriptionQuarterDiscountPct = 90
	subscriptionYearDiscountPct    = 80
)

func round2Cny(v float64) float64 { return math.Round(v*100) / 100 }

func PriceSubscriptionOrderCny(plan *models.MePlanModel, period string) (float64, error) {
	monthly := SubscriptionMonthlyCny(plan)
	if monthly <= 0 {
		return 0, ErrSubscriptionPriceBad
	}
	switch period {
	case SubscriptionPeriodMonth:
		return monthly, nil
	case SubscriptionPeriodQuarter:
		return round2Cny(monthly * 3 * subscriptionQuarterDiscountPct / 100), nil
	case SubscriptionPeriodYear:
		return round2Cny(monthly * 12 * subscriptionYearDiscountPct / 100), nil
	default:
		return 0, ErrInvalidPeriod
	}
}
```

Then update the pricing expectations in `service/me_service/subscription_order_test.go`, run the full `go test ./...`, rebuild and **redeploy** per the release SOP. Everything else (endpoints, auth, idempotency, gatewayParams, status semantics, free-tier rejection) is unchanged.

### Amounts under the new rule (desktop monthly price 49 / 149 / 449)

| Tier | 月付 | 季付 tag | 季付 charged | 年付 tag | 年付 charged |
|---|---|---|---|---|---|
| ID.Pupil | ¥49/月 | ¥44.1/月 (~~¥49~~ 9折) | **¥132.3** | ¥39.2/月 (~~¥49~~ 8折) | **¥470.4** |
| ID.Student | ¥149/月 | ¥134.1/月 | **¥402.3** | ¥119.2/月 | **¥1430.4** |
| ID.Scholar | ¥449/月 | ¥404.1/月 | **¥1212.3** | ¥359.2/月 | **¥4310.4** |

Note the deltas vs the currently deployed build: quarter totals gain a `.3`/`.1` cent remainder (exact 90% instead of integer rounding: 132 → 132.3 etc.) and the annual totals change outright (899 → 470.4, 1799 → 1430.4, 4499 → 4310.4) — the old `annualPriceCny` values are retired. **Until the server ships this amendment, the client tag and the charged amount will disagree for quarter/year; deploy both sides together.**

### Acceptance addendum

7. Quarterly/yearly order amounts equal `round2(monthly × months × 0.90/0.80)` exactly (e.g. ID.Pupil quarter order `amountCny = 132.3`), matching the client price tag and lump-sum line.


---

## Amendment v0.3 — subscription order list endpoint (2026-11-07)

**Adds one read endpoint; nothing else changes.** The desktop 用量&积分 page now renders a merged payment-records list (subscription + topup orders). The client side is already shipped against this contract and degrades to topup-only until the endpoint exists (404 → silent degradation, no error shown).

### R5 — `GET /v1/me/subscription/orders`

Owner-scoped list of the caller's subscription orders, newest first.

- Auth: same signed identity headers as every `/v1/me/*` endpoint, action **`subscription_order`** (reuse the checkout family action — the poll already proves it works; do NOT invent a new action).
- Route: register as `me.GET("/subscription/orders", ...)` alongside the existing `me.GET("/subscription/order/:orderId", ...)` — static `orders` vs param `order/:orderId` do not conflict in Gin, but verify the router accepts both.
- Optional query: `limit` (int, default 100, cap 500), `status` filter (optional; values as stored).
- Response: standard envelope, `data = { "orders": [ <order view>... ] }` where each element is the exact R2/R3 order view (`orderId, planId, period, channel, status, amountCny, payAmount, payCurrency, gatewayParams, createdAt, ...`). `gatewayParams` should ride along (the client does not need it in the list, but replay symmetry is free). Sort by `createdAt` desc. Empty list = `{orders: []}` with `code: 0` (never an error).
- The client reads `data.orders` (also tolerates `entries/items/list/records/rows` array keys) and normalizes with the same field aliases as R2.

### Acceptance addendum

8. `GET /v1/me/subscription/orders` signed with action `subscription_order` returns the caller's orders (and only theirs) sorted newest-first; an identity with no orders gets `{code: 0, data: {orders: []}}`; an unsigned request gets the standard JSON auth error.

---

## Amendment v0.4 — plan-change policy: upgrade proration, downgrade guard, renewal semantics (2026-11-11)

**Owner policy 2026-11-11.** The client now ships the matching UI slice on `feat/subscription-credits-hardening` (MePurchaseFlow two-step upgrade confirm, tier-ladder downgrade lock, proration display readiness in `mePayment.ts extractMeProration`). What is missing is server behavior — the items below are **requirements for assist-base-service**, not implemented anywhere yet.

### R6 — Upgrade proration (折抵)

When a signed order's plan ranks **above** the caller's currently-active subscription plan (ladder `free < standard < pro < max`), the server MUST price the order as:

```
listAmount = PriceSubscriptionOrderCny(newPlan, period)        // v0.2 rule
remaining  = ceil((activePlan.applicableEnd - now) / 86400000) // clamp to [0, …]
credit     = round2(activeChannelMonthlyCny × remaining / 30)  // single rounding, generous-to-user ceil on days
payAmount  = max(0, round2(listAmount - credit))
```

- `activeChannelMonthlyCny` = the ACTIVE plan's monthly price **for the order's channel** (see R10).
- The credit applies to every period (month/quarter/year); a credit ≥ listAmount yields `payAmount = 0` and the order flows straight to `credited` without a gateway round-trip (do not create a 0-amount Alipay charge).
- Response carries the breakdown so clients can render it:

```json
{
  "orderId": "…", "planId": "me_pro", "status": "created",
  "payAmount": 366.15,
  "breakdown": { "listAmountCny": 402.3, "creditCny": 36.15 },
  "proration": { "sourcePlanId": "me_standard", "remainingDays": 22 }
}
```

- `breakdown`/`proration` are absent (not zero) when no credit applies. The client renders the credit line only from these fields and never computes a credit itself.
- Idempotency replay (R2.2) must return the original order with its original breakdown — the credit must not re-compute on replay.

**Client status:** display-ready (`extractMeProration` reads `breakdown.listAmountCny/list_amount_cny/listPriceCny` + `creditCny/credit_cny/prorationCreditCny`); until this ships, the client shows a full-price notice before every upgrade order.

### R7 — Downgrade guard (server-side)

An order whose plan ranks **below** the caller's active plan MUST be rejected with the standard JSON envelope, HTTP 400, `data.errorCode: "PLAN_DOWNGRADE_NOT_ALLOWED"`. The client already blocks downgrades in the UI (tier-ladder lock, desktop + mobile); this is the defense-in-depth half. Same-tier orders (renewals) and higher-tier orders are unaffected.

### R8 — Renewal & plan-change activation semantics

Pin the previously undefined behaviors:

1. **Same-plan order while active = 顺延**: the new period extends from the CURRENT expiry (never truncates remaining days, never restarts early).
2. **Higher-plan order while active = immediate switch**: the new plan activates once the payment is credited; the old plan's remaining value is settled exclusively via the R6 credit (no double-charge, no lost days).
3. **No mid-period downgrade path exists** (R7). Tier changes downward happen only by letting the subscription lapse to free and subscribing again.

### R9 — `INSUFFICIENT_ME` error code on ME spend paths

Every ME spend path (pay / freeze / burn / metering) MUST return the machine-readable `data.errorCode: "INSUFFICIENT_ME"` when spendable ME is below the required amount (grant-only when `autoDeductFromPersistent=false`, grant+persistent when true). The mobile client ships a dedicated ME-exhausted card keyed on this code today (`src/mobile/app/quotaCodes.ts`) and it is dead code until the server emits it — ME exhaustion currently surfaces as an unspecific error.

### R10 — Per-channel price discipline

Plan rows carry `priceCny` (mobile/cloud list price) and `desktopPriceCny`; `PriceSubscriptionOrderCny` MUST price each order by its OWN channel's monthly price (`channel: "desktop"` → `desktopPriceCny ?? priceCny`, `channel: "mobile"|"cloud"` → `priceCny`). Clients render their channel's price tag (desktop card: `desktopPriceCny ?? priceCny`; mobile cards: `priceCny` — labeled 移动端价). The mobile tag and the mobile QR amount diverging (release-review P1, 2026-11-10) is a symptom of this rule not being pinned; R6's `activeChannelMonthlyCny` inherits the same rule.

### Acceptance addendum (v0.4)

9. An active ID.Pupil (desktop ¥49, 22 days left) ordering ID.Student quarter (list ¥402.3) gets `payAmount = 402.3 − round2(49 × 22 / 30) = 366.4` with `breakdown.creditCny = 36.0`; the client paying page shows the credit line.
10. An order for a plan below the active tier returns HTTP 400 + `PLAN_DOWNGRADE_NOT_ALLOWED`.
11. Same-plan renewal extends from the current expiry; replaying the order's idempotencyKey returns the original order and never recomputes the proration.
12. Any ME spend with insufficient spendable ME returns `INSUFFICIENT_ME`.
13. Mobile-channel orders are priced by `priceCny`, desktop-channel orders by `desktopPriceCny ?? priceCny` (per-channel tags match the charged amounts on both clients).

### Client reference additions (v0.4)

- `src/renderer/components/me/MePurchaseFlow.tsx` — two-step upgrade confirm (`me-upgrade-confirm`), tier-ladder downgrade lock, paying-phase credit line (`me-proration-credit`).
- `src/renderer/components/me/mePayment.ts` — `extractMeProration` (breakdown field aliases), `meTierRank`/`isMePlanDowngrade` (ladder).
- `src/mobile/app/me/mePointsStore.ts` — mobile mirror of the ladder + expiry parsing.
- `tests/meTierDowngradeGuard.test.ts`, `tests/meSubscriptionExpiry.test.ts`, `tests/meDesktopPayment.test.ts` (proration cases), `tests/meSubscriptionOrder.test.mjs` (flow pins).
