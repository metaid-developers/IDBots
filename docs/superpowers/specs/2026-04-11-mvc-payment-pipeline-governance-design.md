# MVC Payment Pipeline Governance Design

**Goal:** Unify every MVC on-chain/payment flow behind one shared spend pipeline so MetaBots can reliably send pings, heartbeats, protocol pins, file uploads, payments, and transfers without stale-UTXO induced `[-25]Missing inputs]` failures.

**Scope:** This first governance pass covers all MVC spend paths only. BTC and DOGE are out of scope for spend-strategy changes in this round, but the resulting architecture must leave a clean extension point for them.

## Problem

The current codebase has multiple independent MVC spend paths:

- `createPinWorker` for heartbeats, pings, simple messages, and many protocol pins
- `transferMvcWorker` / `transferService` for MVC transfers and Gig Square payment execution
- file upload / metafile merge flows that trigger their own transaction-building behavior downstream

These paths have diverged in both UTXO selection and broadcast behavior. In practice:

- Metalet `utxo-list` can return stale confirmed outpoints while newer unconfirmed change UTXOs are the actually spendable path
- some local flows were reordering UTXOs into confirmed-first order, which is worse for this environment
- some flows retried on stale-input errors while others still failed on first broadcast
- there is no single local concurrency rule for “one MetaBot, one MVC wallet, one spend pipeline”

This produces inconsistent user outcomes: one action succeeds, another action from the same wallet immediately fails with `[-25]Missing inputs`, even though both are logically just “spend MVC UTXOs”.

## User Outcome

After this work:

- the same MetaBot can send heartbeats, pings, messages, files, and payments through one consistent MVC spend policy
- stale-input failures are retried locally using next candidate outpoints instead of surfacing immediately to the user
- concurrent MVC actions from one MetaBot are serialized locally, so heartbeats, payments, and file uploads do not race each other for the same change output
- logs show which outpoints were tried, which were blacklisted as stale, and why a request finally succeeded or failed

## Recommended Architecture

Use a three-layer MVC spend architecture.

### 1. Action Adapters

Each business flow should describe its intent in a narrow adapter instead of constructing or broadcasting MVC transactions directly.

Target action families:

- heartbeat
- provider ping / private message send
- create pin / protocol pin
- plain MVC transfer
- Gig Square payment
- file upload / merge transaction

Each adapter should answer:

- what outputs or protocol payloads are required
- whether the action needs plain transfer, OP_RETURN pin, or multi-step file flow
- what chain-specific fee policy applies
- what success metadata the caller expects back

### 2. Shared MVC Spend Core

Introduce one shared MVC spend core responsible for:

- fetching UTXOs from provider APIs
- preserving provider UTXO order
- selecting inputs without confirmed-first reshuffling
- broadcasting transactions
- classifying retryable stale-input failures
- blacklisting failed outpoints within the local attempt window
- returning normalized success/error results

The current `mvcSpend.ts` is the seed of this layer. It should grow into the single source of truth for:

- outpoint key derivation
- retryable broadcast error classification
- txid recovery for `txn-already-known`
- deterministic candidate selection
- reusable logging helpers

### 3. Per-MetaBot MVC Spend Coordinator

All MVC spend requests for a given `metabotId` must pass through a local coordinator that serializes spend attempts.

Coordinator responsibilities:

- one in-flight MVC spend job per `metabotId`
- queue subsequent jobs in arrival order
- preserve cancellation/error propagation to the caller
- optionally retain a short-lived “recently failed outpoint” memory for immediate follow-up requests

This is the highest-leverage improvement beyond Metalet parity. A wallet app sees fewer same-wallet concurrent actions than IDBots does. IDBots needs local orchestration, not just better transaction assembly.

## Behavioral Rules

### UTXO Selection

- Use provider order from `wallet-api/v4/mvc/address/utxo-list`
- Do not split into confirmed vs unconfirmed buckets for ordering
- Do not randomize candidates
- Skip candidates already blacklisted in the active attempt scope
- Stop when selected inputs cover outputs plus fee estimate

### Retry Behavior

Treat these as retryable stale-input failures:

- `Missing inputs`
- `missingorspent`
- `inputs missing/spent`
- `txn-mempool-conflict`

Retry policy:

- blacklist all inputs used in the failed attempt
- rebuild against fresh provider UTXO state
- retry with bounded attempts and a short delay

Treat these as terminal or differently handled:

- balance truly insufficient
- network/fetch failures
- mempool-chain-too-long / insufficient fee
- malformed payload / invalid transaction build

### Concurrency

For MVC only:

- heartbeat, ping, create pin, transfer, payment, and file-related merge transactions must all go through the same local serialization rule
- no worker should broadcast directly outside the coordinator unless explicitly declared as part of the shared spend core

## File/Module Plan

Expected core touch points:

- `src/main/libs/mvcSpend.ts`
  Shared MVC spend primitives and error classification

- `src/main/libs/createPinWorker.ts`
  Convert into an adapter on top of shared MVC spend behavior

- `src/main/libs/transferMvcWorker.ts`
  Convert into an adapter on top of shared MVC spend behavior

- `src/main/services/transferService.ts`
  Stop duplicating worker/broadcast policy; rely on normalized worker/coordinator behavior

- `src/main/services/metaidCore.ts`
  Route MVC pin-related workers through the shared governance path

- `src/main/services/providerPingService.ts`
  Ensure ping creation uses the coordinator path rather than direct unsynchronized spend

- `src/main/services/heartbeatService.ts`
  Same requirement: heartbeats must be scheduled through the same coordinator

- file upload / metafile merge related services
  Any direct MVC transaction building or merge broadcast path must be identified and adapted into the same governance layer

Potential new module:

- `src/main/services/mvcSpendCoordinator.ts`
  Per-MetaBot serialization queue and normalized execution entrypoint

## Logging and Observability

Every MVC spend attempt should emit structured logs with:

- action type
- metabot id
- candidate outpoints fetched
- picked outpoints per attempt
- stale-outpoint blacklist updates
- retry count
- final txid on success
- normalized failure classification on error

This should be enough to explain “why did this payment fail?” without reproducing from scratch.

## Testing Strategy

### Unit Tests

Add or expand tests for:

- provider-order UTXO selection
- stale-outpoint blacklist behavior
- retry classification rules
- txid recovery for already-known responses
- per-MetaBot queue serialization behavior

### Integration-Focused Tests

Cover representative MVC action families:

- create pin / simplemsg path
- transfer/payment path
- file merge path if a distinct transaction builder exists

### Manual/Reality Checks

Use a real local MetaBot wallet such as `AI_Sunny` for repeatable CLI-level smoke checks:

- heartbeat-style pin send
- minimal MVC transfer
- Gig Square pay-and-request
- file upload or metafile merge flow

## Non-Goals

- full BTC spend-strategy rewrite in this round
- full DOGE spend-strategy rewrite in this round
- remote service or Metalet backend changes
- changing business semantics of Gig Square orders or file upload UX

## Risks

- some file upload or merge behavior may be implemented in a different codepath than current PIN/transfer workers; discovery is required before claiming full coverage
- over-centralizing too quickly could break distinct transaction shapes if adapters are not kept thin and explicit
- queueing all MVC spends per MetaBot may expose latent UX assumptions about immediate parallel execution; callers must tolerate async sequencing

## Success Criteria

This design is successful when:

- AI_Sunny can complete ping, heartbeat, standard pin/message send, MVC payment, MVC transfer, and file upload/merge without the known stale-UTXO failure class
- all MVC spend actions share one spend policy and one concurrency rule
- logs are sufficient to distinguish stale-input, low-balance, fetch/network, and fee-related failures
- BTC and DOGE codepaths remain behaviorally unchanged while the architecture now clearly supports later alignment
