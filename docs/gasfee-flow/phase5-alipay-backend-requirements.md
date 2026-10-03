# Phase 5 — Alipay (当面付) Recharge: Backend Requirements

> **Deliverable for the assist-base-service team.** IDBots team does not modify
> that repository. This document is the contract for adding **Alipay** as the
> second real payment gateway for traffic recharge — the one that covers
> **mainland-China users** — behind the existing `PaymentGateway` seam, next to
> the delivered PayPal adapter. Target service: `assist-base-service` (Go 1.22 +
> Gin + GORM/MySQL), deployed behind `https://www.metaso.network/assist-open-api`.

- Version: v1.0 (2026-10-03)
- Depends on: the delivered recharge system (`backend-spec.md` v1.1) and the
  delivered PayPal adapter (`phase4-paypal-backend-requirements.md`) —
  `tb_traffic_recharge_order`, `PaymentGateway` interface
  (`service/traffic_service/recharge_service.go:22`), generic webhook route
  `POST /v1/traffic/payment/webhook/:gateway`
  (`controller/traffic_controller.go:258`), and the idempotent crediting path
  (`creditRechargeOrder`, `recharge_service.go:176`).

---

## 1. Background & Provider Decision

PayPal (Phase 4) covers international users paying in USD, but is effectively
unusable for mainland-China users. Phase 5 adds a China-friendly channel.

**Constraints on record:**

- The merchant has a **mainland-China company entity** (营业执照), so official
  Alipay/WeChat merchant products are within reach.
- **No ICP-filed (备案) domain yet.** This eliminates every "website payment"
  product: Alipay 电脑网站支付/手机网站支付 require an ICP-filed site whose
  filing entity matches the merchant
  ([支付宝产品介绍](https://opendocs.alipay.com/open/270/105898)), and WeChat
  Native/H5 likewise require an ICP-filed domain
  ([微信支付 Native 申请指引](https://pay.weixin.qq.com/doc/v3/merchant/4012791875)).
- Receiving currency is flexible (CNY or USD both acceptable; 结汇 is a later
  finance question).

**Decision: Alipay 当面付 (face-to-face, `alipay.trade.precreate`) first.**

- Officially an offline/scan-code product: signing requires a verified
  enterprise Alipay account + business license, and **does not audit any
  website or require ICP filing** — see the
  [服务商代商户签约当面付资料要求](https://opendocs.alipay.com/p/04agyq).
- The IDBots desktop client renders the returned QR code in-app; the user scans
  it with the Alipay mobile app. There is no browser checkout page on our own
  domain, so the ICP requirement never engages.
- Settlement is CNY into the corporate Alipay account, T+1 to the bound bank
  account.
- The same QR was payable from a desktop browser if needed: the `qr_code`
  payload Alipay returns is an `https://qr.alipay.com/...` URL that renders
  Alipay's own cashier page when opened directly.

**Why not the alternatives (rejected for v1):**

| Option | Verdict |
|---|---|
| Alipay 电脑网站/手机网站支付 | Requires ICP-filed domain — blocked. |
| WeChat Native / H5 (direct) | Requires ICP-filed domain — blocked until 备案 completes. |
| Stripe (Alipay/WeChat via Stripe) | Stripe does not onboard mainland-China entities — unavailable. |
| Airwallex / PingPong / cross-border PSPs | Online acquiring for Alipay/WeChat generally targets HK/overseas entities; heavier onboarding; revisit if USD settlement becomes a requirement. |
| Domestic aggregators (富友/汇付/拉卡拉…) | Can cover Alipay+WeChat via the aggregator's filed domain, but adds a vendor-selection + contracting cycle. Keep as the WeChat fallback (§13). |
| 免签约/个人码灰色通道 | Compliance and fund-safety risk — never. |

## 2. Scope

In scope:

- An `AlipayGateway` implementing the existing `PaymentGateway` interface,
  registered in `paymentGateway()` (`recharge_service.go:38`) under the name
  **`alipay`**.
- Async-notify handling for `POST /v1/traffic/payment/webhook/alipay` (route
  exists; RSA2 verification logic lives inside the gateway's `VerifyWebhook`).
- An `alipay.trade.query`-based reconciliation path so a missed notify never
  strands a paid order (§5.4).
- Alipay config keys (§8).
- CNY pricing plans (§9).

Out of scope (unchanged from Phase 4): refunds, invoices, WeChat Pay (see §13),
client-side Alipay SDK.

## 3. Alipay API Cheat Sheet (what you'll integrate against)

| Concern | Alipay API |
|---|---|
| Gateway URL | `https://openapi.alipay.com/gateway.do` (sandbox: `https://openapi-sandbox.dl.alipaydev.com/gateway.do`) |
| Auth | Every request is form-POSTed with `app_id` + RSA2 (`SHA256withRSA`) signature using the **merchant private key**; responses/notifies verify against the **Alipay public key** |
| Create QR order | `alipay.trade.precreate` → response `qr_code` (string; render as QR) |
| Query order | `alipay.trade.query` (by `out_trade_no`) → `trade_status` |
| Close order | `alipay.trade.close` (abandoned-order sweep, §6) |
| Async notify | Alipay POSTs form-encoded params to our `notify_url`; `trade_status=TRADE_SUCCESS` / `TRADE_FINISHED` = paid |

Go SDK: there is an official-ish but aging `alipay-easysdk`; the community
[`github.com/smartwalle/alipay`](https://github.com/smartwalle/alipay) v3 is
the widely-used, actively maintained choice and handles signing/verify.
Plain HTTP + manual RSA2 signing is also acceptable if the repo prefers zero
new deps — the surface needed here is three API calls plus notify
verification.

## 4. Order Creation Contract (what IDBots consumes)

Unchanged endpoint, new gateway value:

```
POST /v1/traffic/recharge/orders
Headers: X-Identity-Address / X-Timestamp / X-Signature  (unchanged)
Body:    { "planId": "cny_10_1gb", "gateway": "alipay" }
```

Response `data` (existing `TrafficRechargeCreateRespond` shape, no breaking
change — `gatewayParams` is `any`):

```jsonc
{
  "orderId": "trch_...",          // our internal recharge order id
  "payAmount": 10,
  "payCurrency": "CNY",
  "trafficBytes": 1000000000,
  "gatewayParams": {
    "qrCode": "https://qr.alipay.com/bax01234...",   // alipay.trade.precreate qr_code, verbatim
    "alipayOutTradeNo": "trch_..."                    // = our orderId, echoed for support/debugging
  }
}
```

Rules:

- **Build the precreate request strictly from the pricing-plan row**
  (`tb_traffic_pricing_plan`): `total_amount` = `payAmount` (string, 2-decimal,
  e.g. `"10.00"`), currency is implicitly CNY for 当面付. Never accept
  amount/currency/description from the client request.
- `out_trade_no` = **our `orderId`** (this is the correlation key for notify,
  query, and close). `subject` = human-readable plan label (e.g. "IDBots 流量
  充值 1GB"); keep `body`/`store_id` optional.
- `notify_url` = `https://www.metaso.network/assist-open-api/v1/traffic/payment/webhook/alipay`.
- Persist nothing extra beyond what the PayPal adapter already persists:
  `gateway_order_id` may stay empty (our orderId **is** the out_trade_no); if
  the schema has a gateway-meta JSON column, store the raw precreate response
  there for support.
- Repeat `alipay.trade.precreate` calls for the same `out_trade_no` are safe on
  Alipay's side (it returns the same QR while unpaid), so client retries of
  order creation must still go through our own recharge-order creation (one
  order row per call, as today) — do not dedupe at the gateway layer.
- `gateway: "alipay"` with the feature disabled (`traffic.alipay.enabled=false`)
  must return the same style of envelope error as today's unsupported-gateway
  path — the client maps it to friendly "recharge unavailable" copy.
- If the plan's `payCurrency` is not `CNY`, reject with the same envelope error
  (当面付 is CNY-only).

## 5. Notify Contract (crediting path)

Route already exists: `POST /v1/traffic/payment/webhook/alipay`
(unauthenticated by design — **all trust comes from the RSA2 signature
verification**, never from the payload).

### 5.1 Verification (mandatory before any state change)

1. Verify the notify signature: RSA2 (`SHA256withRSA`) over the form params
   using the configured **Alipay public key** (支付宝公钥, not the app's public
   key). Failure → 4xx, log loud.
2. Check `app_id` equals our configured `app_id`.
3. Check `seller_id` equals our merchant PID (config `traffic.alipay.seller_id`)
   — money must be headed to **our** account.
4. Only `trade_status` = `TRADE_SUCCESS` or `TRADE_FINISHED` is a payment;
   `WAIT_BUYER_PAY` / `TRADE_CLOSED` are state noise → 200 "success", no-op.

### 5.2 Crediting

- Correlate via `out_trade_no` = our `orderId`. Unknown order → 4xx (so Alipay
  retries/alerts surface), log loud.
- **Verify `total_amount` exactly equals the order row's `payAmount`**
  (compare as decimal strings after normalizing to 2 places; never float) —
  mismatch → log loud, do not credit, still return "success" to stop retries
  (a forged-but-validly-signed mismatch is an ops incident, not a retry loop).
- `trade_no` → `gatewayTxnId`. Run the existing idempotent
  `creditRechargeOrder` flow (status machine + `UNIQUE(gatewayTxnId)` + ledger
  unique key already guarantee exactly-once across duplicate notifies).
- Also persist `buyer_logon_id` (masked) into gateway meta when present —
  useful for support.

### 5.3 Response convention (Alipay-specific, differs from PayPal)

Alipay expects the literal body **`success`** (plain text) to stop retrying;
anything else triggers redelivery for ~25 h. So: `200 success` on accepted /
idempotent / no-op events; non-`success` (e.g. `failure`) only when a retry is
actually wanted (DB down). Signature-verification failures should also answer
`failure` (Alipay stops treating the endpoint as broken and ops gets alerted
via the merchant dashboard).

### 5.4 Reconciliation fallback (required, not optional)

Notifies can be lost (deploy window, WAF hiccup). Add a janitor that runs every
few minutes over recharge orders in `status = created(1)` with
`gateway = 'alipay'` older than ~2 minutes and calls `alipay.trade.query`:

- `trade_status = TRADE_SUCCESS / TRADE_FINISHED` → run the same crediting path
  as §5.2 (idempotent).
- Still unpaid → leave for the next sweep (the 24 h expiry job from Phase 4 §6
  eventually closes the order; on close, also call `alipay.trade.close` so the
  QR stops being payable).

The client's own poll (`GET /v1/traffic/recharge/orders/:id`) may also
opportunistically trigger a `trade.query` for that order before answering —
optional but makes the UX feel instant.

## 6. Order Expiry

Reuse the Phase 4 janitor (orders stuck in `created` → `status = 4 (closed)`
after ~24 h). For Alipay orders additionally call `alipay.trade.close` during
the sweep; treat "ACQ.TRADE_NOT_EXIST" / already-closed responses as success.

## 7. Client Behavior Reference (how IDBots consumes this — already shipped)

1. `GET /v1/traffic/pricing` (public) renders the plan list; the client splits
   plans by currency: **CNY → Alipay tab, other → PayPal tab**.
2. User picks a CNY plan → `POST /v1/traffic/recharge/orders`
   `{planId, gateway:"alipay"}` → client renders `gatewayParams.qrCode` as a QR
   image in the recharge modal (no browser involved; the QR payload also works
   as a browser-openable cashier URL fallback).
3. Client polls `GET /v1/traffic/recharge/orders/:orderId` every 4 s for up to
   10 min while status is `created(1)`/`paid(2)`; terminal `credited(3)` →
   success UI + balance refresh; `closed(4)` → expired UI.
4. If the user closes the app mid-payment the notify still credits; the next
   balance read reflects it. The client never calls Alipay directly and never
   marks anything paid by itself.

## 8. Config Additions

Extend `TrafficConfig` (`conf/init_conf.go:74`) and the yaml confs:

| Key | Default | Meaning |
|---|---|---|
| `traffic.alipay.enabled` | `false` | master switch for the alipay gateway |
| `traffic.alipay.env` | `sandbox` | `sandbox` or `live` — picks the gateway URL |
| `traffic.alipay.app_id` | _(empty)_ | 开放平台应用 app_id (per env; sandbox has its own) |
| `traffic.alipay.seller_id` | _(empty)_ | merchant PID (2088…); checked on every notify (§5.1.3) |
| `traffic.alipay.merchant_private_key` | _(empty)_ | RSA2 private key (PEM body, one line or multiline yaml) |
| `traffic.alipay.alipay_public_key` | _(empty)_ | 支付宝公钥 from the app's 接口加签方式 (per env) |

Secrets live only in the (gitignored) conf yaml files, same as the PayPal
credentials. Sandbox (支付宝沙箱) and live credentials are separate apps; keep
both out of the repo.

## 9. Pricing Plans

No schema change: CNY plans are ordinary rows in `tb_traffic_pricing_plan`
(`payCurrency = "CNY"`). Plans are gateway-agnostic; the client sends
`gateway: "alipay"` for CNY plans automatically. Suggested seed set (ops
decides live values):

| planId | payAmount | trafficBytes |
|---|---|---|
| `cny_10_1gb` | 10 CNY | 1,000,000,000 |
| `cny_30_3_5gb` | 30 CNY | 3,500,000,000 |
| `cny_68_8gb` | 68 CNY | 8,000,000,000 |

当面付 `total_amount` formatting: 2-decimal string in CNY (`"10.00"`).

## 10. Merchant Checklist (account owner)

1. Register/verify an **enterprise Alipay account** (企业支付宝) for the
   company; complete 实名认证 with the 营业执照.
2. In [b.alipay.com](https://b.alipay.com) → 产品中心, sign **当面付** (no
   website/ICCP material required; category 生活服务/软件服务 as appropriate).
3. In [open.alipay.com](https://open.alipay.com) create an app (网页&移动应用),
   add the **当面付** capability, and complete app review.
4. App settings → 接口加签方式: choose **公钥模式 (RSA2)**, generate a keypair
   with the Alipay key tool, upload the app public key, and copy the resulting
   **支付宝公钥**. Hand `app_id` + merchant private key + 支付宝公钥 + PID
   (`seller_id`) to the backend team via a secret channel.
5. For sandbox work use 开放平台 → 沙箱 (its own app_id/keys + sandbox buyer
   account). For local backend development point `notify_url` at a tunnel
   (ngrok) and override per-env.
6. Production `notify_url` needs no ICP filing — it is a server-to-server
   callback on `www.metaso.network`, not a consumer-facing site.

## 11. Acceptance Criteria (sandbox, then live with ¥0.01)

1. Create order with `gateway:"alipay"` on a CNY plan → response carries a
   `qrCode`; rendering/scanning it shows an Alipay cashier for exactly the
   plan's CNY amount.
2. Pay with the sandbox buyer → within seconds
   `GET /v1/traffic/recharge/orders/:orderId` transitions
   `created → paid → credited`; balance increases by `trafficBytes`; ledger has
   a `grant` entry `source_type=recharge_order` with `trade_no` as the
   gateway txn id.
3. Re-deliver the same notify (or let the §5.4 janitor race the notify) →
   credited exactly once; `gatewayTxnId` unchanged.
4. Forge a notify (bad signature / wrong `app_id` / wrong `seller_id`) →
   rejected, no state change.
5. Tamper test: notify `total_amount` ≠ order amount → not credited, alert
   logged, endpoint answers `success` (no retry storm).
6. Notify lost (endpoint blackholed) → §5.4 janitor credits via
   `alipay.trade.query` within one sweep interval.
7. `traffic.alipay.enabled=false` → create-order with `gateway:"alipay"`
   returns the standard unsupported/unavailable envelope error.
8. Abandoned order → swept to `closed` after the expiry window AND
   `alipay.trade.close` called (QR no longer payable).
9. Admin console order list shows the order with the Alipay `trade_no` and
   revenue in CNY (existing admin surface should already cover this).

## 12. Open Questions (business, not blocking implementation)

- Refund policy: 当面付 supports `alipay.trade.refund`; v1 keeps the Phase 4
  stance (log/alert only, no auto-debit of the traffic account).
- 发票/invoicing for CNY receipts (企业支付宝 supports 电子发票 flows) — later.
- Whether USD plans should also be purchasable via Alipay (Alipay settles CNY
  only — recommend keeping the currency↔gateway split strict).

## 13. Follow-up: WeChat Pay (not in this phase)

Direct WeChat **Native**/**H5** both require an ICP-filed domain, so WeChat
stays blocked until either:

- **(a)** a company domain completes ICP 备案 (recommended; also unlocks Alipay
  电脑网站支付 and better brand presence) → then add a `wechat` gateway behind
  the same seam (Native v3 API, `code_url` → same client QR branch — the
  client's `extractQrCode` already accepts `codeUrl`), or
- **(b)** a domestic aggregator (富友/汇付/拉卡拉…) is contracted; its hosted
  cashier runs on the aggregator's filed domain and can expose both WeChat and
  Alipay → integrate as another gateway whose `gatewayParams` carries a
  cashier URL (the client's PayPal-style "open in browser" branch already
  covers that shape).

Either way it is a pure `PaymentGateway` addition — no client contract change
beyond a new gateway name and (for (a)) a new tab label.

---

## 14. Delivery Notes (2026-10-04, assist-base-service)

The backend adapter shipped as specified. Recorded deltas from this document,
all accepted:

- §5.2 `buyer_logon_id`: no gateway-meta JSON column exists on
  `tb_traffic_recharge_order`, so the buyer id is **masked-logged** (first 3
  chars + `***`) instead of persisted. Accepted for v1; add the column if
  support workflows need it.
- §9 seed set: delivered `cny_10_1gb`, `cny_30_3_5gb`, `cny_68_8gb` **plus**
  `cny_1_10mb` (¥1 → 10 MB), which is the default plan of the client
  acceptance script (`scripts/traffic-e2e/run-alipay-acceptance.mjs`).
- Legacy plan `cny_10_100mb` is still active and conflicts with the new
  `cny_10_1gb` (same price, 10× less traffic) — ops to archive the legacy row
  when seeding the new plans.
- Implementation notes: pure-HTTP hand-rolled RSA2 (zero new deps, §3 option
  B); janitor `ReconcileAlipayOrders()` sweeps `created` alipay orders older
  than 2 min every 5 min; expiry sweep closes Alipay orders via
  `alipay.trade.close` with `ACQ.TRADE_NOT_EXIST` treated as success.
- Pre-approval behavior confirmed: `precreate` returns
  `ACQ.PRODUCT_NOT_EFFECTIVE`, the order row stays `created`, and the 24 h
  janitor closes it — expected, and a usable error-path test before the
  merchant app review passes.
