# Backend Requirements — Bill Sponsored On-Chain Traffic in ME Credits (assist-base-service)

- Status: **Approved v1.1**, 2026-11-09. Owner confirmed D1–D4 per section 6 (all recommendations adopted). v1.1 pins the R4 field names and the `sponsor-orders` page envelope, the R5 request shape, and the R3 identity-address requirement; no semantic change from v1.0.
- Client counterpart: IDBots branch `feat/credits-traffic-unify` (developed in parallel; see Appendix A).
- Related contracts: `docs/gasfee-flow/backend-spec.md` (traffic account), `docs/gasfee-flow/me-payment-and-ledger-backend-requirements.md` (ME ledger), ABS `docs/me-points/客户端与宿主接入指南.md`.

## 1. Goal

Gas-sponsored MVC writes are billed today to the user's **traffic account in bytes** (`PaySourceTraffic`): `pre` reserves `txSize` bytes, `commit` spends them, expiry releases them. ME credits (积分) are a separate account that plans and top-ups fund for LLM and cerebellum.

Product decision: **on-chain traffic is billed in ME as well.** The byte-denominated traffic balance stops being something users see, top up, or spend.

Target client behavior:

- One switch, **Credits payment**, default ON.
- ON: every local MetaBot and the user identity write through the sponsor, and each write is charged in ME to the user identity — weekly grant first, then bonus → top-up → earned (persistent pools only while `autoDeductFromPersistent` is ON).
- Not enough ME for a write: that write falls back to the writing wallet (the existing self-pay path, unchanged).
- OFF: every wallet pays its own gas (today's "MetaBot self-pay").

## 2. Reused as-is

| Piece | Where (ABS) | Role in the new flow |
|---|---|---|
| Sponsor flow challenge → pre → commit, order state machine, broadcast outbox | `service/gas_assist_service/sponsor_flow.go` | Unchanged; ME billing is a new pay-source branch |
| Traffic account + address bindings, `VerifyTrafficPreAuth` | `service/traffic_service/account_service.go:276-306` | Still the registry that maps a writing address to the paying identity (`TrafficAccountModel.IdentityAddress`) |
| ME `Freeze` / `Capture` / `Release` | `service/me_service/consume_service.go:421 / 546 / 665` | Reserve / settle / release. `Capture` with no payee writes burn rows |
| ME rate config | `service/me_service/rate_service.go:24-27, 226-267` | `trafficMePerMillion` × `chainMultipliers.mvc` |
| ME history filters `type`, `refType`, `refId` | `controller/me_request.go:87-95` | Lets the client list traffic burns per order |

## 3. Requirements

### R1. ME-billed sponsor orders (new pay source `me`)

1. **Opt-in on `POST /v2/assist/gas/mvc/pre`.** Add `billing` to the existing `trafficAccount` block (`controller/request/assist_gas_request.go:54-59`):
   ```json
   "trafficAccount": { "accountId": "...", "authSignature": "...", "timestamp": 1762650000, "billing": "me" }
   ```
   - `billing` absent or `"bytes"` = today's behavior, so old clients are unaffected.
   - With `billing: "me"`, `authSignature` signs `traffic-pre-me:<accountId>:<challengeId>`. A separate signing domain stops a bytes-mode signature from being replayed as an ME charge, and the other way round.
   - Binding and account-status checks are unchanged.
2. **Amount.** `amountMilli = ConvertToMeMilli("traffic", "mvc", txSize)`, using the R2 unit fix. Minimum 1 milliME per order.
3. **Freeze at `pre`,** in the transaction that creates the order (where `ReserveBytesTx` runs today, `sponsor_flow.go:552-565`):
   - Freeze `amountMilli` on the account's `IdentityAddress`. Freeze `orderId` = sponsor `orderId`, no payee.
   - Honor `autoDeductFromPersistent` (grant-only when OFF) and the standard deduction order.
   - **Do not count against the bot autonomous pay limit** (`bot_daily_pay_limit_milli`). `Freeze` enforces that limit today (`consume_service.go:448`), so this needs a metering-style freeze variant. Count instead against the metering daily limit (`metering_daily_burn_limit_milli`, default 20,000 ME/day/identity, open freezes included) or a dedicated `traffic_daily_limit_milli`. ABS's choice; document which one.
   - Order row: new `PaySource = 3 (me)`; store `MeAmountMilli`, `TrafficAccountId`, and `TxSize`. No byte reservation for ME orders.
4. **Errors.** Same envelope as `TRAFFIC_INSUFFICIENT` (`controller/sponsor_controller.go:144-157`), on `data.errorCode`:
   | `errorCode` | Extra fields | Meaning |
   |---|---|---|
   | `ME_INSUFFICIENT` | `neededMilli`, `availableMilli`, `autoDeductDisabled` | Pools cannot cover the write |
   | `ME_DAILY_LIMIT` | `limitMilli` | Daily limit reached |
   | `ME_TRAFFIC_BILLING_DISABLED` | — | Switch off, rate not configured, or identity outside the rollout allowlist (R7) |

   All are `retryable: false`. On any of them the client self-pays that write.
5. **Settle at `commit`** (`finalizeSponsorCommit`, `sponsor_flow.go:904-920`): `Capture(orderId)` → burn rows with ledger `refType = "metering:traffic"` (the existing metering taxonomy) and `refId` = sponsor `orderId`.
6. **Release on expiry or failure before capture** (`releaseTrafficReservationIfTrafficTx`, `sponsor_flow.go:1318`): `Release(orderId)` in the same transaction as the order state change. It must not wait for the 24 h ME freeze janitor (`me.default_freeze_ttl_seconds`).
7. **Refund after capture** (broadcast-failure compensation, `refundTrafficSpendIfTrafficTx`, `sponsor_flow.go:1351`): reverse the burn (ledger type `reverse`) under the existing ME reverse rules for grant portions.
8. **Idempotency.** Every step above is keyed on `orderId`, like the byte path.
9. **Echo.** The `pre` / `commit` responses and `GET /v2/assist/gas/mvc/order/:orderId` return `paySource` (`"me" | "bytes" | "quota"`) and `meAmountMilli`, so the client records what was actually billed.

### R2. Traffic rate unit — decided (D1)

- **Problem.** `ReportMeteringEvent` documents the traffic quantity in **MB** (`service/me_service/metering_burn_service.go`, comment above `ReportMeteringEvent`; `docs/me-points/客户端与宿主接入指南.md:344`), but `ConvertToMeMilli` divides by 1e6. With the owner value `trafficMePerMillion = 20` (`docs/me-points/参数默认值清单.md:62`), 1 MB costs 0.00002 ME.
- **Fix.** The traffic base unit is **1 byte of final transaction size** (`txSize`, the unit the sponsor already measures). `trafficMePerMillion = 20` then means 20 ME per 1,000,000 bytes:

  | Usage | ME |
  |---|---|
  | 1 KB (1,000 B) | 0.02 (20 milliME) |
  | 616 B Buzz | ≈ 0.012 (12 milliME) |
  | 1 MB | 20 |
  | 100 MB | 2,000 (= the ID.Free weekly grant) |

  Reference only: legacy retail was ¥10 = 100 MB. At the top-up price (¥90 / 30,000 ME), 2,000 ME ≈ ¥6.
- **Also update:** the `/v1/internal/me/metering/report` contract (traffic `quantity` in bytes), `参数默认值清单.md` §6, and the metering section of `客户端与宿主接入指南.md`.

### R3. Capability and spendable balance

- `GET /v2/assist/gas/address/info` (already read by the client for `data.traffic.balanceBytes`) adds, for addresses bound to a traffic account:
  ```json
  "me": { "trafficBilling": true, "spendableMilli": 1834000 }
  ```
  - `trafficBilling` = switch on AND rate configured AND identity allowed (R7).
  - `spendableMilli` = what a new ME spend can draw now: grant remaining + (`autoDeductFromPersistent` ? persistent pools : 0), excluding frozen amounts.
  - The client also reads this block for the user identity address (bound to the account like the bots) to decide when the traffic tab switches from the byte-balance UI to the ME credits UI, so the block must be present for that address too.
- `GET /v1/me/balance` adds `spendableMilli` with the same definition. `totalAvailable` (`service/me_service/subscription_service.go:288-290`) ignores the auto-deduct switch, so the client cannot use it as "can pay".
- The client never computes ME cost itself. Its pre-flight is only `spendableMilli > 0`; `pre` stays authoritative.

### R4. Usage and history for ME-billed traffic

- `GET /v1/traffic/accounts/:accountId/usage/daily` and `/usage/summary` aggregate `tb_traffic_ledger` spend rows today (`service/traffic_service/usage_service.go:45-121`), so ME-billed orders would disappear from them. They must include committed ME-billed sponsor orders and add ME totals (integer milliME) next to the byte totals:
  - `usage/daily`: every row gains `meMilli`.
  - `usage/summary`: gains `todayMeMilli`, `weekMeMilli`, `monthMeMilli` next to `todayBytes`, `weekBytes`, `monthBytes`.
- **New:** `GET /v1/traffic/accounts/:accountId/sponsor-orders?cursor&limit&botAddress`, newest first, with the same auth as the existing `ledger` endpoint. `cursor` is the opaque `nextCursor` string of the previous page (absent on the first page); `limit` defaults to 20, max 100; `botAddress` filters to one bound address. Response `data`:
  ```json
  {
    "rows": [
      { "orderId": "...", "botAddress": "...", "txId": "...", "txSize": 616,
        "paySource": "me", "meAmountMilli": 12, "status": "committed",
        "createdAt": 1762650000000, "committedAt": 1762650001000 }
    ],
    "nextCursor": "opaque-string, empty when there are no more rows"
  }
  ```
  It covers both pay sources, so users keep their older byte-billed history.
- ME burn rows for traffic: `refType = "metering:traffic"`, `refId` = `orderId`, and `reason` carries the bot address and `txSize` (public values only).

### R5. Existing byte balances — decided (D2): convert to ME

**Decided:** a one-time, per-account conversion of the remaining `balanceBytes` into ME at the R2 rate, minted into the `topup` bucket (never expires). The new client triggers it once when Credits payment is enabled, through a signed, idempotent endpoint (same `X-Identity-Address` / `X-Timestamp` / `X-Signature` headers as the other signed `/v1/traffic/*` calls; the client sends an empty JSON body `{}`):

```
POST /v1/traffic/accounts/:accountId/convert-to-me
signature: traffic-convert-me:<accountId>:<timestamp>
→ { convertedBytes, mintedMilli, entryId, alreadyConverted }
```

- Bytes still reserved by open orders are converted once those orders settle or release.
- The account is flagged `migrated`:
  - Further byte reservations are rejected, so not-yet-upgraded clients fall back to self-pay.
  - Any byte credit landing later (recharge webhook, redeem code, free grant, bundle) is minted as ME at the same rate instead. A user's money is never stranded in bytes.
- The 500,000 ME persistent-pool cap must not reject a conversion (exempt it, or report the overflow).
- Ledger: a traffic-ledger out entry with `sourceType = "me_conversion"`, and an ME `mint` with `refType = "traffic_conversion"`, `refId` = `accountId`.

**Alternative (not chosen):** ABS batch-converts every account at cutover. This is simpler, but every old client and every cloud tenant (which stay on byte billing in this phase, see [D4]) lose byte billing at the same moment.

### R6. Traffic top-up surfaces

- Once `me.trafficBilling` is true, new desktop clients stop calling traffic pricing, recharge, redeem-code, and free-grant endpoints (before that they keep the byte-balance UI they are billed against). The endpoints stay up for old clients and for server mode.
- Free-grant campaign: retired for migrated accounts; the ID.Free weekly ME grant replaces it.
- Unredeemed traffic redeem-code batches: redeeming into a migrated account mints ME per R5. ME-denominated codes are a follow-up, out of scope here.

### R7. Rollout switches

- `tb_me_config.traffic_billing_enabled` (default `false`), independent of `metering_enabled` (which only gates the best-effort LLM burn).
- Optional identity allowlist for staged rollout (test identities first).
- Switch off → `pre` with `billing: "me"` returns `ME_TRAFFIC_BILLING_DISABLED`, and `address/info` reports `me.trafficBilling: false`. The client then keeps using byte billing.

### R8. Out of scope

Legacy per-address sats quota (`PaySourceQuota`), LLM relay admission and quota, the cloud bundle product, tenant bootstrap redeem codes, ME-denominated redeem codes, and non-MVC chains.

## 4. Acceptance

1. **ME-billed write.** `pre` freezes exactly `ConvertToMeMilli(txSize)`; `commit` burns it; `GET /v1/me/history?refType=metering:traffic&refId=<orderId>` shows burn rows summing to it; `spendableMilli` drops by the same amount.
2. **Grant-only.** With `autoDeductFromPersistent` OFF, the grant exhausted, and top-up > 0 → `ME_INSUFFICIENT` with `autoDeductDisabled: true`, and the persistent pools are untouched.
3. **Daily limit.** Reaching it → `ME_DAILY_LIMIT`. Traffic never consumes the bot autonomous pay limit.
4. **Expiry.** An expired ME order returns its frozen amount within the sponsor expiry sweep, not after 24 h.
5. **Refund.** Broadcast-failure compensation reverses the burn; replaying any step writes nothing new.
6. **Usage.** `usage/daily` and `usage/summary` include ME orders with `meMilli`; `sponsor-orders` lists both pay sources.
7. **Conversion.** `convert-to-me` is idempotent; a byte credit landing on a migrated account mints ME.
8. **Compatibility.** An old client (no `billing` field) on a non-migrated account is billed in bytes exactly as today.
9. **Rate.** 1,000,000 bytes → 20,000 milliME at multiplier 1.

## 5. Delivery order

R2 → R1 + R7 → R3 → R4 → R5 / R6. The client ships behind `me.trafficBilling`: until ABS reports it `true`, the client keeps byte billing, so the two sides can release independently.

## 6. Owner decisions — all confirmed 2026-11-09

| ID | Question | Decision |
|---|---|---|
| D1 | Traffic rate | `trafficMePerMillion = 20` with base unit = byte, i.e. 1 MB = 20 ME |
| D2 | Remaining byte balances | Convert to ME (`topup` bucket), triggered per account by the new client |
| D3 | (client) Users who explicitly chose MetaBot self-pay | They stay OFF; the default ON applies to everyone else |
| D4 | (client / cloud) Server mode tenants | Stay on byte billing in this phase; the bundle product moves via a separate cloud-mobile change request |

## Appendix A — Client behavior (IDBots, for context)

- **Switch.** Settings > Credits & Traffic > Traffic: the "Account quota / MetaBot self-pay" toggle becomes a single **Credits payment** switch (default ON). It reuses the KV key `traffic.mode`: `traffic` = ON, `selfpay` = OFF.
- **Balance card.** Once address/info reports `me.trafficBilling`, the byte "Available quota" card (refresh, redeem code, recharge) is removed and replaced by the ME weekly-quota card, plus the persistent-pack balance while auto-deduct is ON. Until then the client keeps the byte card, because it is still billed in bytes.
- **Kept sections.** The usage section and the detailed usage history stay. The history reads `sponsor-orders` (R4); until that ships it falls back to `GET /v1/me/history?refType=metering:traffic` joined with the local spend journal.
- **Sponsor path.** The client sends `billing: "me"` when `me.trafficBilling` is true, and pre-flights on `spendableMilli > 0`. `ME_INSUFFICIENT` / `ME_DAILY_LIMIT` / `ME_TRAFFIC_BILLING_DISABLED` → self-pay for that write (the existing fallback). It also latches briefly after an `ME_INSUFFICIENT` so it does not spend a challenge + pre round trip on every write while the user has no ME.
- **User identity writes** (preferences, in-app browser pin writes, owner-to-bot private messages) are paid by the identity wallet today. They move onto the sponsor path; the identity address is already bound to the traffic account, so ABS needs no extra change.
- **Server mode** keeps byte billing in this phase ([D4]).
