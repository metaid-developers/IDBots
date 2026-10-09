# FIX-NOTES: dream pipeline timeout batch failures (fix/dream-consolidation-timeout)

> English translation of the original Chinese branch notes (repo language
> convention); translated when the work landed as PR #69. The original
> planning line "do not push, do not open a PR (execute after Mon's
> acceptance)" is superseded by that merge.

- Branch: `fix/dream-consolidation-timeout`, based on the fork's
  (WuFenG-Hub/IDBots) then-latest main `9d221ac9` ("Merge branch
  'fix/mac-x64-artifact-naming'").
- Scope: the dream pipeline only (dreamService / dreamRetryPolicy / the
  dreamPrompt scheduler side / one dreamStore read-path line / one main.ts UI
  line).

## 1. Root causes (aligned with Mon's autopsy)

1. **Fixed per-call timeout too tight.** `dreamService.ts` pinned the
   synthesis/self-identity calls to `DREAM_SYNTHESIS_TIMEOUT_MS = 600_000`
   (10 minutes, previously 180s), while deep-consolidation calls measured a
   legitimate 8–38 minutes (30K+ token prompts at flash-tier ~20-25 tok/s
   emitting the full dream JSON). On burst days the legitimate calls hit the
   wall and `The operation was aborted due to timeout` failed in batches
   (4/7 runs in the 10-07 cycle).
2. **No in-run backoff.** Retries re-collided in place with the same
   saturated provider inside the same window; every failed run's duration
   pinned at exactly 30 minutes (the signature of the run-level budget being
   sliced away by timeouts).
3. **Terminal too early.** Once the retry budget
   (`DREAM_RETRY_MAX_ATTEMPTS = 5`) was exhausted, timeout-class failures
   were judged `terminal-failed` the same as deterministic 4xx — but a
   timeout means "the window was too small / another window can fix it", so
   it should not be terminal.

## 2. Changes

### `src/main/libs/dreamRetryPolicy.ts` (new policy layer; classifyDreamError semantics untouched)
- `DREAM_ATTEMPT_TIMEOUT_TIERS_MS = [10min, 20min, 38min]` +
  `resolveDreamAttemptTimeoutMs(attemptCount)`: the per-call window escalates
  adaptively with the run's attemptCount; the 38-minute top tier is sized
  from the worst measured legitimate call — slower than that is a genuine
  stall and SHOULD abort.
- `DREAM_RUN_BUDGET_MS = 30min` + `DREAM_MIN_CALL_WINDOW_MS = 10min` +
  `remainingRunBudgetMs()`: the run-level wall. When the remaining budget
  cannot let a legitimate full-JSON call even START, a retryable sentinel
  hands the date back to the scheduler for a cross-window retry instead of
  queueing another doomed call inside this run.
- `isRateLimitError()` (anchored to the `LLM request failed: <status>`
  passthrough + rate-limit prose) and `isTimeoutError()` (the
  `aborted due to timeout` text / the `TimeoutError` name / the run-budget
  sentinel).
- `computeDreamBackoffDelayMs()`: exponential backoff ladder **2/5/15
  minutes**; 429/rate-limit or consecutive timeouts (≥2) stretch to
  **≥10 minutes** (`DREAM_BACKOFF_RATE_LIMIT_FLOOR_MS`).

### `src/main/services/dreamService.ts`
- Synthesis/self-identity windows become
  `resolveSynthesisTimeoutMs(runStartedAtMs, attemptCount)`: attempt tier ∩
  remaining run budget (floored at 60s); when < 10 minutes remain, throws
  the retryable sentinel `dream run budget exhausted …` (fallback-path
  behavior unchanged — the per-attempt window still rides llmFallback's
  primary→fallback dual window).
- Catch branch: timeout-class failures (including the budget sentinel)
  **never become terminal-failed**, regardless of whether attemptCount has
  reached the cap — they stay "to be retried" across windows; the H-80
  terminal semantics for deterministic 4xx are preserved verbatim.
- Fragment calls keep the lean default (`DREAM_LLM_TIMEOUT_MS = 180s`,
  measured ≤80s per fragment); the `DREAM_SYNTHESIS_TIMEOUT_MS` constant
  survives as the first-tier anchor (test / external-wiring compatibility).

### `src/main/libs/dreamPrompt.ts` (scheduler side) + `src/main/dreamStore.ts` + `src/main/main.ts`
- `computeDreamRetryDelayMs(attemptCount, lastError?)` now rides the new
  ladder (the old implementation was a 30-min base with a 6h cap — too long
  across windows and in conflict with the 2/5/15 requirement); with a
  lastError it escalates to ≥10min on rate-limit / consecutive timeouts. The
  old constants `DREAM_RETRY_BASE_DELAY_MS / MAX_DELAY_MS` stay exported
  (compatibility).
- `DreamRunStateLike` gains `error?`; the `dreamStore.getRunStates` SELECT
  adds the `error` column; `computeDueDreamDates` feeds the error text into
  the backoff computation.
- `main.ts` passes `run.error` into the dream-failure-fallback's
  `nextRetryAt` (DreamRun already carried the error field; no schema change).

### Unchanged but related (disclosure)
- `memoryHygieneService.ts`'s `DEEP_CONSOLIDATION_LLM_TIMEOUT_MS` is the
  same fixed-600s value in the same symptom family; this task's authorized
  scope was the dream pipeline, so it was left alone. If the 10-07
  "unparseable output (30k+)" side recurs, the next task should align it to
  the same tier mechanism.

## 3. Test evidence

- Updated 3 existing cases that asserted the old 30-min baseline
  (dreamPrompt.test.mjs ×2, dreamRetryPolicy.test.mjs ×1) to the new ladder,
  with comments explaining the change.
- New cases:
  - `dreamRetryPolicy.test.mjs`: tier function (1→600s / 2→1200s /
    ≥3→2280s / garbage normalized), `remainingRunBudgetMs`,
    `isTimeoutError`/`isRateLimitError` on real samples (including the
    1429ms number trap), `computeDreamBackoffDelayMs` ladder + escalation,
    and scheduler-level "timeout rows wait ≥10min, 429 rows ≥10min, plain
    500 rows take the 5-min tier".
  - `dreamService.test.mjs`: ① an attempt-2 synthesis call actually receives
    the 1_200_000 window (adaptive tiers working); ② timeout-class errors at
    attempt ≥ cap end `failed` (retryable across windows), not
    `terminal-failed`; ③ non-regression: a deterministic 400 at the cap is
    still terminal-failed.
- Results (`node --test` after a local compile):
  - `dreamRetryPolicy + dreamPrompt`: **42/42 pass**
  - `dreamService.test.mjs`: **19/19 pass**
  - `dreamStore + dreamTelemetrySeries`: **11/11 pass**
  - `memoryHygieneService + llmFallback + cognitiveChatCompletion`: 30 pass /
    0 fail / **3 cancelled** — those 3 are a pre-existing
    `tests/llmFallback.test.mjs` flake ("Promise resolution is still
    pending…") that reproduces identically on a pristine checkout
    (llmFallback.ts has zero diff against fork/main); unrelated to this
    change, logged as M-32 in `idbots-longterm-retro-issue-log.md`.

## 4. Environment notes
- This git worktree had no node_modules; the compile used a symlink back to
  the main checkout's `IDBots/node_modules` (`ln -s ../IDBots/node_modules
  node_modules`; no file in the main checkout was touched). pnpm was not on
  PATH, so `compile:electron` was replicated equivalently via
  `npx -p typescript@5 tsc --project electron-tsconfig.json && node
  scripts/copy-electron-js.cjs`.

## 5. Behavior change summary (acceptance quick reference)
| Scenario | Old behavior | New behavior |
|---|---|---|
| Burst-day synthesis call (legitimate 8–38min) | hits the fixed 10-min wall, both brains explode | 10/20/38-min tiers escalate with attempts, ∩ remaining run budget |
| 429/rate-limit retry | 30-min-base exponential backoff, rate-limit blind | 2/5/15-min ladder; rate limits stretch to ≥10min |
| Consecutive-timeout retry | in-place collisions until the budget burns | ≥2 consecutive timeouts back off ≥10min, staggered across windows |
| Timeout-class failure burning all 5 attempts | terminal-failed | stays `failed` (to be retried), auto-retries in a later window |
| Run-level budget exhausted | keeps queueing doomed calls until exactly 30min | yields via the sentinel below 10min remaining, retries across windows |
