# ME Payment and Ledger Backend Requirements

## Context

The desktop client now uses automated gateway checkout for ME subscriptions and top-ups. It no longer presents the manual payment-voucher flow on desktop. The checkout client intentionally mirrors the proven traffic-recharge `gatewayParams` contract instead of submitting ME plan ids to `/v1/traffic/recharge/orders`; traffic pricing and ME pricing are different products.

Production probes during this change confirmed:

- `GET /v1/me/plans` returns ID.Free, ID.Pupil, ID.Student, and ID.Scholar. ID.Free currently carries a 2,000 ME weekly grant.
- `GET /v1/me/topup/packages` returns ME top-up packages.
- `/v1/me/history`, `/v1/me/balance`, `/v1/me/subscription`, and `/v1/me/topup/orders` reach ME identity-auth validation when identity headers are absent. These routes exist.
- `GET /v1/me/subscription/order` returns 404. A subscription order cannot currently be created.
- Item-status routes under `/v1/me/subscription/order/{orderId}` and `/v1/me/topup/orders/{orderId}` return 404. The desktop top-up flow therefore polls the existing order-list route instead.

An authenticated production ledger payload was not available during this investigation. The client has nevertheless stopped dropping numeric entry ids and now accepts common list/field variants. That client hardening is not a substitute for the server-side ledger guarantees below.

## Required outcome

1. A user can open or renew an ME plan, pay in a hosted checkout or by scanning an order-specific Alipay QR, and receive the plan without manual review.
2. A paid subscriber can top up ME through the same gateway flow and receive ME exactly once.
3. Every ME balance mutation produces a queryable ledger entry in the same atomic operation. A successful balance change with no corresponding history entry is a backend defect.
4. LLM, JEV/cerebellum, agent, and traffic consumption emits signed burn entries promptly, so the Usage & Credits page explains where ME went.

## 1. Subscription order API

### Create

`POST /v1/me/subscription/order`

Use the existing ME identity-signature action:

```text
me:subscription_order:<unixSeconds>
```

Request:

```json
{
  "planId": "me_standard",
  "period": "month",
  "channel": "desktop",
  "gateway": "alipay",
  "idempotencyKey": "desktop-subscribe-me_standard-month-<unique>"
}
```

Rules:

- `period` is `month | quarter | year`.
- `channel` is `desktop | cloud | mobile`.
- `gateway` is `alipay | paypal`. CNY desktop checkout currently requests `alipay`.
- The server computes price from plan, period, and channel. Never trust a client-supplied amount.
- Replaying the same identity and `idempotencyKey` returns the original order and never creates a second payable order.
- The endpoint must be available to free users; it is the subscription entry point and must not require an existing paid subscription.

Unified response `data`:

```json
{
  "orderId": "me_sub_01",
  "planId": "me_standard",
  "period": "month",
  "channel": "desktop",
  "status": "created",
  "amountCny": 49,
  "payAmount": 49,
  "payCurrency": "CNY",
  "gatewayParams": {
    "qrCode": "https://qr.alipay.com/<order-specific-content>",
    "alipayOutTradeNo": "me_sub_01"
  },
  "createdAt": 1793835740000
}
```

For PayPal, return an `approvalUrl` instead of, or alongside, a QR payload:

```json
{
  "gatewayParams": {
    "approvalUrl": "https://www.paypal.com/checkoutnow?token=<token>",
    "paypalOrderId": "<provider-order-id>"
  }
}
```

### Status

`GET /v1/me/subscription/order/{orderId}`

Use the same signed action, `me:subscription_order:<unixSeconds>`, and return the same order shape without exposing merchant secrets. The route must only return orders owned by the authenticated identity.

Preferred status values:

- `created`: order exists and awaits payment.
- `paid`: provider payment is observed, but plan activation is not complete.
- `credited`: the plan is active or renewed.
- `closed`: expired, cancelled, rejected, or otherwise terminally unpaid.

The client also accepts the legacy `submitted | confirmed | rejected` mapping and numeric traffic-style `3 = credited`, `4 = closed`, but new responses should use the preferred strings.

## 2. Top-up order API

Keep the existing routes:

- `POST /v1/me/topup/orders`
- `GET /v1/me/topup/orders`

Extend creation to accept the same automated fields:

```json
{
  "packageId": "me_topup_a",
  "gateway": "alipay",
  "idempotencyKey": "desktop-topup-me_topup_a-month-<unique>"
}
```

Return `orderId`, `packageId`, `status`, `meMilli`, `payAmount`, `payCurrency`, `gatewayParams`, and `createdAt` using the same gateway shapes above. Preserve `SUBSCRIPTION_REQUIRED` for free-tier attempts. The order-list response must include each order's current status so the desktop poller can observe `credited` or `closed`.

Existing voucher fields may remain for backward compatibility with older/mobile clients, but a request carrying `gateway` must create a real provider order and must not require `voucherUrl` or `voucherRemark`.

## 3. Gateway crediting and idempotency

Reuse the traffic recharge gateway adapter and webhook discipline:

- Merchant credentials, webhook secrets, and provider captures remain server-side.
- Verify provider signatures and order ownership before marking payment.
- Provider callbacks and client polls must be idempotent. Repeated callbacks, retries, and page reloads cannot credit twice.
- Do not mark `credited` on checkout creation or browser redirect alone. Credit only after verified payment and successful plan/ME mutation.
- Plan activation/renewal and the resulting ledger write must commit atomically.
- Top-up balance mutation and its ledger write must commit atomically.
- Return an order-specific QR payload, not the platform's static receiving QR. The client renders that payload directly.
- Closing the desktop window must not cancel a completed payment or prevent later status reconciliation.

## 4. Ledger response contract

`GET /v1/me/history`

Continue using `me:history:<unixSeconds>` identity authentication. Preferred unified response `data`:

```json
{
  "entries": [
    {
      "id": "me_entry_01",
      "type": "burn",
      "amountMilli": -1250,
      "balanceAfterMilli": 998750,
      "refType": "llm",
      "refId": "request-or-order-id",
      "reason": "deepseek-chat",
      "createdAt": 1793835740000
    }
  ],
  "nextCursor": "me_entry_01"
}
```

Field rules:

- `id`: stable unique string; numeric ids are tolerated by the updated client but strings are preferred for new data.
- `type`: `mint | topup | bonus | burn | transfer | reverse | adjust | expire`.
- `amountMilli`: signed integer milliME. Grants/credits are positive; consumption and expiry are negative.
- `balanceAfterMilli`: resulting total available milliME after the entry, when available.
- `refType`: `llm | jev | agent | traffic | subscription | topup | admin` where applicable.
- `refId`: stable source/request/order identifier for reconciliation and deduplication.
- `reason`: concise model, resource, plan, package, or administrative reason.
- `createdAt`: milliseconds since Unix epoch.
- `nextCursor`: opaque stable cursor; omit or return an empty value at the end.

Query behavior:

- `type=<type>` filters exactly one ledger type; no type returns all entries.
- `beforeId=<cursor>` pages backward in a stable newest-first order without duplicates or skipped rows.
- `limit` is bounded and honored consistently.
- Filters and pagination must be applied by the backend, not simulated by removing rows from the current page.

The updated desktop client additionally accepts `history`, `items`, `list`, `records`, or `rows` as the array container, numeric ids/cursors, `entry_type`, `createTime`, and `remark`. The preferred contract above removes the need for those compatibility paths.

## 5. Required ledger writes

Every row below must create a history entry and update the relevant balance in one transaction:

| Event | Type | Sign | Required reference |
| --- | --- | --- | --- |
| Weekly free or paid grant | `mint` | Positive | Subscription/tier and cycle |
| Confirmed ME top-up | `topup` | Positive | Top-up order id |
| Promotional/manual bonus | `bonus` | Positive | Campaign or admin action |
| LLM consumption | `burn` | Negative | Model and request id |
| JEV/cerebellum consumption | `burn` | Negative | `jev` and request id |
| Agent execution consumption | `burn` | Negative | Agent/task/request id |
| Traffic consumption | `burn` | Negative | Traffic/source id |
| Reversal/refund | `reverse` | As required | Original entry/order id |
| Administrative correction | `adjust` | As required | Admin action id and reason |
| Expiry | `expire` | Negative | Pool/cycle id |

Deduction order remains weekly grant → bonus → top-up → earned. A single request that draws from multiple pools may emit one entry with a pool breakdown or multiple entries sharing one `refId`; the sum must exactly equal the balance reduction.

## 6. Acceptance scenarios

1. **Free grant visibility:** create a fresh identity, trigger its first weekly grant, then read balance and history. Both show 2,000 ME; one positive `mint` entry exists.
2. **Subscription checkout:** create a desktop `me_standard/month` order with the same idempotency key twice. Only one order exists. Complete verified payment. The plan becomes active, the order becomes `credited`, and the corresponding grant/history mutation appears once.
3. **Top-up checkout:** on a paid identity, create and pay `me_topup_a`. Repeated provider callbacks leave one balance mutation and one `topup` ledger entry.
4. **Usage burn:** make a metered LLM request. The balance decreases and a negative `burn` entry with `refType=llm`, model reason, and request reference appears promptly.
5. **Pagination:** create more than one page of entries and page with `beforeId`. No entry is duplicated, skipped, or silently dropped because its id is numeric.
6. **Failure path:** close or expire an unpaid provider order. No plan/ME credit and no positive ledger entry appear; status becomes `closed`.
7. **Replay safety:** retry creation and callback delivery after a simulated network timeout. Idempotency prevents duplicate orders and duplicate credits.

## Client handoff

The desktop implementation for this contract is on branch `feat/me-plan-integration`. It already handles hosted checkout URLs, order-specific QR content, order polling, numeric history ids, and the filter set `mint/topup/bonus/burn/transfer/reverse/adjust/expire`. End-to-end live payment verification remains blocked until the subscription create/status routes and gateway crediting behavior are deployed.
