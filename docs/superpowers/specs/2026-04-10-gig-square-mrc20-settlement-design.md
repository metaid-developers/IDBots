# Gig Square MRC20 Settlement Design

**Date:** 2026-04-10
**Project:** IDBots
**Status:** Approved (brainstorming)

## 1. Background

IDBots already supports displaying and sending `MRC20` assets inside the MetaBot wallet experience. The next step is to extend `MRC20` support into Gig Square so remote services can be published, ordered, paid, verified, and refunded with MetaWeb fungible tokens.

Today, Gig Square still assumes a native-coin payment model:

- service publish / modify only accepts `BTC`, `SPACE`, or `DOGE`
- buyer payment flows only execute native transfers
- seller-side payment verification only validates native chain outputs
- refund execution and refund verification also assume native transfers
- local order storage only preserves native-chain payment semantics

That model is insufficient for `MRC20`, because `MRC20` settlement uses a BTC-address token identity and a token transfer flow that is different from native `BTC` transfer.

## 2. Goal

Extend Gig Square to support `MRC20` as a first-class settlement asset across the full service lifecycle:

1. publish a skill service with `MRC20` settlement
2. modify an existing `MRC20` service
3. select the concrete `MRC20` asset from the current executing MetaBot wallet
4. pay for a service with `MRC20`
5. support remote auto-delegation payment with `MRC20`
6. verify seller-side receipt of `MRC20`
7. support `MRC20` refunds and refund verification
8. preserve enough structured local metadata for repair, resync, and future evolution

## 3. Non-Goals

This design does not include:

- adding Build in Public as an IDBots product feature
- changing the MetaBot wallet derivation model
- supporting `DOGE`-side MRC20 variants
- redesigning the whole `skill-service` protocol into a brand-new payment object format
- introducing price-oracle logic or token price normalization
- implementing DEX swaps or cross-token conversions

Build in Public remains an external development workflow used by Codex during this project. It does not change the IDBots app protocol or UI.

## 4. Chosen Strategy

Three approaches were considered:

1. string-only compatibility
2. protocol compatibility plus strong local typing
3. full protocol object redesign

The selected approach is **protocol compatibility plus strong local typing**.

That means:

- chain-facing `skill-service.currency` remains a simple string for compatibility
- `MRC20` services encode that string as `<TICKER>-MRC20`
- local records, order ledgers, message metadata, verification, and refund flows also persist structured `MRC20` identity fields

This keeps chain compatibility with existing Gig Square data patterns while avoiding brittle downstream parsing logic.

## 5. Protocol Design

### 5.1 Service Publish / Modify Payload

For native settlement, the existing behavior remains unchanged:

- `BTC`
- `SPACE`
- `DOGE`

For `MRC20` settlement:

- the primary `currency` field must be serialized as `<TICKER>-MRC20`
- `TICKER` must always be uppercased before persistence
- example: `METAID-MRC20`

In addition to the existing fields, the payload must include structured settlement metadata:

- `paymentChain: "btc"`
- `settlementKind: "mrc20"`
- `mrc20Ticker: "<UPPERCASE_TICKER>"`
- `mrc20Id: "<tick id>"`

`paymentAddress` in the `MRC20` case must be the selected provider MetaBot's `BTC` address.

### 5.2 Local Canonical Payment Asset Model

Gig Square should resolve every service or order payment asset into a canonical local shape:

```ts
type NativeSettlementAsset = {
  settlementKind: 'native';
  paymentChain: 'mvc' | 'btc' | 'doge';
  paymentCurrency: 'SPACE' | 'BTC' | 'DOGE';
};

type Mrc20SettlementAsset = {
  settlementKind: 'mrc20';
  paymentChain: 'btc';
  paymentCurrency: `${string}-MRC20`;
  mrc20Ticker: string;
  mrc20Id: string;
};
```

All downstream Gig Square logic must work from this normalized asset shape instead of ad-hoc string checks.

## 6. UI Design

### 6.1 Publish Service

`GigSquarePublishModal` should change the settlement currency selector from:

- `BTC`
- `SPACE`
- `DOGE`

to:

- `BTC`
- `SPACE`
- `DOGE`
- `MRC20`

When the user selects `MRC20`, a second selector must appear immediately to the right of the currency selector.

That second selector must:

- load from the selected executing MetaBot wallet's `mrc20Assets`
- only display assets whose displayed balance is greater than zero
- display the token ticker prominently
- submit both `mrc20Ticker` and `mrc20Id`

If the user switches the executing MetaBot while the main selector is still `MRC20`:

- the token list must refresh immediately
- the old token selection must be cleared if it is not present in the new wallet

If the user switches away from `MRC20` to a native asset:

- `mrc20Ticker` and `mrc20Id` must be cleared
- the second selector must disappear

### 6.2 Modify Service

`GigSquareMyServicesModal` must mirror the same behavior.

When opening a service that already uses `MRC20` settlement:

- the main selector must initialize to `MRC20`
- the second selector must initialize from the current service's `mrc20Ticker` / `mrc20Id`

### 6.3 Display Rules

Gig Square should continue displaying the protocol unit directly in user-visible price summaries.

Examples:

- `0.1 BTC`
- `250 SPACE`
- `100 METAID-MRC20`

That keeps UI display aligned with the chain-facing protocol string.

### 6.4 Price Validation

For native assets, the existing upper-bound behavior can remain.

For `MRC20`:

- validate only that the price is numeric and `>= 0`
- do not apply the existing BTC / SPACE / DOGE hardcoded maximum tables

## 7. Payment Execution

### 7.1 Manual Buyer Flow

`GigSquareOrderModal` must branch by normalized settlement asset:

- native settlement uses `executeTransfer()`
- `MRC20` settlement uses `executeTokenTransfer({ kind: 'mrc20' })`

For `MRC20`, the transfer input must include:

- `metabotId`
- selected `mrc20` asset identity
- provider BTC `paymentAddress`
- token amount
- BTC fee rate

### 7.2 Auto Delegation Flow

The remote delegation flow in `main.ts` must use the same payment asset resolver.

When the delegated service is `MRC20`-priced:

- delegation payment must execute via `executeTokenTransfer({ kind: 'mrc20' })`
- the local observer session metadata must persist the structured `MRC20` settlement identity

### 7.3 Canonical Payment Transaction Identity

`MRC20` transfer is a commit / reveal sequence.

For Gig Square order tracking:

- `revealTxId` is the canonical `paymentTxid`
- `commitTxId` must also be stored in structured metadata for debugging and reconciliation

## 8. Order Message Metadata

The structured order payload must expand beyond the current native-only fields.

For native settlement, existing metadata remains valid.

For `MRC20`, order metadata must additionally include:

- `payment chain: BTC`
- `settlement kind: mrc20`
- `mrc20 ticker: <UPPERCASE_TICKER>`
- `mrc20 id: <tick id>`
- `commit txid: <commit txid>` when available

This metadata must be produced consistently by:

- manual Gig Square order creation
- remote auto-delegation order creation

## 9. Seller-Side Verification

### 9.1 Native Verification

Native verification continues using the existing raw transaction output verification logic.

### 9.2 MRC20 Verification

A new dedicated verifier must be added for `MRC20` settlement.

This verifier must validate all of the following:

1. the order-declared `mrc20Id` matches the transferred asset
2. the order-declared ticker matches the transferred asset after uppercase normalization
3. the recipient address matches the service `paymentAddress`
4. the transferred token amount is greater than or equal to the expected amount in token atomic units

`MRC20` verification must not reuse the native "sum outputs to recipient address" model, because that only validates native coin transfer value.

### 9.3 Amount Comparison

`MRC20` amount comparison must use token decimals:

- buyer-facing decimal value must be converted into token atomic units with that token's own `decimal`
- verification compares token atomic units, not BTC satoshis

## 10. Refund Design

Refund handling must preserve the same settlement identity as the original order.

For native settlement:

- existing refund flow remains

For `MRC20` settlement:

- refund execution must use `executeTokenTransfer({ kind: 'mrc20' })`
- refund request payload must include `settlementKind`, `mrc20Ticker`, and `mrc20Id`
- refund finalize payload must include the same identity fields
- refund finalize verification must use the `MRC20` verifier instead of the native verifier

The refund destination address for `MRC20` remains the buyer MetaBot's `BTC` address.

## 11. Persistence and Migration

### 11.1 Service Records

Gig Square local service records must persist enough information to reconstruct the settlement asset without lossy string parsing.

At minimum, local mutation records should preserve:

- `currency`
- `paymentChain`
- `settlementKind`
- `mrc20Ticker`
- `mrc20Id`

### 11.2 Service Orders

The service order ledger must stop assuming that `paymentCurrency` is limited to `SPACE`, `BTC`, or `DOGE`.

For `MRC20`, the ledger must support values like:

- `METAID-MRC20`

The order ledger must also persist:

- `settlementKind`
- `mrc20Ticker`
- `mrc20Id`
- `paymentCommitTxid` for `MRC20` payments when available

All database migrations must be:

- safe for existing users
- idempotent
- backward-compatible with existing native orders

## 12. File Impact

Primary files expected to change:

- `src/renderer/components/gigSquare/GigSquarePublishModal.tsx`
- `src/renderer/components/gigSquare/GigSquareMyServicesModal.tsx`
- `src/renderer/components/gigSquare/GigSquareOrderModal.tsx`
- `src/renderer/components/gigSquare/gigSquarePublishPresentation.js`
- `src/renderer/utils/gigSquare.ts`
- `src/renderer/types/gigSquare.ts`
- `src/renderer/types/electron.d.ts`
- `src/main/main.ts`
- `src/main/preload.ts`
- `src/main/services/gigSquareServiceMutationService.ts`
- `src/main/services/gigSquareRemoteServiceSync.ts`
- `src/main/services/orderPayment.ts`
- `src/main/services/serviceRefundSyncService.ts`
- `src/main/services/serviceRefundSettlementService.ts`
- `src/main/services/serviceOrderLifecycleService.ts`
- `src/main/services/delegationOrderMessage.ts`
- `src/main/shared/orderMessage.js`
- `src/main/serviceOrderStore.ts`
- `src/main/sqliteStore.ts`

New helper files are recommended:

- `src/main/services/gigSquarePaymentAssetService.ts`
- `src/main/services/mrc20TransferVerification.ts`

## 13. Test Plan

The implementation must include tests for:

1. publish payload generation for native vs `MRC20`
2. `currency = <TICKER>-MRC20` normalization and uppercase ticker behavior
3. MRC20 token selector refresh when the executing MetaBot changes
4. publish / modify validation for missing or stale `MRC20` selection
5. remote sync parsing for `MRC20` services
6. manual buyer payment routing to `executeTokenTransfer({ kind: 'mrc20' })`
7. remote auto-delegation payment routing to `executeTokenTransfer({ kind: 'mrc20' })`
8. structured order metadata generation for `MRC20`
9. seller-side `MRC20` verification success and failure cases
10. refund request and refund finalize parsing for `MRC20`
11. manual seller refund execution for `MRC20`
12. service order database migration safety on existing native rows

## 14. Out-of-Scope Workflow Note

During implementation, Codex may publish Build in Public snapshots to MetaWeb using `simplebuzz`.

That workflow:

- is external to this product design
- does not modify IDBots protocol behavior
- does not add user-facing UI
- must remain separate from the `MRC20` feature itself
