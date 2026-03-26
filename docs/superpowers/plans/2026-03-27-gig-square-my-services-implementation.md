# Gig Square My Services Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `我的服务` management panel in Gig Square that lists the current device user's on-chain services, shows seller-side business metrics, opens per-service completed/refunded order details, and fixes the underlying `skill-service` sync to paginate by cursor instead of stopping at 200 rows.

**Architecture:** Keep service truth in the existing `remote_skill_service` cache, but extract the current main-process Gig Square sync/query logic into focused services so pagination, rating-detail persistence, and seller-side aggregation can be tested independently of the Electron IPC shell. Keep order truth in `service_orders`, strengthen seller-side `cowork_session_id` linkage, and expose renderer-facing IPC methods that return pre-aggregated panel data instead of pushing SQL concerns into React.

**Tech Stack:** Electron main process, React renderer, TypeScript services/components, sql.js-backed SQLite, Node `node:test`, server-side React static markup tests, existing `cowork` IPC/navigation flow.

---

## Inputs

- Spec: `docs/superpowers/specs/2026-03-27-gig-square-my-services-design.md`
- Existing related code:
  - `src/main/main.ts`
  - `src/main/sqliteStore.ts`
  - `src/main/serviceOrderStore.ts`
  - `src/main/services/privateChatDaemon.ts`
  - `src/main/services/privateChatOrderCowork.ts`
  - `src/renderer/components/gigSquare/GigSquareView.tsx`
  - `src/renderer/types/gigSquare.ts`
  - `src/renderer/types/electron.d.ts`
  - `src/renderer/services/i18n.ts`

## File Map

### New files

- `src/main/services/gigSquareRemoteServiceSync.ts`
  - Cursor-based remote `skill-service` sync helpers and DB upsert orchestration
- `src/main/services/gigSquareRatingSyncService.ts`
  - Rating-detail persistence and service-level rating aggregate updates
- `src/main/services/gigSquareMyServicesService.ts`
  - Aggregation queries for `我的服务` list and order details
- `src/renderer/components/gigSquare/GigSquareMyServicesModal.tsx`
  - Large panel component with `list -> detail` internal navigation
- `src/renderer/components/gigSquare/gigSquareMyServicesPresentation.js`
  - Pure formatting/presentation helpers for metrics, disabled actions, and order badges
- `tests/gigSquareRemoteServiceSync.test.mjs`
- `tests/gigSquareRatingSyncService.test.mjs`
- `tests/gigSquareMyServicesService.test.mjs`
- `tests/gigSquareMyServicesPresentation.test.mjs`
- `tests/gigSquareMyServicesModal.test.tsx`

### Modified files

- `src/main/main.ts`
  - Wire extracted Gig Square services and expose new IPC handlers
- `src/main/sqliteStore.ts`
  - Add rating-detail columns and indexes needed by the new sync/query logic
- `src/main/services/privateChatDaemon.ts`
  - Persist seller-side `cowork_session_id` as soon as the order session is known
- `src/main/services/privateChatOrderCowork.ts`
  - Surface the seller order session id (or an accessor for it) cleanly enough for the daemon to persist
- `src/main/preload.ts`
  - Expose `gigSquare.fetchMyServices()` and `gigSquare.fetchMyServiceOrders()`
- `src/renderer/App.tsx`
  - Handle a generic `cowork:viewSession` event in the same style as scheduled-task session navigation
- `src/renderer/components/gigSquare/GigSquareView.tsx`
  - Add `我的服务` button and open/close the new modal
- `src/renderer/services/i18n.ts`
  - Add `我的服务` strings, empty/error text, order-detail labels, disabled-action copy
- `src/renderer/types/gigSquare.ts`
  - Add `ratingAvg`, my-service summary types, and order-detail types
- `src/renderer/types/electron.d.ts`
  - Add new IPC method signatures and response types

### Verification commands used throughout

- `npm run compile:electron`
- `node --test tests/gigSquareRemoteServiceSync.test.mjs`
- `node --test tests/gigSquareRatingSyncService.test.mjs`
- `node --test tests/gigSquareMyServicesService.test.mjs`
- `node --test tests/gigSquareMyServicesPresentation.test.mjs tests/gigSquareMyServicesModal.test.tsx`
- `node --test tests/serviceOrderSessionResolution.test.mjs`
- `npm run lint`
- `npm run electron:dev`

Note: the repo already has a known unrelated failure in `tests/skillFrontmatter.test.mjs`. Keep verification scoped to the files touched for this feature plus `lint`/manual UI checks.

---

### Task 1: Create the Isolated Worktree and Verify the Baseline

**Files:**
- Existing: `.worktrees/`
- Reference: `docs/superpowers/specs/2026-03-27-gig-square-my-services-design.md`

- [ ] **Step 1: Create the worktree**

Run:

```bash
git worktree add .worktrees/gig-square-my-services -b codex/gig-square-my-services
```

Expected:

- New branch `codex/gig-square-my-services`
- New directory `.worktrees/gig-square-my-services`

- [ ] **Step 2: Install dependencies in the worktree**

Run:

```bash
cd .worktrees/gig-square-my-services
npm install
```

Expected:

- Install completes without adding unexpected lockfile or dependency drift

- [ ] **Step 3: Verify the focused baseline is green**

Run:

```bash
npm run compile:electron
node --test tests/serviceOrderStore.test.mjs tests/serviceOrderLifecycleService.test.mjs tests/serviceRefundSyncService.test.mjs tests/gigSquareRefundRiskPresentation.test.mjs
```

Expected:

- Compile passes
- Focused baseline tests pass before any feature code is written

- [ ] **Step 4: Record the known baseline caveat in the worklog**

Note in your task notes:

- `tests/skillFrontmatter.test.mjs` is currently unrelated and known-bad per `localdocs/gotchas.md`
- Do not use that failure to block this feature

---

### Task 2: Extract Cursor-Paginated Remote Skill-Service Sync

**Files:**
- Create: `src/main/services/gigSquareRemoteServiceSync.ts`
- Modify: `src/main/main.ts`
- Modify: `src/renderer/types/gigSquare.ts`
- Test: `tests/gigSquareRemoteServiceSync.test.mjs`

- [ ] **Step 1: Write the failing sync tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  syncRemoteSkillServicesWithCursor,
  parseRemoteSkillServiceRow,
} = require('../dist-electron/services/gigSquareRemoteServiceSync.js');

test('syncRemoteSkillServicesWithCursor keeps following nextCursor until exhausted', async () => {
  const calls = [];
  const inserted = [];
  await syncRemoteSkillServicesWithCursor({
    pageSize: 2,
    fetchPage: async (cursor) => {
      calls.push(cursor ?? null);
      if (!cursor) return { list: [{ id: 'svc-1' }, { id: 'svc-2' }], nextCursor: 'cursor-2' };
      if (cursor === 'cursor-2') return { list: [{ id: 'svc-3' }], nextCursor: null };
      return { list: [], nextCursor: null };
    },
    upsertService: (row) => inserted.push(row.id),
  });

  assert.deepEqual(calls, [null, 'cursor-2']);
  assert.deepEqual(inserted, ['svc-1', 'svc-2', 'svc-3']);
});

test('parseRemoteSkillServiceRow exposes ratingAvg when present in the cache row', () => {
  const row = parseRemoteSkillServiceRow({
    id: 'svc-1',
    rating_avg: 4.2,
    rating_count: 6,
  });

  assert.equal(row.ratingAvg, 4.2);
  assert.equal(row.ratingCount, 6);
});
```

- [ ] **Step 2: Run the sync test and watch it fail**

Run:

```bash
npm run compile:electron && node --test tests/gigSquareRemoteServiceSync.test.mjs
```

Expected:

- FAIL because `gigSquareRemoteServiceSync.ts` does not exist yet

- [ ] **Step 3: Implement the extracted sync module**

Add a focused service with a seam that can be tested without `ipcMain`:

```ts
export async function syncRemoteSkillServicesWithCursor(input: {
  pageSize: number;
  fetchPage: (cursor?: string) => Promise<{ list: Record<string, unknown>[]; nextCursor?: string | null }>;
  upsertService: (row: ParsedRemoteSkillServiceRow) => void;
}) {
  let cursor: string | undefined;
  do {
    const page = await input.fetchPage(cursor);
    for (const item of page.list) {
      const parsed = parseRemoteSkillServiceItem(item);
      if (parsed) input.upsertService(parsed);
    }
    cursor = page.nextCursor || undefined;
  } while (cursor);
}
```

- [ ] **Step 4: Wire `main.ts` to the new service**

Replace the inlined fixed-`200` sync block with the extracted helper and make `listRemoteSkillServicesFromDb()` return `ratingAvg` alongside `ratingCount`.

- [ ] **Step 5: Re-run the sync test**

Run:

```bash
npm run compile:electron && node --test tests/gigSquareRemoteServiceSync.test.mjs
```

Expected:

- PASS

- [ ] **Step 6: Commit the pagination extraction**

```bash
git add src/main/services/gigSquareRemoteServiceSync.ts src/main/main.ts src/renderer/types/gigSquare.ts tests/gigSquareRemoteServiceSync.test.mjs
git commit -m "feat: paginate gig square remote service sync"
```

---

### Task 3: Extend Rating Sync into Rating-Detail Persistence

**Files:**
- Create: `src/main/services/gigSquareRatingSyncService.ts`
- Modify: `src/main/sqliteStore.ts`
- Modify: `src/main/main.ts`
- Test: `tests/gigSquareRatingSyncService.test.mjs`

- [ ] **Step 1: Write the failing rating-detail tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  applyRatingDelta,
  parseRatingPin,
} = require('../dist-electron/services/gigSquareRatingSyncService.js');

test('parseRatingPin keeps serviceID, servicePaidTx, rate, and comment', () => {
  const parsed = parseRatingPin({
    id: 'pin-1',
    globalMetaId: 'buyer-global',
    contentSummary: JSON.stringify({
      serviceID: 'svc-1',
      servicePaidTx: 'a'.repeat(64),
      rate: '5',
      comment: 'Very good',
    }),
  });

  assert.equal(parsed.serviceId, 'svc-1');
  assert.equal(parsed.servicePaidTx, 'a'.repeat(64));
  assert.equal(parsed.rate, 5);
  assert.equal(parsed.comment, 'Very good');
});

test('applyRatingDelta updates aggregate rating fields after inserting rating detail', () => {
  const result = applyRatingDelta({ ratingAvg: 4, ratingCount: 2 }, { sum: 5, count: 1 });
  assert.equal(result.ratingAvg, 13 / 3);
  assert.equal(result.ratingCount, 3);
});
```

- [ ] **Step 2: Run the rating-detail test and verify failure**

Run:

```bash
npm run compile:electron && node --test tests/gigSquareRatingSyncService.test.mjs
```

Expected:

- FAIL because the extracted rating sync service does not exist yet

- [ ] **Step 3: Add the schema migration for rating-detail columns**

Update `remote_skill_service_rating_seen` to include:

```sql
ALTER TABLE remote_skill_service_rating_seen ADD COLUMN service_paid_tx TEXT;
ALTER TABLE remote_skill_service_rating_seen ADD COLUMN comment TEXT;
ALTER TABLE remote_skill_service_rating_seen ADD COLUMN rater_global_metaid TEXT;
ALTER TABLE remote_skill_service_rating_seen ADD COLUMN rater_metaid TEXT;
CREATE INDEX IF NOT EXISTS idx_remote_skill_service_rating_paid_tx
  ON remote_skill_service_rating_seen(service_paid_tx);
```

- [ ] **Step 4: Extract and wire the new rating sync service**

Move the current rating-scan logic out of `main.ts`, preserve aggregate updates, and make each inserted row retain enough detail for later order-detail joins.

- [ ] **Step 5: Re-run the focused rating test**

Run:

```bash
npm run compile:electron && node --test tests/gigSquareRatingSyncService.test.mjs
```

Expected:

- PASS

- [ ] **Step 6: Commit the rating-detail cache**

```bash
git add src/main/services/gigSquareRatingSyncService.ts src/main/sqliteStore.ts src/main/main.ts tests/gigSquareRatingSyncService.test.mjs
git commit -m "feat: persist gig square rating details"
```

---

### Task 4: Add Main-Process My-Services Aggregation Queries

**Files:**
- Create: `src/main/services/gigSquareMyServicesService.ts`
- Modify: `src/main/main.ts`
- Modify: `src/main/preload.ts`
- Modify: `src/renderer/types/gigSquare.ts`
- Modify: `src/renderer/types/electron.d.ts`
- Test: `tests/gigSquareMyServicesService.test.mjs`

- [ ] **Step 1: Write the failing aggregation tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';

const {
  buildMyServiceSummaries,
  buildMyServiceOrderDetails,
} = require('../dist-electron/services/gigSquareMyServicesService.js');

test('buildMyServiceSummaries filters services by owned globalmetaids and paginates 8 rows', () => {
  const services = Array.from({ length: 9 }, (_, index) => ({
    id: `svc-${index}`,
    providerGlobalMetaId: 'owned-global',
    updatedAt: 100 - index,
  }));
  const page = buildMyServiceSummaries({
    ownedGlobalMetaIds: new Set(['owned-global']),
    services,
    sellerOrders: [],
    page: 1,
    pageSize: 8,
  });

  assert.equal(page.items.length, 8);
  assert.equal(page.total, 9);
});

test('buildMyServiceOrderDetails only returns completed and refunded seller orders', () => {
  const result = buildMyServiceOrderDetails({
    serviceId: 'svc-1',
    sellerOrders: [
      { id: '1', servicePinId: 'svc-1', status: 'completed' },
      { id: '2', servicePinId: 'svc-1', status: 'refunded' },
      { id: '3', servicePinId: 'svc-1', status: 'in_progress' },
    ],
    ratingsByPaymentTxid: new Map(),
    page: 1,
    pageSize: 10,
  });

  assert.deepEqual(result.items.map((item) => item.id), ['2', '1']);
});
```

- [ ] **Step 2: Run the aggregation test and confirm failure**

Run:

```bash
npm run compile:electron && node --test tests/gigSquareMyServicesService.test.mjs
```

Expected:

- FAIL because the query service does not exist yet

- [ ] **Step 3: Implement the query service**

Keep the main logic pure and testable:

```ts
export function buildMyServiceSummaries(input: {
  ownedGlobalMetaIds: Set<string>;
  services: GigSquareService[];
  sellerOrders: ServiceOrderRecord[];
  page: number;
  pageSize: number;
}) {
  // filter owned services
  // aggregate completed/refunded counts and revenue fields
  // sort by updatedAt desc
  // return page metadata + items
}
```

Also include an order-detail builder that joins rating details by `servicePaidTx/paymentTxid`.

- [ ] **Step 4: Expose renderer IPC methods**

Add:

- `gigSquare:fetchMyServices`
- `gigSquare:fetchMyServiceOrders`

and wire them through `preload.ts` and `electron.d.ts`.

- [ ] **Step 5: Re-run the aggregation test**

Run:

```bash
npm run compile:electron && node --test tests/gigSquareMyServicesService.test.mjs
```

Expected:

- PASS

- [ ] **Step 6: Commit the main-process query layer**

```bash
git add src/main/services/gigSquareMyServicesService.ts src/main/main.ts src/main/preload.ts src/renderer/types/gigSquare.ts src/renderer/types/electron.d.ts tests/gigSquareMyServicesService.test.mjs
git commit -m "feat: expose gig square my services queries"
```

---

### Task 5: Make Seller Orders Persist Their Cowork Session ID

**Files:**
- Modify: `src/main/services/privateChatDaemon.ts`
- Modify: `src/main/services/privateChatOrderCowork.ts`
- Modify: `src/main/main.ts`
- Test: `tests/serviceOrderSessionResolution.test.mjs`
- Test: `tests/gigSquareMyServicesService.test.mjs`

- [ ] **Step 1: Extend the session-resolution test with seller-session linkage**

```js
test('resolveServiceOrderForSession prefers an explicit cowork_session_id over txid fallback', () => {
  const resolved = resolveOrderSessionId({
    directSessionId: 'session-direct',
    fallbackSessionId: 'session-fallback',
  });

  assert.equal(resolved, 'session-direct');
});
```

- [ ] **Step 2: Run the focused session test and watch it fail**

Run:

```bash
npm run compile:electron && node --test tests/serviceOrderSessionResolution.test.mjs tests/gigSquareMyServicesService.test.mjs
```

Expected:

- FAIL because the new explicit seller-session behavior is not wired yet

- [ ] **Step 3: Update seller order handling**

Change the seller-side order flow so that, once the A2A order session exists, the matching seller order row receives that `sessionId` immediately instead of relying only on later fallback resolution.

One acceptable pattern:

```ts
const mapping = coworkStore.getConversationMapping('metaweb_order', externalConversationId, metabot.id);
if (mapping?.coworkSessionId && txid) {
  serviceOrderLifecycle.attachCoworkSessionToSellerOrder({
    localMetabotId: metabot.id,
    counterpartyGlobalMetaId: fromGlobalMetaId,
    paymentTxid: txid,
    coworkSessionId: mapping.coworkSessionId,
  });
}
```

- [ ] **Step 4: Keep fallback resolution intact**

Do not remove the existing `payment_txid`-based fallback in `main.ts`; keep it as a backstop for legacy rows and older sessions.

- [ ] **Step 5: Re-run the focused session tests**

Run:

```bash
npm run compile:electron && node --test tests/serviceOrderSessionResolution.test.mjs tests/gigSquareMyServicesService.test.mjs
```

Expected:

- PASS

- [ ] **Step 6: Commit the session-linking change**

```bash
git add src/main/services/privateChatDaemon.ts src/main/services/privateChatOrderCowork.ts src/main/main.ts tests/serviceOrderSessionResolution.test.mjs tests/gigSquareMyServicesService.test.mjs
git commit -m "feat: persist seller order cowork sessions"
```

---

### Task 6: Build the My-Services Modal Shell in the Renderer

**Files:**
- Create: `src/renderer/components/gigSquare/GigSquareMyServicesModal.tsx`
- Create: `src/renderer/components/gigSquare/gigSquareMyServicesPresentation.js`
- Modify: `src/renderer/components/gigSquare/GigSquareView.tsx`
- Modify: `src/renderer/services/i18n.ts`
- Test: `tests/gigSquareMyServicesPresentation.test.mjs`
- Test: `tests/gigSquareMyServicesModal.test.tsx`

- [ ] **Step 1: Write the failing renderer helper tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getMyServiceActionState,
  getMyServiceMetricLabel,
} from '../src/renderer/components/gigSquare/gigSquareMyServicesPresentation.js';

test('撤销 and 修改 stay disabled in v1', () => {
  assert.deepEqual(getMyServiceActionState('revoke'), { disabled: true, key: 'gigSquareMyServicesComingSoon' });
  assert.deepEqual(getMyServiceActionState('edit'), { disabled: true, key: 'gigSquareMyServicesComingSoon' });
});
```

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import GigSquareMyServicesModal from '../src/renderer/components/gigSquare/GigSquareMyServicesModal';

test('empty-state modal renders go-publish CTA', () => {
  const markup = renderToStaticMarkup(
    <GigSquareMyServicesModal
      isOpen
      servicesPage={{ items: [], total: 0, page: 1, pageSize: 8, totalPages: 0 }}
      view="list"
      onClose={() => {}}
      onOpenPublish={() => {}}
    />
  );

  assert.match(markup, /去发布服务/);
});
```

- [ ] **Step 2: Run the renderer tests and confirm failure**

Run:

```bash
node --test tests/gigSquareMyServicesPresentation.test.mjs tests/gigSquareMyServicesModal.test.tsx
```

Expected:

- FAIL because the modal and helper files do not exist yet

- [ ] **Step 3: Implement the modal shell**

The first pass should include:

- list view header
- `我的服务` button wiring in `GigSquareView`
- list pagination chrome
- service rows with `明细 / 撤销 / 修改`
- empty state and loading/error state

Keep button state/label rules in the pure helper module.

- [ ] **Step 4: Add all new copy to `i18n.ts`**

Add Chinese and English strings together so the modal never ships half-localized.

- [ ] **Step 5: Re-run the renderer tests**

Run:

```bash
node --test tests/gigSquareMyServicesPresentation.test.mjs tests/gigSquareMyServicesModal.test.tsx
```

Expected:

- PASS

- [ ] **Step 6: Commit the modal shell**

```bash
git add src/renderer/components/gigSquare/GigSquareMyServicesModal.tsx src/renderer/components/gigSquare/gigSquareMyServicesPresentation.js src/renderer/components/gigSquare/GigSquareView.tsx src/renderer/services/i18n.ts tests/gigSquareMyServicesPresentation.test.mjs tests/gigSquareMyServicesModal.test.tsx
git commit -m "feat: add gig square my services modal shell"
```

---

### Task 7: Add the Order-Detail View and Cowork Navigation

**Files:**
- Modify: `src/renderer/components/gigSquare/GigSquareMyServicesModal.tsx`
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/types/electron.d.ts`
- Test: `tests/gigSquareMyServicesModal.test.tsx`

- [ ] **Step 1: Extend the modal test to cover detail-view rendering**

```tsx
test('detail view renders completed/refunded order rows and a disabled session action when sessionId is missing', () => {
  const markup = renderToStaticMarkup(
    <GigSquareMyServicesModal
      isOpen
      view="detail"
      selectedService={{ id: 'svc-1', displayName: 'Weather' }}
      ordersPage={{
        items: [{
          id: 'order-1',
          status: 'refunded',
          paymentTxid: 'a'.repeat(64),
          sessionId: null,
        }],
        total: 1,
        page: 1,
        pageSize: 10,
        totalPages: 1,
      }}
      onClose={() => {}}
      onBackToList={() => {}}
    />
  );

  assert.match(markup, /退款/);
  assert.match(markup, /本机无对应会话记录/);
});
```

- [ ] **Step 2: Add the generic `cowork:viewSession` listener in `App.tsx`**

Mirror the existing scheduled-task flow:

```ts
window.addEventListener('cowork:viewSession', async (event) => {
  const { sessionId } = (event as CustomEvent).detail;
  if (!sessionId) return;
  setMainView('cowork');
  await coworkService.loadSession(sessionId);
});
```

- [ ] **Step 3: Implement detail-view paging and navigation**

Make the modal:

- switch from list view to detail view on `明细`
- preserve the list page when returning
- dispatch `cowork:viewSession` and close itself on successful click

- [ ] **Step 4: Re-run the modal tests**

Run:

```bash
node --test tests/gigSquareMyServicesModal.test.tsx
```

Expected:

- PASS

- [ ] **Step 5: Manually verify the panel in Electron**

Run:

```bash
npm run electron:dev
```

Manual checks:

- open Gig Square
- open `我的服务`
- verify list pagination and empty/error states
- enter a service detail page
- verify `查看会话` routes to Cowork for a row that has `sessionId`
- verify `撤销/修改` stay disabled

- [ ] **Step 6: Commit the UI integration**

```bash
git add src/renderer/components/gigSquare/GigSquareMyServicesModal.tsx src/renderer/App.tsx src/renderer/types/electron.d.ts tests/gigSquareMyServicesModal.test.tsx
git commit -m "feat: add gig square my service order details"
```

---

### Task 8: Final Verification and Cleanup

**Files:**
- Modify: any touched files from prior tasks

- [ ] **Step 1: Run the full focused verification set**

Run:

```bash
npm run compile:electron
node --test tests/gigSquareRemoteServiceSync.test.mjs
node --test tests/gigSquareRatingSyncService.test.mjs
node --test tests/gigSquareMyServicesService.test.mjs
node --test tests/serviceOrderSessionResolution.test.mjs
node --test tests/gigSquareMyServicesPresentation.test.mjs tests/gigSquareMyServicesModal.test.tsx
npm run lint
```

Expected:

- All targeted tests pass
- `lint` passes with no warnings

- [ ] **Step 2: Re-run the manual UI smoke**

Run:

```bash
npm run electron:dev
```

Manual acceptance:

- service sync loads more than the first page worth of chain data
- owned-service filtering matches current device MetaBots
- metrics match seeded/local ledger expectations
- detail rows show rating and refund fields correctly
- session jump works where data exists

- [ ] **Step 3: Summarize any residual risks before merge**

Specifically call out:

- full-chain sync cost if `skill-service` volume grows very large later
- current feature still depends on local `service_orders` for order history
- cross-device historical order reconstruction remains intentionally out of scope

- [ ] **Step 4: Commit final polish**

```bash
git add src/main/main.ts src/main/sqliteStore.ts src/main/services/gigSquareRemoteServiceSync.ts src/main/services/gigSquareRatingSyncService.ts src/main/services/gigSquareMyServicesService.ts src/main/services/privateChatDaemon.ts src/main/services/privateChatOrderCowork.ts src/main/preload.ts src/renderer/App.tsx src/renderer/components/gigSquare/GigSquareView.tsx src/renderer/components/gigSquare/GigSquareMyServicesModal.tsx src/renderer/components/gigSquare/gigSquareMyServicesPresentation.js src/renderer/services/i18n.ts src/renderer/types/gigSquare.ts src/renderer/types/electron.d.ts tests/gigSquareRemoteServiceSync.test.mjs tests/gigSquareRatingSyncService.test.mjs tests/gigSquareMyServicesService.test.mjs tests/gigSquareMyServicesPresentation.test.mjs tests/gigSquareMyServicesModal.test.tsx tests/serviceOrderSessionResolution.test.mjs
git commit -m "feat: add gig square my services management"
```
