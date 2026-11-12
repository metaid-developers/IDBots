# Backend Requirements — ME-Authoritative Relay Admission

## Status

Blocking follow-up to `me-llm-relay-plan-quota-backend-requirements.md`, verified on staging on 2026-11-12. Target project: `assist-base-service`. The IDBots repository change only corrects the client diagnosis; it does not implement this server-side admission fix and must not be presented as a completed chat-billing fix.

## 1. Reproduction and root cause

A free-tier staging identity with no active paid subscription has:

- `GET /v1/me/balance`: `weeklyGrant.remainingMilli = 864429`;
- `spendableMilli = 864429`, `totalAvailable = 864429`, `frozenMilli = 0`;
- `autoDeductFromPersistent = true`;
- the same identity's chat turn rejected by the official relay with HTTP 429 `quota_exhausted` (the legacy token-pool error; the client's old wrapper then described it as a free-allowance death).

The 864 ME is therefore real, currently spendable weekly credit, not a frozen balance, a disabled persistent pool, or a different identity. No phone number, mnemonic, relay key, or full identity address belongs in the test record.

The server has two independent admission and billing systems:

1. `service/llm_relay_service/quota_service.go` `AdmitLlmRelayChat` admits against the legacy free/plan/purchased token pools. `b1474d6` widens the legacy pool for active paid plans, but does not make ME the admission authority for a free-tier identity.
2. `service/llm_relay_service/me_metering_hook.go` `BurnMeForRelayUsage` burns ME only after a successful upstream call and settlement. It cannot let an identity with spendable ME past the earlier legacy rejection, and a rejection after delivery cannot undo the upstream cost.

The same split exists in `CheckLlmJevQuota`. Vision and web-tools admission also retain their own legacy gates and must be included in the unified billing audit rather than assumed to be fixed by chat alone.

## 2. Required behavior

### R1 — One charging source for official usage

When ME and ME metering are enabled, every non-free official relay request must be authorized and charged in ME. The legacy free/plan/purchased pools must not independently reject or deduct that request. A legacy purchased-token balance is not ME and must not be silently discarded; migrate its remaining value explicitly and idempotently, or keep it on the legacy billing path until migrated.

A deliberately free public model may bypass ME only when its authoritative public ME price is zero. An unknown model or missing rate must not become free by default.

### R2 — Reserve before calling the upstream

Generate the request identifier before admission. Atomically reserve a conservative upper bound for the call before spending upstream tokens:

- prompt tokens from the prepared request, using the existing validated estimator;
- output tokens bounded by the request and model's effective `max_tokens` clamp;
- the same model/resource multiplier used for final settlement;
- the standard weekly-grant-first deduction order and the per-identity `autoDeductFromPersistent` setting;
- the applicable metering daily limit and existing frozen holds.

Do not use a mere `spendableMilli > 0` check as the whole authorization if it allows a request whose maximum charge exceeds the balance. Insufficient funds return a structured, non-retryable `INSUFFICIENT_ME` rejection. A disabled persistent-deduction setting must retain the existing shortfall semantics instead of reporting an empty total balance.

A rate/configuration/read failure must produce a billing-unavailable response without upstream spend. It must not silently fall back to the legacy pool, skip charging, or expose secret base rates.

### R3 — Settle actual usage exactly once

On success, capture the actual measured charge and release the unused reservation in the same idempotent accounting flow. On upstream rejection, cancellation, or a failed request with no billable upstream usage, release the reservation. Partial streams use actual measured usage. Client disconnects and unknown outcomes need a durable reconciliation path; they must not cause duplicate charges or abandoned permanent holds.

A replay of the same event returns the original result without another deduction. ME-admitted requests must not also decrement the legacy free/plan/purchased pools. Preserve the public usage record for observability, but do not reuse it as a second admission currency.

### R4 — Cover cerebellum and other official model calls

Apply the same reservation/settlement path to JEV (`resourceType=agent`) and audit vision, audio, search/fetch, and other official LLM endpoints. Resource-specific rate limits and abuse controls remain, but legacy free-token/day pools must not be an independent wallet when the corresponding usage is ME-billed.

Chain traffic continues to use the existing ME `pre` freeze / `commit` capture / failure reversal flow. Do not create a second ME wallet or a competing chain-billing path.

### R5 — Quota surfaces and compatibility

Do not present an exhausted legacy pool as an empty ME account. `/v2/assist/llm/bootstrap` and `/quota` must either report the ME-authoritative state with explicit units or label legacy-token figures as legacy diagnostics; clients must not have to infer that two contradictory balances are the same wallet.

With ME or metering disabled, preserve the documented legacy behavior and its error codes. Enabling ME must not reset a user's existing entitlement, refill a drained pool, or charge both systems. Rollout and rollback need a per-request charging-source record and an idempotent migration for any unconverted legacy balance.

## 3. Acceptance tests

Add service-level and signed end-to-end coverage for at least:

1. A free-tier identity with `spendableMilli = 864429`, no active paid subscription, and an exhausted legacy pool can complete a small real chat. Its ME balance decreases by exactly the reported usage charge, with one `metering:llm` ledger entry. The old token pool does not also decrease.
2. The same scenario for JEV uses `metering:agent`, succeeds, and does not hit the legacy JEV wall.
3. Zero weekly grant with persistent credit succeeds only when auto-deduct is enabled; disabling auto-deduct returns `INSUFFICIENT_ME` without spending the persistent pools.
4. Zero spendable ME fails before any upstream call. The response is not `free_quota_exhausted` when ME admission is active.
5. Two concurrent reservations cannot exceed the available balance. Retry and settlement replay are exactly once.
6. Upstream failure, partial stream, disconnect, and timeout release or reconcile the hold without double billing.
7. Free public models, missing rates, disabled metering, and legacy purchased-token migration preserve their explicitly documented behavior.
8. Quota, balance, and history responses agree after the call and after a fresh signed read; no client restart or rekey is needed.

Run `go test ./...` and `go build ./...`, then deploy the backend through its own approved `main`-based release process. Re-run acceptance item 1 on staging before declaring the user's chat issue fixed.

## 4. IDBots client behavior while the backend is fixed

`coworkRunner` re-reads the signed ME balance after an official relay quota rejection in server mode. If the balance is positive, it emits `ME_ADMISSION_MISMATCH`; the mobile client shows a service-recovery notice instead of “ME exhausted” or a recharge button. This avoids a false billing diagnosis but cannot make the rejected turn succeed.

No C1/C2/C3/C4 transport contract change is made by that diagnostic fallback. The server-side `INSUFFICIENT_ME` envelope and the existing ME ledger remain the authoritative billing interfaces.
