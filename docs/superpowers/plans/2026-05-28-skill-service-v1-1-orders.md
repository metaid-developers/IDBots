# Skill Service V1.1 Orders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement skill-service v1.1 publishing/editing with free vs prepaid services, unordered multi-skill allow-lists, and skill-service-order pin records so free orders no longer rely on synthetic payment txids.

**Architecture:** Treat MetaID pin facts as the chain-level source of truth: 7-tuple version/path/content-type stay outside JSON payloads, pin ids identify records, and protocol payload fields are self-declared display or relation data only. Keep local SQLite order status as runtime state, but add an order pin id bridge so A2A service execution, refund flows, ratings, and UI no longer need payment txid as the order's primary business reference. Preserve legacy v1.0 service pins and old local rows through normalization layers instead of rewriting chain data.

**Tech Stack:** Electron main process, React renderer, TypeScript, sql.js-backed local stores, MetaID `createPin`, encrypted simplemsg, existing Gig Square services, `node:test`, `tsx`, `npm run compile:electron`, `npm run test:gig-square`.

---

## Source-of-Truth Rules

- Re-read `docs/metaid_protocols/00-metaid-concepts.md` before implementing protocol-shaped code. Each MetaID record already carries address, PINID, publisher, creator, owner, `globalMetaId`, operation/path/version/content-type, and chain witness metadata; do not duplicate those facts inside JSON payloads.
- `docs/metaid_protocols/02-content-app.md` is the local mirror of the OAC protocol SOT for this work.
- `skill-service` v1.1 JSON must not include a `version` field. Use the MetaID 7-tuple version `1.1.0`.
- `skill-service-order` JSON must not include `orderId`, created/updated timestamps, lifecycle status, buyer/provider identity objects, or skill snapshots. The order record id is the order pin id.
- `price`, `currency`, and `settlementKind` in `skill-service-order` are display-only. Native payment validation must inspect payment tx data.
- `providerSkill` is an unordered allow-list for `<available_skills>`, not an execution pipeline and not a promise that every skill will run.
- This implementation exposes only `free` and `prepaid` in UI/business logic. `postpaid` and `fiat` remain protocol-compatible future values, not active flows.
- New v1.1 service payloads should not publish `paymentAddress`. The provider MetaBot identity is the recipient. Legacy v1.0 payloads with `paymentAddress` remain readable as compatibility fallback.
- Existing code has local `settlementKind: "mrc20"` runtime paths. Do not treat that as the protocol `settlementKind`. For this plan, keep MRC20 parsing/runtime compatibility for existing records, but do not broaden the v1.1 protocol surface beyond `native|fiat`.

## File Map

### New Files

- `src/main/shared/skillServiceProtocol.js`
  - Shared normalization for v1.0/v1.1 skill-service payloads and skill-service-order payloads.
  - Normalizes `providerSkill` string/array into `providerSkills: string[]`.
  - Resolves effective payment timing with the "lowest amount wins" compatibility rule.
  - Builds minimal skill-service-order payloads without self-declared ids/timestamps.
- `tests/skillServiceProtocol.test.mjs`
  - Unit tests for v1.0 compatibility, v1.1 conflicts, provider skill arrays, and order payload shape.
- `tests/serviceOrderStoreOrderPin.test.mjs`
  - Local store tests for `order_pin_id`, empty payment txids, and legacy payment lookup fallback.
- `tests/gigSquareServiceMutationService.test.mjs`
  - Publish/modify payload tests for v1.1 service JSON.
- `tests/gigSquarePaymentTermsPresentation.test.mjs`
  - Renderer helper tests for free/prepaid form behavior.

### Modified Main-Process Files

- `src/main/shared/orderMessage.js`
  - Add order pin id metadata support in simplemsg order payloads.
  - Keep legacy `order id:` parsing for old free orders.
  - Add `allowed skills:` metadata for unordered multi-skill scopes.
- `src/main/services/orderPayment.ts`
  - Parse `order pin id` / legacy `order id`.
  - Parse allowed skill lists.
  - Keep zero-price orders valid without a payment txid.
- `src/main/services/orderPromptBuilder.ts`
  - Replace single "required skill" language with unordered allowed-skill scope language.
  - Remove unconditional paid-order wording for free orders.
- `src/main/skillManager.ts`
  - Add scoped routing prompt builder for multiple skill names/ids without requiring all skills to run.
- `src/main/services/privateChatDaemon.ts`
  - Use order pin id as order tracking id when present.
  - Pass provider skill allow-lists into skill prompt resolution.
  - Create seller orders with `orderPinId` and empty payment txid for free orders.
- `src/main/services/delegationOrderMessage.ts`
  - Accept provider skill arrays and order pin ids.
- `src/main/services/serviceOrderLifecycleService.ts`
  - Accept `orderPinId` in create/find/mark inputs.
  - Prefer order pin id matching, with legacy payment txid fallback.
- `src/main/serviceOrderStore.ts`
  - Add safe migration for `order_pin_id` and payment-txid dedupe changes.
  - Add lookup/mirroring helpers by order pin id.
- `src/main/sqliteStore.ts`
  - Mirror the `service_orders` schema migration for the app-wide store initializer.
  - Add remote service columns for provider skill arrays and payment timing.
- `src/main/services/gigSquareRemoteServiceSync.ts`
  - Parse v1.0/v1.1 skill-service rows through shared resolvers.
  - Store provider skill arrays and effective payment timing.
- `src/main/services/gigSquareServiceMutationService.ts`
  - Normalize modify drafts with `providerSkills`, `paymentTiming`, protocol settlement kind, and metadata.
  - Build v1.1 payloads without `paymentAddress`.
- `src/main/main.ts`
  - Update publish/modify IPC shapes.
  - Broadcast skill-service pins with MetaID version `1.1.0`.
  - Add a `gigSquare:createServiceOrderPin` IPC or fold equivalent logic into order/delegation send paths.
  - Stop generating synthetic txids for free Gig Square orders and main-process delegations.
- `src/main/preload.ts`
  - Expose new/changed Gig Square IPC parameters.
- `src/main/services/gigSquareRatingSyncService.ts`
  - Read `serviceOrderPinId` while preserving legacy `servicePaidTx`.
- `src/main/services/serviceOrderSessionResolution.js`, `src/main/coworkStore.ts`, `src/main/services/gigSquareRefundsService.ts`
  - Prefer order pin id/session/order message txid lookups where payment txid can now be empty.

### Modified Renderer Files

- `src/renderer/types/gigSquare.ts`
  - Add `providerSkills`, `paymentTiming`, `protocolSettlementKind`, `metadata`, and `orderPinId` fields.
  - Keep `providerSkill` and `paymentTxid` as legacy/display fields.
- `src/renderer/types/electron.d.ts`
  - Update publish/modify/send-order IPC request/response shapes.
- `src/renderer/components/gigSquare/gigSquareSkillOptions.js`
  - Replace single-selection helpers with multi-selection normalization helpers.
- `src/renderer/components/gigSquare/GigSquarePublishModal.tsx`
  - Add multi-skill selection.
  - Add payment timing selector with default `free`.
  - Hide amount/currency controls unless `prepaid` is selected.
- `src/renderer/components/gigSquare/GigSquareMyServicesModal.tsx`
  - Update modify modal with the same multi-skill and free/prepaid controls.
  - Show multi-skill chips in service summaries.
- `src/renderer/components/gigSquare/GigSquareOrderModal.tsx`
  - Stop synthetic free txid generation.
  - Publish/create the skill-service-order pin before sending the encrypted order message.
  - Use order pin id as the free-order reference.
- `src/renderer/components/gigSquare/GigSquareServiceCard.tsx`
  - Show free services as free and render provider skill chips.
- `src/renderer/components/gigSquare/gigSquareOrderPayloadBuilder.mjs`
  - Pass order pin id and provider skill arrays to `buildOrderPayload`.
- `src/renderer/components/gigSquare/gigSquareOrderMessageBuilder.mjs`
  - Keep buyer natural text free of transport/payment metadata.
- `src/renderer/components/gigSquare/gigSquarePublishPresentation.js`
  - Add payment timing presentation helpers.
- `src/renderer/services/i18n.ts`
  - Add labels/errors for free/prepaid and multi-skill selection.

### Modified Tests

- `tests/gigSquareSkillOptions.test.mjs`
- `tests/gigSquareOrderMessageBuilder.test.mjs`
- `tests/orderPromptBuilder.test.ts`
- `tests/privateChatOrderCoworkDeliveryArtifacts.test.mjs`
- `tests/privateChatRatingPrompt.test.ts`
- `tests/gigSquareServiceCard.test.tsx`

---

### Task 1: Add Shared Skill-Service Protocol Normalizers

**Files:**
- Create: `src/main/shared/skillServiceProtocol.js`
- Create: `tests/skillServiceProtocol.test.mjs`

- [x] **Step 1: Write failing tests for provider skill normalization**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeProviderSkillList,
  getPrimaryProviderSkill,
} from '../src/main/shared/skillServiceProtocol.js';

test('normalizes legacy providerSkill string to a one-item allow-list', () => {
  assert.deepEqual(normalizeProviderSkillList('weather'), ['weather']);
  assert.equal(getPrimaryProviderSkill(['weather', 'reporter']), 'weather');
});

test('normalizes v1.1 providerSkill arrays without order semantics', () => {
  assert.deepEqual(
    normalizeProviderSkillList(['weather', ' reporter ', '', 'weather']),
    ['weather', 'reporter'],
  );
});
```

- [x] **Step 2: Write failing tests for payment compatibility**

```js
import {
  resolveSkillServicePaymentTerms,
} from '../src/main/shared/skillServiceProtocol.js';

test('v1.0 positive price defaults to prepaid and MVC currency aliases to SPACE', () => {
  assert.deepEqual(resolveSkillServicePaymentTerms({ price: '0.1', currency: 'MVC' }), {
    paymentTiming: 'prepaid',
    effectivePrice: '0.1',
    currency: 'SPACE',
    protocolSettlementKind: 'native',
    isFree: false,
  });
  assert.equal(resolveSkillServicePaymentTerms({ price: '0' }).paymentTiming, 'free');
});

test('conflicting payment fields choose the lowest amount semantics', () => {
  assert.equal(resolveSkillServicePaymentTerms({
    paymentTiming: 'prepaid',
    price: '0',
    currency: 'SPACE',
  }).paymentTiming, 'free');
  assert.equal(resolveSkillServicePaymentTerms({
    paymentTiming: 'free',
    price: '99',
    currency: 'SPACE',
  }).effectivePrice, '0');
});
```

- [x] **Step 3: Write failing tests for skill-service-order payload shape**

```js
import { buildSkillServiceOrderPayload } from '../src/main/shared/skillServiceProtocol.js';

test('builds minimal skill-service-order payload without self-declared ids or timestamps', () => {
  const payload = buildSkillServiceOrderPayload({
    servicePinId: 'service-pin-i0',
    paymentTxid: '',
    price: '0',
    currency: 'SPACE',
    settlementKind: 'native',
  });

  assert.deepEqual(payload, {
    servicePinId: 'service-pin-i0',
    paymentTxid: '',
    price: '0',
    currency: 'SPACE',
    settlementKind: 'native',
    metadata: '',
  });
  assert.equal(Object.hasOwn(payload, 'orderId'), false);
  assert.equal(Object.hasOwn(payload, 'createdAt'), false);
});
```

- [x] **Step 4: Run tests and confirm failure**

Run: `node --test tests/skillServiceProtocol.test.mjs`

Expected: FAIL because `src/main/shared/skillServiceProtocol.js` does not exist.

- [x] **Step 5: Implement the shared normalizer**

Implementation sketch:

```js
const VALID_PAYMENT_TIMINGS = new Set(['prepaid', 'postpaid', 'free']);
const VALID_PROTOCOL_SETTLEMENT_KINDS = new Set(['native', 'fiat']);

export function normalizeProviderSkillList(value) {
  const raw = Array.isArray(value) ? value : [value];
  const seen = new Set();
  const result = [];
  for (const item of raw) {
    const skill = typeof item === 'string' ? item.trim() : '';
    if (!skill || seen.has(skill)) continue;
    seen.add(skill);
    result.push(skill);
  }
  return result;
}

export function getPrimaryProviderSkill(value) {
  return normalizeProviderSkillList(value)[0] || '';
}

export function normalizeProtocolSettlementKind(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return VALID_PROTOCOL_SETTLEMENT_KINDS.has(normalized) ? normalized : 'native';
}

export function normalizeSkillServiceCurrency(value) {
  const currency = typeof value === 'string' ? value.trim().toUpperCase() : '';
  if (!currency || currency === 'MVC' || currency === 'MICROVISIONCHAIN') return 'SPACE';
  if (currency === 'BITCOIN') return 'BTC';
  if (currency === 'DOGECOIN') return 'DOGE';
  return currency;
}

export function resolveSkillServicePaymentTerms(input) {
  const priceText = typeof input?.price === 'string' ? input.price.trim() : '';
  const priceNumber = Number(priceText);
  const validPositivePrice = Number.isFinite(priceNumber) && priceNumber > 0;
  const timing = VALID_PAYMENT_TIMINGS.has(String(input?.paymentTiming || '').trim().toLowerCase())
    ? String(input.paymentTiming).trim().toLowerCase()
    : (validPositivePrice ? 'prepaid' : 'free');
  const isFree = timing === 'free' || !validPositivePrice;
  return {
    paymentTiming: isFree ? 'free' : timing,
    effectivePrice: isFree ? '0' : priceText,
    currency: normalizeSkillServiceCurrency(input?.currency),
    protocolSettlementKind: normalizeProtocolSettlementKind(input?.settlementKind),
    isFree,
  };
}

export function buildSkillServiceOrderPayload(input) {
  return {
    servicePinId: String(input?.servicePinId || '').trim(),
    paymentTxid: String(input?.paymentTxid || '').trim(),
    price: String(input?.price || '').trim() || '0',
    currency: normalizeSkillServiceCurrency(input?.currency),
    settlementKind: normalizeProtocolSettlementKind(input?.settlementKind),
    metadata: typeof input?.metadata === 'string' ? input.metadata : '',
  };
}
```

- [x] **Step 6: Run tests and confirm pass**

Run: `node --test tests/skillServiceProtocol.test.mjs`

Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add src/main/shared/skillServiceProtocol.js tests/skillServiceProtocol.test.mjs
git commit -m "feat: add skill service protocol normalizers"
```

After commit, post a development-journal buzz with the Codex `metabot-post-buzz` skill.

---

### Task 2: Migrate Local Stores for Provider Skill Lists and Order Pin IDs

**Files:**
- Modify: `src/main/serviceOrderStore.ts`
- Modify: `src/main/sqliteStore.ts`
- Modify: `src/main/main.ts`
- Create: `tests/serviceOrderStoreOrderPin.test.mjs`

- [x] **Step 1: Write failing store migration tests**

Test requirements:

- Creating a free order with `paymentTxid: ''` and `orderPinId: 'order-pin-i0'` succeeds.
- Creating the same `(localMetabotId, role, orderPinId)` twice returns the existing row.
- Two free orders with different `orderPinId` values may both have empty `paymentTxid`.
- Legacy paid rows still dedupe by non-empty `paymentTxid`.
- `findOrderByOrderPinId` works.
- `findOrderByPayment` still works for legacy callers.

Run: `npm run compile:electron && node --test tests/serviceOrderStoreOrderPin.test.mjs`

Expected: FAIL because `orderPinId` and empty payment txid support do not exist.

- [x] **Step 2: Add store fields and schema migration**

In both `src/main/serviceOrderStore.ts` and `src/main/sqliteStore.ts`:

- Add `order_pin_id TEXT`.
- Keep `payment_txid TEXT NOT NULL`, but normalize new free orders to `''` instead of fake txids.
- Drop/recreate `idx_service_orders_dedupe_payment` as a partial unique index:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_service_orders_dedupe_payment
ON service_orders(local_metabot_id, role, payment_txid)
WHERE payment_txid IS NOT NULL AND trim(payment_txid) <> '';
```

- Add:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_service_orders_dedupe_order_pin
ON service_orders(local_metabot_id, role, order_pin_id)
WHERE order_pin_id IS NOT NULL AND trim(order_pin_id) <> '';
```

- Update duplicate remediation so empty `payment_txid` rows are not collapsed together.
- Preserve all existing local UUID `id` values. They are local DB row ids, not MetaID protocol ids.

- [x] **Step 3: Add lookup APIs**

Add or update:

```ts
export interface ServiceOrderCreateInput {
  orderPinId?: string | null;
  paymentTxid?: string | null;
}

findOrderByOrderPinId(input: {
  role: ServiceOrderRole;
  localMetabotId: number;
  counterpartyGlobalMetaid: string;
  orderPinId: string;
}): ServiceOrderRecord | null

listOrdersByOrderPinId(orderPinId: string): ServiceOrderRecord[]
```

Update `createOrder` to prefer an existing row by order pin id before falling back to non-empty payment txid.

- [x] **Step 4: Add Gig Square service table columns**

In `ensureGigSquareSchema` and `src/main/sqliteStore.ts` remote table migrations, add:

- `provider_skills_json TEXT`
- `payment_timing TEXT`
- `protocol_settlement_kind TEXT`
- `metadata TEXT`

Keep old `provider_skill` as a compatibility label and search column.

- [x] **Step 5: Run migration tests**

Run: `npm run compile:electron && node --test tests/serviceOrderStoreOrderPin.test.mjs`

Expected: PASS.

- [x] **Step 6: Run existing store-sensitive tests**

Run:

```bash
npm run compile:electron
node --test tests/sqliteNativeStore.test.mjs tests/sqliteRecoveryLifecycle.test.mjs tests/privateChatOrderCoworkDeliveryArtifacts.test.mjs
```

Expected: PASS.

- [x] **Step 7: Commit**

```bash
git add src/main/serviceOrderStore.ts src/main/sqliteStore.ts src/main/main.ts tests/serviceOrderStoreOrderPin.test.mjs
git commit -m "feat: track service orders by order pin"
```

After commit, post a development-journal buzz.

---

### Task 3: Publish and Modify skill-service v1.1 Payloads

**Files:**
- Modify: `src/main/services/gigSquareServiceMutationService.ts`
- Modify: `src/main/main.ts`
- Modify: `src/main/preload.ts`
- Modify: `src/renderer/types/electron.d.ts`
- Modify: `src/renderer/types/gigSquare.ts`
- Create: `tests/gigSquareServiceMutationService.test.mjs`

- [x] **Step 1: Write failing payload tests**

Test that `buildGigSquareServicePayload` returns:

```json
{
  "providerSkill": ["weather", "report-writer"],
  "paymentTiming": "free",
  "price": "0",
  "currency": "SPACE",
  "settlementKind": "native",
  "metadata": ""
}
```

and does not include:

- `version`
- `paymentAddress`
- `paymentChain`
- `orderId`

Run: `npm run compile:electron && node --test tests/gigSquareServiceMutationService.test.mjs`

Expected: FAIL until mutation service supports v1.1 fields.

- [x] **Step 2: Update mutation draft types**

Change `GigSquareModifyDraft`:

```ts
export interface GigSquareModifyDraft {
  serviceName: string;
  displayName: string;
  description: string;
  executionReminder?: string | null;
  providerSkills: string[];
  paymentTiming: 'free' | 'prepaid';
  price: string;
  currency: string;
  protocolSettlementKind?: 'native' | 'fiat';
  metadata?: string;
  outputType: string;
  serviceIconUri?: string | null;
}
```

Keep compatibility input `providerSkill?: string` at IPC boundaries and normalize it into `providerSkills`.

- [x] **Step 3: Build v1.1 payloads**

Use shared helpers from `skillServiceProtocol.js`.

Rules:

- Free publish/modify always serializes `paymentTiming: "free"` and `price: "0"`.
- Prepaid publish/modify serializes `paymentTiming: "prepaid"` and validates positive numeric price.
- `settlementKind` defaults to `"native"`.
- `metadata` defaults to `""`.
- `providerSkill` must be a non-empty array.
- Do not publish `paymentAddress`.

- [x] **Step 4: Update MetaID create/modify versions**

In `gigSquare:publishService`, call `createPin` with:

```ts
{
  operation: 'create',
  path: '/protocols/skill-service',
  encryption: '0',
  version: '1.1.0',
  contentType: 'application/json',
  payload: payloadJson,
}
```

For modify, keep `operation: "modify"` targeting the current pin but use MetaID version `1.1.0`.

- [x] **Step 5: Run payload tests**

Run: `npm run compile:electron && node --test tests/gigSquareServiceMutationService.test.mjs`

Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/main/services/gigSquareServiceMutationService.ts src/main/main.ts src/main/preload.ts src/renderer/types/electron.d.ts src/renderer/types/gigSquare.ts tests/gigSquareServiceMutationService.test.mjs
git commit -m "feat: publish skill service v1.1 payloads"
```

After commit, post a development-journal buzz.

---

### Task 4: Parse and Display v1.0/v1.1 Skill Services

**Files:**
- Modify: `src/main/services/gigSquareRemoteServiceSync.ts`
- Modify: `src/main/services/gigSquareMyServicesService.ts`
- Modify: `src/main/services/gigSquareServiceStateService.ts`
- Modify: `src/renderer/components/gigSquare/GigSquareServiceCard.tsx`
- Modify: `src/renderer/components/gigSquare/GigSquareMyServicesModal.tsx`
- Modify: `src/renderer/utils/gigSquare.ts`
- Modify: `tests/gigSquareServiceCard.test.tsx`

- [x] **Step 1: Write failing parser tests**

Add tests to `tests/skillServiceProtocol.test.mjs` or a remote-sync test:

- v1.0 string `providerSkill` becomes `providerSkills: ['skill']`.
- v1.0 missing `paymentTiming` and `price: '0.001'` becomes prepaid.
- v1.0 missing `settlementKind` becomes protocol settlement `native`.
- v1.1 `providerSkill: ['a', 'b']` remains both skills.
- v1.1 conflict `paymentTiming: 'free', price: '10'` displays free/effective price 0.

- [x] **Step 2: Update remote service parsing**

In `parseRemoteSkillServiceItem` and `parseRemoteSkillServiceRow`:

- Read payload version from the MetaID item if available, but default to v1.0 when missing.
- Parse `providerSkill` through `normalizeProviderSkillList`.
- Store:
  - `provider_skill`: joined display label for legacy UI/search.
  - `provider_skills_json`: JSON array.
  - `payment_timing`: effective payment timing.
  - `protocol_settlement_kind`: `native|fiat`.
  - `metadata`: payload metadata string.
- Preserve old `paymentAddress`, `paymentChain`, `mrc20Ticker`, `mrc20Id` only as legacy compatibility data.

- [x] **Step 3: Update renderer types and cards**

Add to `GigSquareService` and `GigSquareMyServiceSummary`:

```ts
providerSkills?: string[];
paymentTiming?: 'free' | 'prepaid' | 'postpaid';
protocolSettlementKind?: 'native' | 'fiat';
metadata?: string | null;
```

Display rules:

- Free services show `Free` / localized text instead of `0 SPACE`.
- Paid services show amount and currency as today.
- Skill allow-lists render as compact chips and wrap cleanly.

- [x] **Step 4: Run display tests**

Run:

```bash
npx tsx --test tests/gigSquareServiceCard.test.tsx
node --test tests/skillServiceProtocol.test.mjs
```

Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/main/services/gigSquareRemoteServiceSync.ts src/main/services/gigSquareMyServicesService.ts src/main/services/gigSquareServiceStateService.ts src/renderer/components/gigSquare/GigSquareServiceCard.tsx src/renderer/components/gigSquare/GigSquareMyServicesModal.tsx src/renderer/utils/gigSquare.ts src/renderer/types/gigSquare.ts tests/gigSquareServiceCard.test.tsx tests/skillServiceProtocol.test.mjs
git commit -m "feat: read skill service v1.1 listings"
```

After commit, post a development-journal buzz.

---

### Task 5: Update Publish and Modify UI

**Files:**
- Modify: `src/renderer/components/gigSquare/GigSquarePublishModal.tsx`
- Modify: `src/renderer/components/gigSquare/GigSquareMyServicesModal.tsx`
- Modify: `src/renderer/components/gigSquare/gigSquareSkillOptions.js`
- Modify: `src/renderer/components/gigSquare/gigSquarePublishPresentation.js`
- Modify: `src/renderer/services/i18n.ts`
- Modify: `tests/gigSquareSkillOptions.test.mjs`
- Create: `tests/gigSquarePaymentTermsPresentation.test.mjs`

- [ ] **Step 1: Write failing multi-skill helper tests**

Expected helper behavior:

- Returns enabled skills only.
- Preserves unknown legacy current skills as selected-but-readonly compatibility entries.
- Normalizes selected ids to unique provider skill names.
- Does not impose order semantics beyond stable UI display.

- [ ] **Step 2: Write failing payment presentation tests**

Expected helper behavior:

- Default payment timing is `free`.
- Free mode hides amount/currency and serializes price `0`.
- Prepaid mode requires amount/currency.
- Switching from prepaid to free keeps a draft amount in UI state only if useful, but submission still sends `price: "0"`.

- [ ] **Step 3: Implement publish modal UI**

UI controls:

- Multi-select skill checklist or chip selector for enabled skills.
- Payment timing segmented control:
  - `Free`
  - `Prepaid`
- Show amount/currency controls only for `Prepaid`.
- Default new service to `Free`.

Submission:

```ts
window.electron.gigSquare.publishService({
  metabotId,
  serviceName,
  displayName,
  description,
  executionReminder,
  providerSkills,
  paymentTiming,
  price: paymentTiming === 'free' ? '0' : price.trim(),
  currency: paymentTiming === 'free' ? 'SPACE' : currency,
  protocolSettlementKind: 'native',
  metadata: '',
  outputType,
  serviceIconDataUrl,
});
```

- [ ] **Step 4: Implement modify modal UI**

Apply the same controls. Existing v1.0 services:

- `providerSkill: "a"` opens as selected `["a"]`.
- Missing `paymentTiming` derives from price.
- Missing `settlementKind` derives as `native`.

- [ ] **Step 5: Run renderer helper tests**

Run:

```bash
node --test tests/gigSquareSkillOptions.test.mjs tests/gigSquarePaymentTermsPresentation.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/gigSquare/GigSquarePublishModal.tsx src/renderer/components/gigSquare/GigSquareMyServicesModal.tsx src/renderer/components/gigSquare/gigSquareSkillOptions.js src/renderer/components/gigSquare/gigSquarePublishPresentation.js src/renderer/services/i18n.ts tests/gigSquareSkillOptions.test.mjs tests/gigSquarePaymentTermsPresentation.test.mjs
git commit -m "feat: add free prepaid multi skill service forms"
```

After commit, post a development-journal buzz.

---

### Task 6: Publish skill-service-order Pins and Remove Free Synthetic Txids

**Files:**
- Modify: `src/main/main.ts`
- Modify: `src/main/services/delegationOrderMessage.ts`
- Modify: `src/main/shared/orderMessage.js`
- Modify: `src/renderer/components/gigSquare/GigSquareOrderModal.tsx`
- Modify: `src/renderer/components/gigSquare/gigSquareOrderPayloadBuilder.mjs`
- Modify: `tests/gigSquareOrderMessageBuilder.test.mjs`

- [ ] **Step 1: Write failing order payload tests**

Update free-order test expectations:

```js
assert.match(payload, /order pin id:\s*order-pin-i0/i);
assert.doesNotMatch(payload, /txid:/i);
assert.doesNotMatch(payload, /payment chain:/i);
assert.doesNotMatch(payload, /settlement kind:/i);
```

Add paid-order expectation:

```js
assert.match(payload, /order pin id:\s*order-pin-i0/i);
assert.match(payload, /txid:\s*[0-9a-f]{64}/i);
```

- [ ] **Step 2: Add order pin publishing helper**

In main process, add a helper near Gig Square order handling:

```ts
async function publishSkillServiceOrderPin(input: {
  metabotId: number;
  servicePinId: string;
  paymentTxid: string;
  price: string;
  currency: string;
  settlementKind?: string | null;
  metadata?: string;
}): Promise<{ pinId: string; txids: string[] }> {
  const payload = buildSkillServiceOrderPayload(input);
  const result = await createPin(getMetabotStore(), input.metabotId, {
    operation: 'create',
    path: '/protocols/skill-service-order',
    encryption: '0',
    version: '1.0.0',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
  });
  const pinId = toSafeString(result.pinId).trim();
  if (!pinId) throw new Error('skill-service-order pin id missing');
  return { pinId, txids: result.txids || [] };
}
```

- [ ] **Step 3: Update Gig Square direct order flow**

In `GigSquareOrderModal.tsx`:

- Delete `generateSyntheticOrderTxid`.
- For free services, keep `txId = ''`.
- After payment step, call `gigSquare.createServiceOrderPin` or a combined main IPC before building the encrypted order payload.
- Use the returned order pin id in `buildGigSquareOrderPayload`.
- Pass both `serviceOrderPinId` and `servicePaidTx` to `sendOrder`.
- For free orders, `servicePaidTx` must be `''`.

- [ ] **Step 4: Update main-process delegation flow**

In `src/main/main.ts` main-process delegation:

- Delete `generateSyntheticOrderTxid()` for free delegation.
- Publish the skill-service-order pin after paid payment succeeds or immediately for free.
- Use order pin id as `orderReference` in order payload.
- Create buyer order with `orderPinId` and `paymentTxid: ''` for free.
- Blocking state should prefer local row id for UI internals but include order pin id in metadata/display.

- [ ] **Step 5: Update simplemsg order metadata**

In `buildOrderPayload`:

- Add `order pin id: <pinId>` when present.
- Keep legacy `order id:` parser support, but new messages should say `order pin id`.
- Add `allowed skills: a, b` when `providerSkills` is non-empty.
- Keep `skill name:` only for legacy single-skill compatibility when there is exactly one skill.

- [ ] **Step 6: Run order message tests**

Run: `node --test tests/gigSquareOrderMessageBuilder.test.mjs`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/main.ts src/main/services/delegationOrderMessage.ts src/main/shared/orderMessage.js src/renderer/components/gigSquare/GigSquareOrderModal.tsx src/renderer/components/gigSquare/gigSquareOrderPayloadBuilder.mjs tests/gigSquareOrderMessageBuilder.test.mjs
git commit -m "feat: publish service order pins"
```

After commit, post a development-journal buzz.

---

### Task 7: Match A2A Order Lifecycle by Order Pin ID

**Files:**
- Modify: `src/main/services/orderPayment.ts`
- Modify: `src/main/services/serviceOrderLifecycleService.ts`
- Modify: `src/main/services/privateChatDaemon.ts`
- Modify: `src/main/services/serviceOrderSessionResolution.js`
- Modify: `src/main/coworkStore.ts`
- Modify: `src/main/services/gigSquareRefundsService.ts`
- Modify: `tests/privateChatOrderCoworkDeliveryArtifacts.test.mjs`
- Modify: `tests/privateChatRatingPrompt.test.ts`

- [ ] **Step 1: Write failing A2A tests**

Add scenarios:

- Provider receives free order with `order pin id` and no `txid`; seller order row has `orderPinId` and empty `paymentTxid`.
- Provider receives paid order with both `order pin id` and `txid`; payment verification still validates the txid.
- Delivery/status/rating flow finds buyer and seller orders by order pin id first.
- Legacy paid order without order pin id still works through payment txid fallback.

- [ ] **Step 2: Update order payment parsing**

Add:

```ts
export function extractOrderPinId(plaintext: string): string | null
export function extractOrderAllowedSkills(plaintext: string): string[]
```

`checkOrderPaymentStatus` remains payment-focused:

- zero amount -> paid/free even without txid.
- positive amount -> requires valid txid and verifies as today.

- [ ] **Step 3: Update lifecycle service APIs**

Add `orderPinId?: string | null` to all create/mark inputs. Lookup order in this order:

1. order pin id when present
2. payment txid when non-empty
3. order message txid/session fallback where already supported

Do not use empty payment txid as a grouping key.

- [ ] **Step 4: Update private chat daemon**

For incoming `[ORDER]`:

- `orderTrackingId = orderPinId || txid || legacyOrderReferenceId`.
- Free orders may have no txid.
- Seller order create uses `orderPinId`.
- Observer session metadata includes `serviceOrderPinId`.
- Delivery messages include `paymentTxid` only when present and include `serviceOrderPinId`.

- [ ] **Step 5: Update refund/rating/session helpers**

- Refund mirroring should prefer `orderPinId`.
- Rating payload should write `serviceOrderPinId`.
- Session summary display should tolerate empty payment txid.

- [ ] **Step 6: Run A2A tests**

Run:

```bash
npm run compile:electron
node --test tests/privateChatOrderCoworkDeliveryArtifacts.test.mjs
npx tsx --test tests/privateChatRatingPrompt.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/services/orderPayment.ts src/main/services/serviceOrderLifecycleService.ts src/main/services/privateChatDaemon.ts src/main/services/serviceOrderSessionResolution.js src/main/coworkStore.ts src/main/services/gigSquareRefundsService.ts tests/privateChatOrderCoworkDeliveryArtifacts.test.mjs tests/privateChatRatingPrompt.test.ts
git commit -m "feat: match service orders by order pin"
```

After commit, post a development-journal buzz.

---

### Task 8: Restrict Provider Execution to the Allowed Skill Scope

**Files:**
- Modify: `src/main/skillManager.ts`
- Modify: `src/main/services/orderPromptBuilder.ts`
- Modify: `src/main/services/privateChatDaemon.ts`
- Modify: `tests/orderPromptBuilder.test.ts`
- Modify: `tests/skillManagerOrderSkillPrompt.test.mjs`

- [ ] **Step 1: Write failing prompt tests**

Expected:

- Prompt says "Allowed skills" not "Required skill".
- Prompt says the provider may use any suitable subset.
- Prompt does not say the skills must be used in order.
- Prompt does not require every allowed skill to be used.

- [ ] **Step 2: Add multi-skill routing prompt builder**

In `skillManager.ts`, add:

```ts
buildAutoRoutingPromptForOrderSkillScope(params: {
  skillIds?: string[];
  skillNames?: string[];
  strictScope?: boolean;
}): { prompt: string | null; activeSkillIds: string[]; missingSkillNames: string[] }
```

Behavior:

- Resolve every id/name against enabled local skills.
- Build scoped prompt for resolved skills.
- For v1.1 orders, do not fall back to all skills when a non-empty allow-list resolves to nothing.
- Preserve legacy fallback only for old orders with no allow-list.

- [ ] **Step 3: Update order prompt builder**

Replace:

```text
Required skill: **X**. You MUST use this skill...
```

with:

```text
Allowed skill scope: X, Y.
You may use any suitable subset of these skills. Do not use local skills outside this scope for this service order.
The list has no execution-order semantics.
```

- [ ] **Step 4: Update private chat order run**

- Parse `allowed skills:` from the order payload.
- Pass the array to `getSkillsPrompt`.
- If a v1.1 service order has an allow-list but no local skills resolve, send an order-status failure rather than running unrestricted.

- [ ] **Step 5: Run prompt tests**

Run:

```bash
npm run compile:electron
npx tsx --test tests/orderPromptBuilder.test.ts
node --test tests/skillManagerOrderSkillPrompt.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/skillManager.ts src/main/services/orderPromptBuilder.ts src/main/services/privateChatDaemon.ts tests/orderPromptBuilder.test.ts tests/skillManagerOrderSkillPrompt.test.mjs
git commit -m "feat: scope orders to allowed skills"
```

After commit, post a development-journal buzz.

---

### Task 9: Final Integration Verification

**Files:**
- Modify only files needed to fix integration issues found by the commands below.

- [ ] **Step 1: Run focused test suite**

```bash
npm run compile:electron
node --test tests/skillServiceProtocol.test.mjs
node --test tests/serviceOrderStoreOrderPin.test.mjs
node --test tests/gigSquareServiceMutationService.test.mjs
node --test tests/gigSquareSkillOptions.test.mjs tests/gigSquarePaymentTermsPresentation.test.mjs
node --test tests/gigSquareOrderMessageBuilder.test.mjs
npx tsx --test tests/orderPromptBuilder.test.ts tests/privateChatRatingPrompt.test.ts
node --test tests/privateChatOrderCoworkDeliveryArtifacts.test.mjs
```

Expected: PASS.

- [ ] **Step 2: Run existing Gig Square self-test**

```bash
npm run test:gig-square
```

Expected: PASS.

- [ ] **Step 3: Run lint/build**

```bash
npm run lint
npm run build
```

Expected: PASS.

- [ ] **Step 4: Manual UI smoke test**

Run:

```bash
npm run electron:dev
```

Smoke cases:

- Publish modal opens with payment timing defaulting to Free.
- Free hides price/currency controls and publishes `price: "0"`.
- Prepaid shows price/currency controls and validates positive amount.
- Publish selects multiple skills and stores `providerSkill` as array on-chain.
- Modify v1.0 service opens with one selected skill and derived free/prepaid state.
- Order free service creates a skill-service-order pin and sends no payment txid.
- Order prepaid service pays first, creates a skill-service-order pin, then sends order message with order pin id and txid.
- Provider execution prompt shows allowed skill scope and does not require all skills to run.

- [ ] **Step 5: Final commit if integration fixes were needed**

```bash
git add <changed files>
git commit -m "fix: stabilize skill service v1.1 order flow"
```

After commit, post a development-journal buzz.

---

## Rollback and Compatibility Notes

- Existing v1.0 service pins remain readable; missing `paymentTiming` and `settlementKind` are derived.
- Existing orders with only payment txids remain readable through legacy lookup fallback.
- Free orders created after this change must have empty `paymentTxid` and non-empty `orderPinId`.
- The app may keep local UUID `service_orders.id` for SQLite row operations and existing refund IPC. Do not publish or describe that local id as a MetaID order id.
- Legacy `paymentAddress` is a compatibility fallback for old service pins only. New v1.1 service pins should not include it.
- If MRC20 publication must stay available for new v1.1 services, pause and update the protocol SOT first. The current SOT only defines protocol `settlementKind` as `native|fiat`.

## Final Verification Before Handoff

- `git status --short` is clean.
- All commits are small, typed, and buzzed.
- OAC SOT and IDBots mirror docs remain unchanged unless a protocol issue is discovered and explicitly approved.
- No push is performed unless the user asks.
