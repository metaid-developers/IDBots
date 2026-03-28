# IDBots `metabot-mm-basic` V1 Design

## 1. Goal

Add a first-phase official skill, `metabot-mm-basic`, that lets a MetaBot act as an inventory-backed one-shot swap provider for a limited set of pairs.

Phase 1 should let a MetaBot:

- answer which pairs it supports,
- return the latest bid/ask for those pairs,
- accept an exact-in payment from another MetaBot,
- verify the payment with zero-confirmation rules,
- send back the output asset at the latest executable price,
- refund when the payment or inventory checks fail.

The desired product position is:

- not an AMM pool,
- not a continuous orderbook engine,
- not LP infrastructure,
- but a practical inventory-based market making skill for one-shot swaps.

## 2. Product Model

`metabot-mm-basic` V1 is best described as an inventory-driven one-shot swap service.

In service-square terms, one published service should represent exactly one pair and one direction, for example:

- `BTC -> SPACE`
- `SPACE -> BTC`
- `DOGE -> SPACE`
- `SPACE -> DOGE`

The long-term target is to make this work through service-square `service-order` flows between Bot A and Bot B. Phase 1 does not implement that full marketplace flow yet. Instead, it builds the same business rules as a normal skill with a structured execution payload so later service-square integration can reuse the same execution core.

## 3. V1 Scope

### 3.1 In Scope

- `BTC <-> SPACE`
- `DOGE <-> SPACE`
- exact-in swaps only
- zero-confirmation settlement
- supported-pair discovery
- latest bid/ask query
- quote-then-confirm flow
- direct market execution flow
- refund on invalid payment or insufficient inventory
- local JSON configuration
- real-time fair-value pricing from external market data
- ordinary skill simulation with a structured script payload

### 3.2 Out of Scope

- `BTC <-> DOGE`
- exact-out requests
- AMM or constant-product pools
- LP shares or liquidity add/remove
- partial fills
- one service covering multiple pairs or directions
- persistent preview state in core
- full service-square or `service-order` implementation in Phase 1

## 4. Terms

Use these terms consistently in product copy, scripts, tests, and future docs:

- `fair value`
  - The external reference mid price derived from CEX market data.
- `mid price`
  - The bot's current internal center price after applying inventory skew.
- `inventory skew`
  - The automatic price adjustment caused by inventory imbalance.
- `spread`
  - The total symmetric bid/ask spread around the current mid.
- `bid`
  - The price at which the MetaBot is willing to buy the base asset.
- `ask`
  - The price at which the MetaBot is willing to sell the base asset.
- `strict amount matching`
  - The paid input amount must exactly match the requested input amount.
- `refund on mismatch`
  - Amount mismatch leads to refund rather than execution.
- `refund on insufficient inventory`
  - Inventory shortfall leads to refund rather than execution.

Important pricing convention:

- the canonical config unit for spread is `spread_bps`,
- `100 bps = 1%`,
- if total `spread_bps = 200`, then V1 should interpret that as a total spread of `2%`,
- therefore `ask = mid * (1 + spread_bps / 20000)`,
- and `bid = mid * (1 - spread_bps / 20000)`.

Important pair convention:

- for `BTC/SPACE`, the base asset is `BTC`, the quote asset is `SPACE`, and the price unit is `SPACE per BTC`,
- for `DOGE/SPACE`, the base asset is `DOGE`, the quote asset is `SPACE`, and the price unit is `SPACE per DOGE`.

Direction-to-side mapping must be explicit:

- `BTC -> SPACE` means the payer sells `BTC` to the bot, so settlement uses the bot's `bid`,
- `SPACE -> BTC` means the payer buys `BTC` from the bot, so settlement uses the bot's `ask`,
- `DOGE -> SPACE` means the payer sells `DOGE` to the bot, so settlement uses the bot's `bid`,
- `SPACE -> DOGE` means the payer buys `DOGE` from the bot, so settlement uses the bot's `ask`.

## 5. Asset and Service Constraints

### 5.1 Asset Constraints

Phase 1 supports only the wallet assets already supported by IDBots:

- `BTC`
- `SPACE`
- `DOGE`

Phase 1 trading pairs are limited to:

- `BTC/SPACE`
- `DOGE/SPACE`

The architecture should not hardcode itself into this forever. Future versions should be able to add `BTC/DOGE` and other pairs without replacing the execution core.

### 5.2 Service Constraints

For the real marketplace form, one service should correspond to:

- one pair,
- one direction,
- one output asset,
- one pricing policy,
- one inventory budget.

This keeps order binding simple and avoids forcing Bot B to infer pair and direction from free text.

## 6. Pricing Model

V1 should use a three-layer pricing model:

1. `fair value`
2. `inventory-skewed mid`
3. `bid/ask` from symmetric spread

### 6.1 Fair Value

Fair value should come from an external market data endpoint that returns the three required spot references in `USDT`.

The default Phase 1 provider contract should be:

- `GET https://www.metalet.space/wallet-api/v3/coin/price?net=mainnet`

The expected response shape includes:

- `btc`
- `doge`
- `space`

All values are denominated in `USDT`.

Cross rates should be computed as:

- `BTC/SPACE = (BTC/USDT) / (SPACE/USDT)`
- `DOGE/SPACE = (DOGE/USDT) / (SPACE/USDT)`

Phase 1 should fetch fresh market data:

- on every quote request,
- on every executable settlement decision.

If live market data is unavailable, the skill may fall back to a configured local reference price for continuity.

The minimal provider contract should be:

- `btc`, `doge`, and `space` are numeric spot values in `USDT`,
- missing, non-numeric, zero, or negative values invalidate the market-data response,
- network or provider failure should surface a retriable market-data error.

To avoid accidental stale-price execution, the safer default should be:

- quote is still allowed with a clear fallback warning,
- execution using fallback fair value is allowed only when the operator explicitly enables it.

Because the endpoint is queried on both quote and execution paths, implementation should also include a short-lived in-process cache or equivalent rate-limit protection rather than assuming unlimited provider calls.

### 6.2 Inventory Skew

Inventory skew should use a simple linear model.

For each pair, configure:

- target inventory for both assets,
- sensitivity in basis points,
- maximum allowed skew in basis points.

`current usable inventory` should be derived at runtime, not stored as static config:

- start from the live wallet balance for the relevant asset,
- clip it by the configured per-pair `max_usable_inventory`,
- use that clipped value in the skew calculation and inventory checks.

Target inventory constraints:

- every target inventory value must be strictly greater than zero,
- invalid zero or negative targets should make the pair configuration invalid.

For a pair such as `BTC/SPACE`, define:

- `btc_dev = (current_btc - target_btc) / target_btc`
- `space_dev = (current_space - target_space) / target_space`
- `inventory_pressure = space_dev - btc_dev`

Then:

- `skew_bps = clamp(inventory_pressure * inventory_sensitivity_bps, -max_skew_bps, +max_skew_bps)`
- `mid = fair_value * (1 + skew_bps / 10000)`

This produces the intended behavior:

- if `SPACE` is abundant and `BTC` is scarce, `mid` moves up to attract more `BTC`,
- if `SPACE` is scarce and `BTC` is abundant, `mid` moves down to protect `SPACE`.

Phase 1 should:

- adjust `mid`,
- keep spread fixed,
- not automatically widen or shrink spread based on inventory.

### 6.3 Bid and Ask

Given the current `mid` and total spread:

- `ask = mid * (1 + spread / 2)`
- `bid = mid * (1 - spread / 2)`

`spread` should be configured as a symmetric total spread per pair.

## 7. Trading Rules

### 7.1 Execution Style

Phase 1 supports exact-in only:

- the user specifies how much of asset A they pay,
- the bot computes how much asset B they receive.

No exact-out mode should be implemented in V1.

### 7.2 Quote Semantics

There are two user-visible execution styles:

1. quote first, then confirm
2. direct market execution

If the user only asks for a price, the skill should return:

- supported pair or direction,
- current bid/ask or estimated output,
- a concise explanation that execution uses the latest price at settlement.

If the user asks to buy at market immediately, the skill should treat the quote as informational only. Final execution must use the latest price available when Bot B verifies the payment.

### 7.3 Slippage Protection

Phase 1 slippage should be defined as price protection relative to a prior quote.

This protection should apply only when the user flow is:

- ask for quote,
- then confirm against that quote.

It should not apply to direct market-buy or direct market-sell requests where there was no prior quote snapshot.

The quote snapshot itself does not belong in the generic `service-order` protocol. In the future marketplace flow, quote evidence should live in the A2A private-chat history on-chain rather than bloating the generic service-order payload.

For ordinary-skill structured execution in Phase 1, the execution payload may still carry an optional quote snapshot derived from that prior chat evidence so the pricing engine can evaluate slippage deterministically.

The acceptance rule should be:

- recompute the latest executable output using the latest fair value and inventory state,
- compare that latest executable output against the prior `quoted_output`,
- if `latest_output < quoted_output * (1 - slippage_bps / 10000)`, do not execute and refund,
- otherwise execute at the latest price,
- Phase 1 does not freeze execution to the old quote price.

## 8. Inventory and Trading Limits

Each pair should have its own configured limits:

- target inventory for both assets,
- maximum usable inventory for both assets,
- minimum input size per direction,
- maximum input size per direction.

Usable inventory should be an operator policy limit, not simply the wallet's full balance.

This is important because multiple services may share one MetaBot wallet. For example:

- `BTC -> SPACE` and `DOGE -> SPACE` can both consume `SPACE`,
- but they should not both assume they can consume the entire wallet balance.

Phase 1 should therefore support per-pair inventory caps rather than a fully shared free-for-all wallet model.

Because multiple services can still share one wallet, Phase 1 should also document this operator rule:

- overlapping pair caps must be configured conservatively,
- Phase 1 does not include a cross-service reservation or concurrency allocator yet.

## 9. Settlement and Refund Rules

The Phase 1 ordinary-skill simulation should treat market-maker settlement verification as its own business rule set.

It should not inherit the looser behavior currently used by the generic `orderPayment` flow, because that generic service-order verifier currently:

- allows tolerance around the paid amount,
- and may allow network lookup failures to pass through as effectively paid.

`metabot-mm-basic` instead requires:

- strict amount matching,
- an explicit short retry window for missing tx lookup,
- deterministic refund-or-void outcomes.

Amount parsing rule:

- requested amounts and observed paid amounts must both be normalized into integer base units before comparison,
- Phase 1 should reject input amounts that exceed the supported decimal precision of the asset instead of silently rounding,
- strict amount matching means equality of normalized integer base units, not equality of raw decimal strings.

### 9.0 Idempotency and Replay Protection

Phase 1 must define a terminal-outcome idempotency rule before any real-funds execution is considered safe.

At minimum:

- one `pay_txid` must never be paid out more than once,
- one `pay_txid` must never be refunded more than once,
- duplicate execute calls for the same payment proof must return the already-recorded terminal outcome,
- if Phase 1 simulation does not yet persist this state, it must at least expose a deterministic idempotency key contract for the later persistent implementation.

The preferred future key is:

- `service_order_pin_id + pay_txid`

For ordinary-skill simulation without a real service order, the fallback key may be:

- `pay_txid + pair + direction + payer_globalmetaid`

### 9.1 Success Path

On successful settlement, the skill should:

1. verify the requested pair and direction,
2. verify the txid and input-chain payment proof,
3. verify strict amount matching,
4. verify the current trade is still within configured limits,
5. recompute the latest executable price,
6. verify sufficient output-side inventory,
7. send the output asset to the payer's resolved address on the output chain.

For exact-in settlement, the executed output should always be rounded down to the asset's supported precision. If the rounded output falls below the chain's minimum transferable or dust-safe amount, the trade should not execute and should refund instead.

### 9.1A Payment Proof Requirements

A payment should count as valid only if all of these are true:

- the txid is discoverable from the selected chain's mempool or raw-tx source,
- the tx is on the expected input chain for the selected direction,
- the tx contains payment to the bot's designated receiving address on that chain,
- the summed value paid to that receiving address matches the expected input amount exactly,
- the tx is not already consumed by a prior terminal outcome for the same market-maker flow.

If chain-specific risk signals are available in Phase 1, they may be recorded for telemetry, but they are not yet mandatory blockers unless explicitly enabled later.

### 9.2 Address Resolution

For the future service-order flow, both success payout and refund should resolve addresses from the `globalmetaid` that created the order.

That is preferable to:

- user-entered addresses,
- UTXO input-address guessing,
- ad hoc chain parsing from raw tx inputs.

The core app should expose a generic way to resolve the `BTC`, `SPACE`, and `DOGE` addresses associated with a known `globalmetaid`.

That resolver should be treated as a future integration prerequisite, not as an already-available core contract.

For Phase 1 ordinary-skill simulation:

- tests may pass resolved payout and refund addresses through the structured payload,
- or use test doubles for address resolution,
- while keeping the future marketplace target semantics tied to the order creator's `globalmetaid`.

### 9.3 Amount Mismatch

If the actual paid amount does not exactly match the requested input amount:

- do not execute,
- refund the input asset,
- treat the refund fee as borne by Bot A, the payer.

In practical terms, Phase 1 should interpret this as:

- the refund result may be net of the refund-chain fee,
- the user-facing result should clearly say that the payer bore the refund fee.

### 9.4 Insufficient Inventory

If the bot does not have enough usable output-side inventory:

- do not partially fill,
- refund the input asset,
- treat the refund fee as borne by Bot B.

In practical terms, Phase 1 should interpret this as:

- the target user outcome is a full principal refund,
- Bot B is responsible for funding any required refund-chain fee from its own operational balance when the chain path supports that behavior.

### 9.5 Txid Lookup Window

In the future service-order flow, if Bot B receives the order but cannot immediately resolve the referenced txid:

- retry once after about 5 seconds,
- if it still cannot resolve the txid, mark the attempt void.

This is intentionally a short retry window because service-order publication and payment are expected to be near-synchronous.

Late-payment rule:

- if the tx later becomes discoverable after the attempt was voided, it must not execute against the expired attempt,
- it should instead be treated as a late-payment reconciliation case,
- the safe default outcome for that late payment is refund rather than delayed execution at a stale context,
- the implementation must leave an operator-visible reconciliation record rather than silently dropping the late payment.

### 9.6 Zero-Confirmation Policy

Phase 1 should settle on zero confirmation by default.

However, the design should preserve an extension point for additional mempool-level risk checks, especially for:

- `BTC`
- `DOGE`

Examples of future checks:

- RBF detection,
- abnormal fee-rate checks,
- double-spend suspicion checks.

These are not mandatory blocking rules in Phase 1.

## 10. Service-Order and A2A Boundary

The future marketplace flow should treat the generic `service-order` protocol as generic. It should not be filled with market-maker-specific fields such as quote snapshots.

Instead:

- `service-order` should stay minimal and broadly reusable,
- quote details, negotiation, and confirmation evidence should live in A2A private chat,
- execution uses both the generic order proof and the relevant on-chain payment proof.

This keeps `service-order` suitable for many services, not only market making.

The current Gig Square publish/order model still assumes:

- a fixed service price,
- a fixed payment currency,
- a single payment address,
- and an order message with one payment amount plus one txid.

That is sufficient reason to keep full marketplace integration out of Phase 1. A later phase should add a dedicated design for how market-priced swap services fit into that model.

## 11. Skill Architecture

Phase 1 should split the skill into two clear layers.

### 11.1 SKILL.md Layer

`SKILL.md` should:

- understand user intent in natural language,
- explain supported pairs and limits,
- distinguish between quote-only and execute-now requests,
- explain that direct market requests settle at the latest executable price,
- route work into structured script calls,
- present user-facing success, preview, and refund outcomes clearly.

The writing style should follow the stronger built-in skills in this repo such as:

- `metabot-omni-caster`
- `metabot-post-buzz`
- `skill-creator`

Do not model the final `SKILL.md` after the current simplified `metabot-trade-mvcswap` style.

### 11.2 Script Layer

The script layer should accept structured input and perform deterministic execution.

To align with the current skill runner, the skill should expose a discoverable script entrypoint such as:

- `SKILLs/metabot-mm-basic/scripts/index.js`

That entrypoint should support:

- `--payload '<json>'` for structured execution,
- and may optionally support plain natural-language argv input for direct local testing.

Recommended modules:

- `payload` or `intent`
- `config`
- `marketData`
- `pricing`
- `paymentProof`
- `execution`
- `formatter`

This execution core should later be reusable from service-square and A2A orchestration without rewriting pricing or refund logic.

## 12. Structured Payload Model

Phase 1 ordinary-skill testing should support both:

- natural-language entry via `SKILL.md`,
- direct structured payload execution for deterministic testing.

A representative payload shape is:

```json
{
  "mode": "quote | execute",
  "service": {
    "pair": "BTC/SPACE",
    "direction": "btc_to_space"
  },
  "order": {
    "amount_in": "0.0001",
    "asset_in": "BTC",
    "service_order_pin_id": "optional-for-phase-1-sim",
    "pay_txid": "optional-for-phase-1-sim",
    "payer_globalmetaid": "user-globalmetaid",
    "payout_address": "phase1-sim-output-address",
    "refund_address": "phase1-sim-input-address"
  },
  "quote_context": {
    "has_prior_quote": true,
    "slippage_bps": 100,
    "quoted_output": "1000",
    "quoted_price": "10000000",
    "quoted_at": "2026-03-28T12:00:00Z"
  }
}
```

This is an internal execution contract for Phase 1 simulation. It does not prescribe the final marketplace protocol shape.

Field authority rule:

- `service.pair` and `service.direction` are authoritative,
- `order.asset_in` is optional cross-check data only,
- if `order.asset_in` is present and disagrees with the derived input asset from pair plus direction, the request is invalid,
- `order.payout_address` and `order.refund_address` are the explicit Phase 1 simulation seam for deterministic settlement before remote multi-chain address resolution exists in core.

## 13. Configuration Model

The Phase 1 skill should read its operator configuration from a local JSON file and re-read it on each quote or execution request so operator changes take effect without code changes.

Illustrative structure:

```json
{
  "market_data": {
    "provider": "cex",
    "quote_fallback_enabled": true,
    "execute_fallback_enabled": false
  },
  "pairs": {
    "BTC/SPACE": {
      "enabled": true,
      "fair_value_fallback": 1333867.53,
      "spread_bps": 200,
      "inventory_sensitivity_bps": 500,
      "max_skew_bps": 300,
      "target_inventory": {
        "BTC": "1.0",
        "SPACE": "100000"
      },
      "max_usable_inventory": {
        "BTC": "0.8",
        "SPACE": "60000"
      },
      "trade_limits": {
        "min_in_BTC": "0.0001",
        "max_in_BTC": "0.01",
        "min_in_SPACE": "100",
        "max_in_SPACE": "5000"
      }
    },
    "DOGE/SPACE": {
      "enabled": true,
      "fair_value_fallback": 1.842629,
      "spread_bps": 200,
      "inventory_sensitivity_bps": 500,
      "max_skew_bps": 300,
      "target_inventory": {
        "DOGE": "10000",
        "SPACE": "100000"
      },
      "max_usable_inventory": {
        "DOGE": "8000",
        "SPACE": "40000"
      },
      "trade_limits": {
        "min_in_DOGE": "10",
        "max_in_DOGE": "1000",
        "min_in_SPACE": "100",
        "max_in_SPACE": "5000"
      }
    }
  }
}
```

## 14. Execution States

Phase 1 does not need a complex persistent state machine, but the execution core should still use stable conceptual states:

- `quoted`
- `pending_payment_proof`
- `validated`
- `executed`
- `refund_required`
- `refunded`
- `void`

These states are useful for tests, logs, formatting, and future marketplace integration.

## 15. Error Handling

The skill should prefer user-facing business errors over raw low-level failures.

Examples:

- unsupported pair or direction,
- amount below minimum,
- amount above maximum,
- payment proof not found,
- amount mismatch,
- inventory insufficient,
- fair-value source unavailable and no fallback configured,
- payout failed,
- refund failed.

Phase 1 should report enough detail for operators to understand what happened, but should still keep user-facing messages concise and actionable.

## 16. Testing Strategy

Phase 1 should include both deterministic script tests and skill-routing tests.

Recommended coverage:

- pricing engine
- inventory skew direction and clamp behavior
- supported-pair listing
- quote flow
- direct market execution
- quote-then-confirm with slippage protection
- strict amount mismatch refund
- insufficient inventory refund
- min/max trade limit enforcement
- config reload behavior
- natural-language routing in `SKILL.md`

The first implementation phase should focus on ordinary-skill simulation, not full service-square execution, so tests should primarily validate the execution core and the skill contract.

## 17. Future Evolution

This design should leave room for:

- `BTC <-> DOGE`
- asymmetric spread
- inventory-based spread widening
- external market-data redundancy
- mempool risk checks for `BTC` and `DOGE`
- marketplace service-order integration
- eventual AMM-style or virtual-pool pricing as a separate pricing engine

Phase 1 should not pretend to be an AMM. If AMM or virtual-pool logic is added later, treat it as a separate pricing model rather than forcing this inventory-based quote engine into a constant-product design.
