# Backend Requirements — Plan-Aware LLM Relay Admission Quota (assist-base-service)

## Status

Draft v0.1 change request, 2026-11-10. Origin: production incident — a user upgraded from ID.Free to ID.Scholar through the admin panel kept hitting the free tier's weekly LLM relay cap and their bots died mid-task with HTTP 429 `free_quota_exhausted`. Target project: `assist-base-service` LLM relay (`/v2/assist/llm/*`). This document is a requirements contract for the ABS team; the desktop client needs no change for it (it renders whatever the relay reports).

## 1. Incident

1. Operator opened an ID.Scholar subscription for the user's identity via `POST /v1/admin/me/subscriptions/open` → `me_service.OpenSubscription` (`service/me_service/subscription_service.go`). `tb_me_subscription` flips active with `planId = <ID.Scholar>` and the first ME weekly entitlement is materialized.
2. The desktop client shows "current plan: ID.Scholar" (`GET /v1/me/subscription` → `SubscriptionView.planId` from `ResolveCycle`), and the ME panel shows the plan's weekly grant.
3. The user's bot works normally until roughly the free tier's weekly allowance is consumed (~2000 as counted by the user), then every LLM turn dies mid-work with `429 insufficient_quota / free_quota_exhausted`.
4. The client is a faithful messenger here: the 429 and machine code come straight off the relay wire (`src/main/libs/coworkOpenAICompatProxy.ts` preserves upstream error codes; `tests/coworkProxyTransientRetry.test.mjs` pins that this class is terminal).

Forensics for the affected identity (server side, `<addr>` = `tb_me_subscription.identityAddress`):

```sql
-- the subscription the admin opened
SELECT identity_address, plan_id, status, period_start, period_end
  FROM tb_me_subscription WHERE identity_address = '<addr>';

-- the relay account the identity actually chats through
SELECT identity_address, granted_tokens, used_tokens, adjusted_tokens,
       purchased_tokens, purchased_used_tokens, create_time
  FROM tb_llm_relay_account WHERE identity_address = '<addr>';

-- this week's chat-pool points (the number admission compares against the pool)
SELECT COALESCE(SUM(quota_points), 0) AS week_points
  FROM tb_llm_relay_usage
 WHERE identity_address = '<addr>' AND status = 1
   AND timestamp >= <current cycle start, per llmWeeklyCycleStart>;
```

Expected finding: `week_points` ≈ the configured `llm.free_quota_points` while the subscription row is active — the subscriber's pool is exactly the free tier's.

## 2. Root cause (code-referenced, verified against the current tree)

**The LLM relay admission gate is completely blind to subscriptions.** Nothing under `service/llm_relay_service/` reads `tb_me_subscription`, `tb_me_plan`, or `tb_me_entitlement` (the only subscription reference is `economics_service.go`, which joins `tb_me_subscription` for revenue attribution — reporting, not admission). The chain:

1. `controller/llm_relay_controller.go` `LlmRelayChatCompletions` step 4 calls `llm_relay_service.AdmitLlmRelayChat(account, model)`.
2. `service/llm_relay_service/quota_service.go` `AdmitLlmRelayChat` → weekly mode: `decideLlmChatPool(llmFreePoolTotal(account) - llmChatPoolUsedPoints(...), account.PurchasedTokens, account.PurchasedUsedTokens)`.
3. `llmFreePoolTotal` = global `conf.LlmConfigData.FreeQuotaPoints` (`llm.free_quota_points`, one value for **all** identities) + `account.AdjustedTokens` (signed admin adjustments only). No plan term exists.
4. `decideLlmChatPool`: free remaining ≤ 0 and `purchased_tokens == 0` → `ErrLlmRelayQuotaExhausted` → `controller/llm_relay_controller.go:61` maps to HTTP 429 `free_quota_exhausted`. A subscriber who never bought a token bundle always takes this branch.

The two quota systems evolved in parallel and only touch after settlement:

| System | Plan-aware? | Role |
|---|---|---|
| ME subscription + weekly entitlement (`tb_me_subscription` / `tb_me_entitlement`, `pools_service.go` `ResolveCycle`) | yes | billing ledger; deducted by the ME metering burn |
| Relay admission pool (`tb_llm_relay_account` + `llm.free_quota_points` + bundle `purchased_tokens`) | **no** | per-request admission gate that returns 429 |
| ME metering burn (`me_metering_hook.go` `BurnMeForRelayUsage` → `me_service.ReportMeteringEvent`) | yes | post-settlement, best-effort, no-ops while `metering_enabled` is off; never feeds back into admission |

Net effect: **every paying subscriber — admin-opened or purchased — is walled at the free tier's weekly relay pool.** The plan raises the billing ledger but not the gate that actually stops the user's work.

The same blindness extends to:
- the **JEV (cerebellum) pool** — `jev_service.go` `CheckLlmJevQuota` sizes against the global `llm.jev.free_quota_tokens` only;
- the **quota surface** — `bootstrap_service.go` / `LlmChatQuotaSnapshotForAccount` report free + purchased pools only, so the desktop's quota card and nudge banner show free-tier numbers to a paying subscriber (this is why "the plan is ID.Scholar but the quota behaves like ID.Free" is visible end to end).

## 3. Required behavior

### R1 — Chat admission scales with the active subscription (blocking)

For an identity holding an active paid subscription, the effective weekly chat-pool total must reflect the subscription instead of the bare free tier. ABS chooses the mechanism; two acceptable shapes:

- **Option A (recommended): per-plan column.** Add e.g. `llm_weekly_points BIGINT` to `tb_me_plan` (admin-editable via the existing plan admin API), and size the pool as `GREATEST(llm.free_quota_points, plan.llm_weekly_points)` when the identity has an active subscription covering now. Explicit, auditable, no unit conversion hidden in code.
- **Option B: derive from the entitlement.** Convert the current cycle's `window.AmountMilli` (ME) into relay points via the metering base rate (`llmMePerMillion`), with the result floored at `llm.free_quota_points`. No new column, but couples admission to a SECRET config and breaks silently if rates change.

Requirements independent of the chosen shape:

1. Plan changes take effect on the next admission check — no restart, no client action, no per-account backfill job (size the pool live at admission time).
2. Expiry falls back automatically: past `period_end` (including the `ExpireDueSubscriptions` sweep) the pool is the plain free tier again. Never widen the pool for an expired row.
3. Cycle semantics reuse the existing weekly anchor (`llmWeeklyCycleStart`) so admission, the quota surface, and the client's reset countdown stay on one clock. A residual first cycle follows the same `ResolveCycle` proration the ME side uses.
4. The admin adjustment (`account.adjusted_tokens`, `ApplyAdminLlmQuotaAdjustment`) keeps working on top of the plan-sized base, negative drain included.
5. The C4 signal contract is preserved: `free_quota_exhausted` only for identities that never had purchased quota; `quota_exhausted` once a purchased pool drains. Free→purchased fall-through order unchanged.
6. Degraded reads must not 5xx the hot path: if the subscription/plan row cannot be read at admission time, fall back to the free pool (the request must still be servable or refused with the normal quota code, never an error envelope that clients retry against).

### R2 — Quota surface reports the plan-sized numbers (blocking)

`/v2/assist/llm/bootstrap` and `/v2/assist/llm/quota` must return `quotaTotal` / `quotaUsed` / `quotaRemaining` / `quotaCycleResetAt` computed from the same plan-sized pool as admission. The desktop consumes these verbatim (`llmRelayService.ts` → `llmFreeQuotaGate.js` percentage math → `QuotaNudgeBanner`), so without this the subscriber keeps seeing free-tier numbers and the rename/plan UI keeps contradicting the quota card.

### R3 — JEV pool parity (follow-up phase acceptable)

`CheckLlmJevQuota` should scale with the plan the same way, so cerebellum usage does not hit the same wall one model line later. Chat is the blocking pool; JEV can ship in a second step, but the chosen mechanism (R1 Option A column vs Option B derivation) should cover both from day one.

### R4 — Ops & compatibility

1. No behavior change for identities without an active paid subscription — the free tier's numbers, codes, and cycle reset stay byte-identical.
2. Deploy order is unconstrained: the change is additive and read-only at admission; subscribers get the larger pool on their first request after deploy.
3. Update the relay contract docs (`docs/llm-relay-integration.md` / `LLM 免费额度对接文档.md`) with the chosen sizing formula, the new column, and its admin path.
4. `go build` + full `go test ./...` green; add table-driven tests mirroring `quota_weekly_test.go` / `quota_purchased_test.go` for the plan-sized branch (active, residual cycle, expired, never-subscribed, unreadable row).

## 4. Acceptance criteria

1. Free identity: unchanged behavior — 429 `free_quota_exhausted` exactly at the free pool boundary.
2. Identity with an active ID.Scholar subscription (admin-opened): chat admission continues past the free-tier cap; the quota endpoint reports the plan-sized total/remaining.
3. Subscription expires mid-cycle: subsequent cycles (or the expiry sweep) drop back to the free pool; no 500s, no stale widened pool.
4. Identity with a purchased bundle: the free→purchased ladder and both exhaustion codes unchanged.
5. Weekly reset refills to the plan-sized total while the subscription is active.
6. The desktop client (any recent build) shows quota numbers matching the plan for the subscriber without any client-side change.

## 5. Client context (informational)

Shipped alongside this request on the desktop side (branch `fix/subscription-plan-quota`, no server dependency):

- the built-in relay provider's user-facing label changed `IDBots-Free` → `ID.Bots` (plan-neutral; a "-Free" label on a paying subscriber's screen reads as "you are still on the free tier");
- new installs default to the relay's DeepSeek flash model (`deepseek-4.1-flash` / legacy `deepseek-chat`) regardless of the relay directory order.

Neither affects the wire contract; both are cosmetic/default-policy only.
