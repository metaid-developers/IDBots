# Phase 4 — Real Payment Integration Plan

Status: **superseded (2026-09-20)** — PayPal was selected as the first real
gateway (merchant account ready); see `phase4-paypal-backend-requirements.md`
for the authoritative contract. The Stripe + Alipay plan below is kept for
history and may still apply when a second gateway is added behind the same
`PaymentGateway` seam.
Update (2026-10-03): the Alipay half is now specified as 当面付 QR recharge in
`phase5-alipay-backend-requirements.md` (no ICP-filed domain required); Stripe
remains unscheduled.
Roadmap ref: `roadmap.md` Phase 4 (M4.1–M4.4).
Decision on record: mock payment first; **Stripe + Alipay ship together**;
integrating either one alone is not considered done.

## Goal

Replace the mock payment gateway with real Stripe and Alipay channels so a
user's recharge (CNY or USD) credits traffic exactly once, end to end, with
operator-grade reconciliation.

## Prerequisites (business side, not code)

- Company qualifications filed: Stripe merchant account; Alipay (支付宝)
  merchant account (likely 电脑网站/手机网站支付 or 当面付 for QR).
- Production domain + HTTPS for payment callbacks (webhook/notify URLs must
  be publicly reachable; the current test instance IP is not suitable).
- Decision: settlement currencies (CNY via Alipay; USD/EUR via Stripe) and how
  the pricing table maps plans per currency (backend pricing table is already
  admin-configurable — extend per-currency if needed).

## Backend work (assist-base-service — we deliver a spec, they implement)

- M4.1 Finalize the `PaymentGateway` adapter interface (the Mock gateway
  already sits behind this seam; `mock_payment_enabled` config flag exists).
- M4.2 Stripe adapter: Checkout Session (or PaymentIntent) creation, webhook
  endpoint with signature verification, idempotent credit on
  `checkout.session.completed` (webhook retries must not double-credit;
  recharge order already has a unique id — enforce exactly-once via the
  existing ledger idempotency key).
- M4.3 Alipay adapter: order creation, async notify with RSA2 signature
  verification, idempotent credit; handle the sync return URL for UX only
  (never trust it for crediting).
- Reconciliation tooling: list/search recharge orders with payment state;
  admin view of gateway transaction id vs internal order id; a daily summary
  is enough for v1.
- Config: per-gateway enable flags + secrets via env/config; document in
  `docs/traffic-deployment.md` (their repo).

## Client work (IDBots)

- Replace the mock-pay seam in `TrafficSettings.tsx` (`handleMockConfirm`)
  with the real flow per selected plan + provider:
  - Stripe: open Checkout URL in system browser (or embedded PaymentElement);
    poll recharge order status until credited.
  - Alipay: display QR / open cashier URL; poll order status.
- Order states UX: pending (waiting for payment), credited (balance +
  ledger refresh), expired/cancelled, failed with retry.
- **Remove or hard-disable the mock-confirm path in production builds** —
  the client must never be able to credit traffic by itself.
- i18n for all new strings (both locales, symmetric keys — verify with the
  key-diff script approach used in the i18n pass).

## Acceptance (roadmap M4.4)

- A real (sandbox) Stripe payment and a real Alipay payment each credit
  traffic **exactly once**; duplicate webhook/notify delivery does not
  double-credit; balance, ledger entry, and per-order status all agree.
- Reconciliation: operator can match every credited order to a gateway
  transaction id.

## Open questions to settle before implementation

- Refund policy and whether refunded orders debit the traffic account.
- Invoice/receipt requirements (合规发票).
- Regional availability: which users see Alipay vs Stripe (geo or manual).
- Price-display currency on the pricing table when both providers are live.
