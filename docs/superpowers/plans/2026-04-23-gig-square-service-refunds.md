# Gig Square Service Refunds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a stable Bot Hub refund hub that shows seller-side refund work items, shows buyer-side refund requests, and lets sellers process pending refunds without depending on A2A session visibility.

**Architecture:** Keep refund state sourced from existing `service_orders` rows and add one injected main-process service that maps seller/buyer refund orders into renderer-ready collections. Reuse the existing refund settlement pipeline for actual refund execution, then layer a new Bot Hub modal and header actions on top of the new Gig Square IPC surface so the A2A flow remains unchanged.

**Tech Stack:** Electron main process, React renderer, TypeScript, sql.js-backed order store, `node:test`, existing Gig Square IPC bridge, existing service refund settlement flow, existing `cowork:viewSession` navigation event.

---

## File Map

### New files

- `src/main/services/gigSquareRefundsService.ts`
  - Injected main-process service for refund list aggregation and order-based refund execution
  - Converts `service_orders` rows into renderer-friendly refund collections
  - Keeps seller/buyer sorting rules and `canProcessRefund` logic in one place
- `src/renderer/components/gigSquare/GigSquareRefundsModal.tsx`
  - Refund hub modal with two tabs, empty/error/loading states, and per-row refund actions
- `src/renderer/components/gigSquare/GigSquareHeaderActions.tsx`
  - Small pure header-actions component so the new `服务退款` button and pending badge are easy to render and test
- `tests/gigSquareRefundsService.test.mjs`
  - Main-process tests for grouping, sorting, session fallback, pending counts, and seller-only refund processing
- `tests/gigSquareRefundsModal.test.tsx`
  - Renderer tests for tab rendering, row fields, status badges, and seller/buyer action visibility
- `tests/gigSquareHeaderActions.test.tsx`
  - Renderer tests for the `服务退款` button and pending-count badge
- `tests/coworkServiceOrderPresentation.test.mjs`
  - Renderer regression tests for the existing A2A refund-card variant logic so the legacy refund path stays unchanged

### Modified files

- `src/main/main.ts`
  - Instantiate `GigSquareRefundsService`
  - Add `gigSquare:fetchRefunds` and `gigSquare:processRefundOrder` IPC handlers
  - Reuse existing order/session resolution helpers and existing refund settlement service
- `src/main/preload.ts`
  - Expose `window.electron.gigSquare.fetchRefunds()` and `window.electron.gigSquare.processRefundOrder()`
- `src/renderer/types/gigSquare.ts`
  - Add `GigSquareRefundItem` and `GigSquareRefundCollections` renderer types
- `src/renderer/types/electron.d.ts`
  - Add the new Gig Square IPC request/response shapes
- `src/renderer/components/gigSquare/GigSquareView.tsx`
  - Load refund collections for the top-bar badge
  - Open the new refund modal
  - Refresh refund state after a seller processes a refund
- `src/renderer/services/i18n.ts`
  - Add Chinese and English strings for the refund hub button, tabs, rows, states, and actions

### Verification commands used throughout

- `npm run compile:electron`
- `node --test tests/gigSquareRefundsService.test.mjs`
- `npx tsx --test tests/gigSquareRefundsModal.test.tsx tests/gigSquareHeaderActions.test.tsx`
- `node --test tests/coworkServiceOrderPresentation.test.mjs`
- `npm run lint`
- `npm run electron:dev`

---

### Task 1: Add the Main-Process Refund Hub Service

**Files:**
- Create: `src/main/services/gigSquareRefundsService.ts`
- Test: `tests/gigSquareRefundsService.test.mjs`

- [ ] **Step 1: Write the failing refund-service tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';

let GigSquareRefundsService;

test.before(async () => {
  ({ GigSquareRefundsService } = await import('../dist-electron/services/gigSquareRefundsService.js'));
});

test('listRefunds groups seller and buyer refund rows and counts seller pending items', async () => {
  const service = new GigSquareRefundsService({
    listSellerRefundOrders: () => [
      {
        id: 'seller-pending',
        role: 'seller',
        localMetabotId: 7,
        counterpartyGlobalMetaid: 'buyer-global-1',
        servicePinId: 'svc-1',
        serviceName: 'Weather',
        paymentTxid: '1'.repeat(64),
        paymentAmount: '1.5',
        paymentCurrency: 'SPACE',
        status: 'refund_pending',
        failureReason: 'delivery_timeout',
        refundRequestPinId: 'refund-pin-1',
        refundTxid: null,
        refundRequestedAt: 1_770_100_000_000,
        refundCompletedAt: null,
        coworkSessionId: null,
        createdAt: 1_770_099_000_000,
        updatedAt: 1_770_100_000_000,
      },
      {
        id: 'seller-refunded',
        role: 'seller',
        localMetabotId: 7,
        counterpartyGlobalMetaid: 'buyer-global-2',
        servicePinId: 'svc-2',
        serviceName: 'Research',
        paymentTxid: '2'.repeat(64),
        paymentAmount: '2.0',
        paymentCurrency: 'SPACE',
        status: 'refunded',
        failureReason: 'first_response_timeout',
        refundRequestPinId: 'refund-pin-2',
        refundTxid: 'b'.repeat(64),
        refundRequestedAt: 1_770_090_000_000,
        refundCompletedAt: 1_770_091_000_000,
        coworkSessionId: 'session-known',
        createdAt: 1_770_089_000_000,
        updatedAt: 1_770_091_000_000,
      },
    ],
    listBuyerRefundOrders: () => [
      {
        id: 'buyer-pending',
        role: 'buyer',
        localMetabotId: 5,
        counterpartyGlobalMetaid: 'seller-global-1',
        servicePinId: 'svc-3',
        serviceName: 'Translate',
        paymentTxid: '3'.repeat(64),
        paymentAmount: '0.4',
        paymentCurrency: 'DOGE',
        status: 'refund_pending',
        failureReason: 'delivery_timeout',
        refundRequestPinId: 'refund-pin-3',
        refundTxid: null,
        refundRequestedAt: 1_770_120_000_000,
        refundCompletedAt: null,
        coworkSessionId: null,
        createdAt: 1_770_119_000_000,
        updatedAt: 1_770_120_000_000,
      },
    ],
    resolveCounterpartyInfo: async (globalMetaId) => ({
      name: globalMetaId === 'buyer-global-1' ? 'Buyer One' : null,
      avatarUrl: globalMetaId === 'buyer-global-1' ? 'https://example.com/buyer-1.png' : null,
    }),
    resolveCoworkSessionIdForOrder: (order) => (
      order.id === 'seller-pending' ? 'session-recovered' : order.coworkSessionId ?? null
    ),
    processSellerRefundForOrderId: async () => {
      throw new Error('not used');
    },
  });

  const result = await service.listRefunds();

  assert.equal(result.pendingCount, 1);
  assert.deepEqual(
    result.pendingForMe.map((item) => [item.orderId, item.status, item.canProcessRefund]),
    [
      ['seller-pending', 'refund_pending', true],
      ['seller-refunded', 'refunded', false],
    ],
  );
  assert.equal(result.pendingForMe[0].counterpartyName, 'Buyer One');
  assert.equal(result.pendingForMe[0].counterpartyAvatar, 'https://example.com/buyer-1.png');
  assert.equal(result.pendingForMe[0].coworkSessionId, 'session-recovered');
  assert.equal(result.initiatedByMe[0].canProcessRefund, false);
});

test('listRefunds follows the spec sorting rules for seller and buyer tabs', async () => {
  const service = new GigSquareRefundsService({
    listSellerRefundOrders: () => [
      {
        id: 'seller-pending-late',
        role: 'seller',
        localMetabotId: 7,
        counterpartyGlobalMetaid: 'buyer-global-1',
        servicePinId: 'svc-1',
        serviceName: 'Weather',
        paymentTxid: '4'.repeat(64),
        paymentAmount: '1.5',
        paymentCurrency: 'SPACE',
        status: 'refund_pending',
        failureReason: null,
        refundRequestPinId: 'refund-pin-4',
        refundTxid: null,
        refundRequestedAt: 1_770_110_000_000,
        refundCompletedAt: null,
        coworkSessionId: null,
        createdAt: 1_770_109_000_000,
        updatedAt: 1_770_110_000_000,
      },
      {
        id: 'seller-pending-early',
        role: 'seller',
        localMetabotId: 7,
        counterpartyGlobalMetaid: 'buyer-global-2',
        servicePinId: 'svc-2',
        serviceName: 'Research',
        paymentTxid: '5'.repeat(64),
        paymentAmount: '2.0',
        paymentCurrency: 'SPACE',
        status: 'refund_pending',
        failureReason: null,
        refundRequestPinId: 'refund-pin-5',
        refundTxid: null,
        refundRequestedAt: 1_770_090_000_000,
        refundCompletedAt: null,
        coworkSessionId: null,
        createdAt: 1_770_089_000_000,
        updatedAt: 1_770_090_000_000,
      },
      {
        id: 'seller-refunded',
        role: 'seller',
        localMetabotId: 7,
        counterpartyGlobalMetaid: 'buyer-global-3',
        servicePinId: 'svc-3',
        serviceName: 'Translate',
        paymentTxid: '6'.repeat(64),
        paymentAmount: '0.4',
        paymentCurrency: 'DOGE',
        status: 'refunded',
        failureReason: null,
        refundRequestPinId: 'refund-pin-6',
        refundTxid: '7'.repeat(64),
        refundRequestedAt: 1_770_080_000_000,
        refundCompletedAt: 1_770_081_000_000,
        coworkSessionId: null,
        createdAt: 1_770_079_000_000,
        updatedAt: 1_770_081_000_000,
      },
    ],
    listBuyerRefundOrders: () => [
      {
        id: 'buyer-pending',
        role: 'buyer',
        localMetabotId: 5,
        counterpartyGlobalMetaid: 'seller-global-1',
        servicePinId: 'svc-4',
        serviceName: 'Summary',
        paymentTxid: '8'.repeat(64),
        paymentAmount: '5',
        paymentCurrency: 'SPACE',
        status: 'refund_pending',
        failureReason: null,
        refundRequestPinId: 'refund-pin-7',
        refundTxid: null,
        refundRequestedAt: 1_770_120_000_000,
        refundCompletedAt: null,
        coworkSessionId: null,
        createdAt: 1_770_119_000_000,
        updatedAt: 1_770_120_000_000,
      },
      {
        id: 'buyer-refunded-newest',
        role: 'buyer',
        localMetabotId: 5,
        counterpartyGlobalMetaid: 'seller-global-2',
        servicePinId: 'svc-5',
        serviceName: 'Plan',
        paymentTxid: '9'.repeat(64),
        paymentAmount: '6',
        paymentCurrency: 'SPACE',
        status: 'refunded',
        failureReason: null,
        refundRequestPinId: 'refund-pin-8',
        refundTxid: 'a'.repeat(64),
        refundRequestedAt: 1_770_070_000_000,
        refundCompletedAt: 1_770_130_000_000,
        coworkSessionId: null,
        createdAt: 1_770_069_000_000,
        updatedAt: 1_770_130_000_000,
      },
      {
        id: 'buyer-refunded-older',
        role: 'buyer',
        localMetabotId: 5,
        counterpartyGlobalMetaid: 'seller-global-3',
        servicePinId: 'svc-6',
        serviceName: 'Translate',
        paymentTxid: 'b'.repeat(64),
        paymentAmount: '7',
        paymentCurrency: 'SPACE',
        status: 'refunded',
        failureReason: null,
        refundRequestPinId: 'refund-pin-9',
        refundTxid: 'c'.repeat(64),
        refundRequestedAt: 1_770_060_000_000,
        refundCompletedAt: 1_770_100_000_000,
        coworkSessionId: null,
        createdAt: 1_770_059_000_000,
        updatedAt: 1_770_100_000_000,
      },
    ],
    resolveCounterpartyInfo: async () => ({ name: null, avatarUrl: null }),
    resolveCoworkSessionIdForOrder: () => null,
    processSellerRefundForOrderId: async () => {
      throw new Error('not used');
    },
  });

  const result = await service.listRefunds();

  assert.deepEqual(
    result.pendingForMe.map((item) => item.orderId),
    ['seller-pending-early', 'seller-pending-late', 'seller-refunded'],
  );
  assert.deepEqual(
    result.initiatedByMe.map((item) => item.orderId),
    ['buyer-pending', 'buyer-refunded-newest', 'buyer-refunded-older'],
  );
});

test('processRefundOrder only allows seller refund_pending rows to hit settlement', async () => {
  const seen = [];
  const orders = [
    {
      id: 'seller-pending',
      role: 'seller',
      status: 'refund_pending',
      counterpartyGlobalMetaid: 'buyer-global-1',
      serviceName: 'Weather',
      paymentTxid: 'd'.repeat(64),
      paymentAmount: '1.5',
      paymentCurrency: 'SPACE',
      refundRequestedAt: 1_770_100_000_000,
      refundCompletedAt: null,
      createdAt: 1_770_099_000_000,
      updatedAt: 1_770_100_000_000,
    },
    {
      id: 'seller-refunded',
      role: 'seller',
      status: 'refunded',
      counterpartyGlobalMetaid: 'buyer-global-2',
      serviceName: 'Research',
      paymentTxid: 'e'.repeat(64),
      paymentAmount: '2.0',
      paymentCurrency: 'SPACE',
      refundRequestedAt: 1_770_090_000_000,
      refundCompletedAt: 1_770_091_000_000,
      createdAt: 1_770_089_000_000,
      updatedAt: 1_770_091_000_000,
    },
  ];

  const service = new GigSquareRefundsService({
    listSellerRefundOrders: () => orders,
    listBuyerRefundOrders: () => [],
    resolveCounterpartyInfo: async () => ({ name: null, avatarUrl: null }),
    resolveCoworkSessionIdForOrder: () => null,
    processSellerRefundForOrderId: async (orderId) => {
      seen.push(orderId);
      return { refundTxid: 'c'.repeat(64), refundFinalizePinId: 'refund-finalize-pin' };
    },
  });

  const ok = await service.processRefundOrder('seller-pending');
  assert.equal(ok.refundTxid, 'c'.repeat(64));
  assert.deepEqual(seen, ['seller-pending']);

  await assert.rejects(
    () => service.processRefundOrder('seller-refunded'),
    /Refund order is not awaiting seller action/,
  );
});
```

- [ ] **Step 2: Run the focused tests to verify they fail**

Run:

```bash
npx rimraf dist-electron && npm run compile:electron && node --test tests/gigSquareRefundsService.test.mjs
```

Expected:

- FAIL because `dist-electron/services/gigSquareRefundsService.js` does not exist yet
- or FAIL because `listRefunds()` / `processRefundOrder()` are missing

- [ ] **Step 3: Write the minimal refund aggregation and process guard implementation**

```ts
// src/main/services/gigSquareRefundsService.ts
type RefundRow = {
  id: string;
  role: 'buyer' | 'seller';
  localMetabotId: number;
  counterpartyGlobalMetaid: string;
  servicePinId: string | null;
  serviceName: string;
  paymentTxid: string;
  paymentAmount: string;
  paymentCurrency: string;
  status: 'refund_pending' | 'refunded';
  failureReason: string | null;
  refundRequestPinId: string | null;
  refundTxid: string | null;
  refundRequestedAt: number | null;
  refundCompletedAt: number | null;
  coworkSessionId: string | null;
  createdAt: number;
  updatedAt: number;
};

export class GigSquareRefundsService {
  constructor(private readonly deps: {
    listSellerRefundOrders: () => RefundRow[];
    listBuyerRefundOrders: () => RefundRow[];
    resolveCounterpartyInfo: (globalMetaId: string) => Promise<{ name: string | null; avatarUrl: string | null }>;
    resolveCoworkSessionIdForOrder: (order: RefundRow) => string | null;
    processSellerRefundForOrderId: (orderId: string) => Promise<{ refundTxid?: string; refundFinalizePinId?: string }>;
  }) {}

  async listRefunds() {
    const pendingForMe = await this.mapRows(
      [...this.deps.listSellerRefundOrders()].sort((left, right) => this.sortSellerRefunds(left, right)),
      true,
    );
    const initiatedByMe = await this.mapRows(
      [...this.deps.listBuyerRefundOrders()].sort((left, right) => this.sortBuyerRefunds(left, right)),
      false,
    );

    return {
      pendingForMe,
      initiatedByMe,
      pendingCount: pendingForMe.filter((item) => item.status === 'refund_pending').length,
    };
  }

  private sortSellerRefunds(left: RefundRow, right: RefundRow) {
    if (left.status !== right.status) {
      return left.status === 'refund_pending' ? -1 : 1;
    }
    const leftTime = left.refundRequestedAt ?? left.updatedAt ?? left.createdAt;
    const rightTime = right.refundRequestedAt ?? right.updatedAt ?? right.createdAt;
    return leftTime - rightTime;
  }

  private sortBuyerRefunds(left: RefundRow, right: RefundRow) {
    if (left.status !== right.status) {
      return left.status === 'refund_pending' ? -1 : 1;
    }
    const leftTime = left.status === 'refunded'
      ? (left.refundCompletedAt ?? left.updatedAt ?? left.createdAt)
      : (left.refundRequestedAt ?? left.updatedAt ?? left.createdAt);
    const rightTime = right.status === 'refunded'
      ? (right.refundCompletedAt ?? right.updatedAt ?? right.createdAt)
      : (right.refundRequestedAt ?? right.updatedAt ?? right.createdAt);
    return rightTime - leftTime;
  }

  async processRefundOrder(orderId: string) {
    const sellerOrder = this.deps
      .listSellerRefundOrders()
      .find((order) => order.id === orderId);

    if (!sellerOrder || sellerOrder.status !== 'refund_pending') {
      throw new Error('Refund order is not awaiting seller action');
    }

    return this.deps.processSellerRefundForOrderId(orderId);
  }

  private async mapRows(rows: RefundRow[], allowProcess: boolean) {
    return Promise.all(rows.map(async (order) => {
      const counterparty = await this.deps.resolveCounterpartyInfo(order.counterpartyGlobalMetaid);
      return {
        orderId: order.id,
        role: order.role,
        servicePinId: order.servicePinId,
        serviceName: order.serviceName,
        paymentAmount: order.paymentAmount,
        paymentCurrency: order.paymentCurrency,
        status: order.status,
        failureReason: order.failureReason,
        refundRequestPinId: order.refundRequestPinId,
        refundTxid: order.refundTxid,
        refundRequestedAt: order.refundRequestedAt,
        refundCompletedAt: order.refundCompletedAt,
        counterpartyGlobalMetaid: order.counterpartyGlobalMetaid,
        counterpartyName: counterparty.name,
        counterpartyAvatar: counterparty.avatarUrl,
        coworkSessionId: this.deps.resolveCoworkSessionIdForOrder(order),
        canProcessRefund: allowProcess && order.status === 'refund_pending',
      };
    }));
  }
}
```

- [ ] **Step 4: Re-run the focused tests and make them pass**

Run:

```bash
npx rimraf dist-electron && npm run compile:electron && node --test tests/gigSquareRefundsService.test.mjs
```

Expected:

- PASS for `listRefunds groups seller and buyer refund rows and counts seller pending items`
- PASS for `processRefundOrder only allows seller refund_pending rows to hit settlement`

- [ ] **Step 5: Commit**

```bash
git add src/main/services/gigSquareRefundsService.ts tests/gigSquareRefundsService.test.mjs
git commit -m "feat: add gig square refund service"
```

---

### Task 2: Wire the Gig Square Refund IPC Surface

**Files:**
- Modify: `src/main/main.ts`
- Modify: `src/main/preload.ts`
- Modify: `src/renderer/types/gigSquare.ts`
- Modify: `src/renderer/types/electron.d.ts`
- Test: `tests/gigSquareRefundsService.test.mjs`

- [ ] **Step 1: Extend the failing service test so the order-processing result shape matches the renderer contract**

```js
test('processRefundOrder returns settlement fields needed by the renderer refresh path', async () => {
  const service = new GigSquareRefundsService({
    listSellerRefundOrders: () => [{
      id: 'seller-pending',
      role: 'seller',
      status: 'refund_pending',
      counterpartyGlobalMetaid: 'buyer-global-1',
      serviceName: 'Weather',
      paymentAmount: '1.5',
      paymentCurrency: 'SPACE',
      refundRequestedAt: 1_770_100_000_000,
      refundCompletedAt: null,
      createdAt: 1_770_099_000_000,
      updatedAt: 1_770_100_000_000,
    }],
    listBuyerRefundOrders: () => [],
    resolveCounterpartyInfo: async () => ({ name: null, avatarUrl: null }),
    resolveCoworkSessionIdForOrder: () => null,
    processSellerRefundForOrderId: async () => ({
      refundTxid: 'd'.repeat(64),
      refundFinalizePinId: 'refund-finalize-pin',
    }),
  });

  const result = await service.processRefundOrder('seller-pending');

  assert.deepEqual(result, {
    refundTxid: 'd'.repeat(64),
    refundFinalizePinId: 'refund-finalize-pin',
  });
});
```

- [ ] **Step 2: Run the service test again to verify the current bridge code still fails or is incomplete**

Run:

```bash
npx rimraf dist-electron && npm run compile:electron && node --test tests/gigSquareRefundsService.test.mjs
```

Expected:

- PASS on the pure service behavior only if Task 1 is complete
- Remaining work is now in the main/preload/type bridge, not in the service

- [ ] **Step 3: Add the main/preload/type bridge for refund collections and order-based processing**

```ts
// src/main/main.ts
let gigSquareRefundsService: GigSquareRefundsService | null = null;

const getGigSquareRefundsService = () => {
  if (gigSquareRefundsService) return gigSquareRefundsService;
  gigSquareRefundsService = new GigSquareRefundsService({
    listSellerRefundOrders: () => getServiceOrderStore().listOrdersByStatuses('seller', ['refund_pending', 'refunded']),
    listBuyerRefundOrders: () => getServiceOrderStore().listOrdersByStatuses('buyer', ['refund_pending', 'refunded']),
    resolveCounterpartyInfo: async (globalMetaId) => {
      try {
        const payload = await fetchMetaidUserInfoByGlobalMetaId(globalMetaId);
        const data = unwrapMetaidInfoRecord(payload?.data);
        return {
          name: toSafeString(data?.name).trim() || null,
          avatarUrl: toSafeString(data?.avatarUrl).trim() || null,
        };
      } catch {
        return { name: null, avatarUrl: null };
      }
    },
    resolveCoworkSessionIdForOrder: (order) => {
      const sessions = listCoworkSessionsForOrderResolution();
      return resolveCoworkSessionIdForOrder(order as ServiceOrderRecord, sessions);
    },
    processSellerRefundForOrderId: (orderId) => getServiceRefundSettlementService().processSellerRefundForOrderId(orderId),
  });
  return gigSquareRefundsService;
};

ipcMain.handle('gigSquare:fetchRefunds', async () => {
  try {
    const refunds = await getGigSquareRefundsService().listRefunds();
    return { success: true, refunds };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to fetch refunds' };
  }
});

ipcMain.handle('gigSquare:processRefundOrder', async (_event, params?: { orderId?: string }) => {
  try {
    const orderId = toSafeString(params?.orderId).trim();
    if (!orderId) {
      return { success: false, error: 'orderId is required' };
    }
    const result = await getGigSquareRefundsService().processRefundOrder(orderId);
    return {
      success: true,
      refundTxid: result.refundTxid,
      refundFinalizePinId: result.refundFinalizePinId,
    };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to process refund order' };
  }
});
```

```ts
// src/main/preload.ts
fetchRefunds: () => ipcRenderer.invoke('gigSquare:fetchRefunds'),
processRefundOrder: (params: { orderId: string }) => ipcRenderer.invoke('gigSquare:processRefundOrder', params),
```

```ts
// src/renderer/types/gigSquare.ts
export type GigSquareRefundItem = {
  orderId: string;
  role: 'buyer' | 'seller';
  servicePinId: string | null;
  serviceName: string;
  paymentAmount: string;
  paymentCurrency: string;
  status: 'refund_pending' | 'refunded';
  failureReason: string | null;
  refundRequestPinId: string | null;
  refundTxid: string | null;
  refundRequestedAt: number | null;
  refundCompletedAt: number | null;
  counterpartyGlobalMetaid: string;
  counterpartyName?: string | null;
  counterpartyAvatar?: string | null;
  coworkSessionId: string | null;
  canProcessRefund: boolean;
};

export type GigSquareRefundCollections = {
  pendingForMe: GigSquareRefundItem[];
  initiatedByMe: GigSquareRefundItem[];
  pendingCount: number;
};
```

```ts
// src/renderer/types/electron.d.ts
import type {
  GigSquareRefundCollections,
} from './gigSquare';

interface IElectronAPI {
  gigSquare: {
    fetchRefunds: () => Promise<{
      success: boolean;
      refunds?: GigSquareRefundCollections;
      error?: string;
    }>;
    processRefundOrder: (params: { orderId: string }) => Promise<{
      success: boolean;
      refundTxid?: string;
      refundFinalizePinId?: string;
      error?: string;
    }>;
  };
}
```

- [ ] **Step 4: Re-run compile plus the focused service test**

Run:

```bash
npx rimraf dist-electron && npm run compile:electron && node --test tests/gigSquareRefundsService.test.mjs
```

Expected:

- PASS for the service test suite
- `npm run compile:electron` succeeds with the new preload and renderer types

- [ ] **Step 5: Commit**

```bash
git add src/main/main.ts src/main/preload.ts src/renderer/types/gigSquare.ts src/renderer/types/electron.d.ts tests/gigSquareRefundsService.test.mjs
git commit -m "feat: expose gig square refund ipc"
```

---

### Task 3: Build the Refund Modal UI

**Files:**
- Create: `src/renderer/components/gigSquare/GigSquareRefundsModal.tsx`
- Modify: `src/renderer/services/i18n.ts`
- Test: `tests/gigSquareRefundsModal.test.tsx`

- [ ] **Step 1: Write the failing modal rendering tests**

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import GigSquareRefundsModal from '../src/renderer/components/gigSquare/GigSquareRefundsModal';

const sampleRefunds = {
  pendingCount: 1,
  pendingForMe: [{
    orderId: 'seller-pending',
    role: 'seller',
    servicePinId: 'svc-1',
    serviceName: 'Weather',
    paymentAmount: '1.5',
    paymentCurrency: 'SPACE',
    status: 'refund_pending',
    failureReason: 'delivery_timeout',
    refundRequestPinId: 'refund-pin-1',
    refundTxid: null,
    refundRequestedAt: 1_770_100_000_000,
    refundCompletedAt: null,
    counterpartyGlobalMetaid: 'buyer-global-1',
    counterpartyName: 'Buyer One',
    counterpartyAvatar: 'https://example.com/buyer-1.png',
    coworkSessionId: 'session-recovered',
    canProcessRefund: true,
  }],
  initiatedByMe: [{
    orderId: 'buyer-pending',
    role: 'buyer',
    servicePinId: 'svc-2',
    serviceName: 'Translate',
    paymentAmount: '0.4',
    paymentCurrency: 'DOGE',
    status: 'refund_pending',
    failureReason: 'delivery_timeout',
    refundRequestPinId: 'refund-pin-2',
    refundTxid: null,
    refundRequestedAt: 1_770_120_000_000,
    refundCompletedAt: null,
    counterpartyGlobalMetaid: 'seller-global-1',
    counterpartyName: 'Seller One',
    counterpartyAvatar: 'https://example.com/seller-1.png',
    coworkSessionId: null,
    canProcessRefund: false,
  }],
};

test('refunds modal seller tab renders process action and session action', () => {
  const markup = renderToStaticMarkup(
    <GigSquareRefundsModal
      isOpen
      refunds={sampleRefunds}
      activeTab="pendingForMe"
      onTabChange={() => {}}
      onClose={() => {}}
      onRetry={() => {}}
      onProcessRefund={async () => {}}
    />,
  );

  assert.match(markup, /服务退款/);
  assert.match(markup, /我需处理的退款/);
  assert.match(markup, /Buyer One/);
  assert.match(markup, /buyer-global-1/);
  assert.match(markup, /Weather/);
  assert.match(markup, /1\.5/);
  assert.match(markup, /处理退款/);
  assert.match(markup, /查看会话/);
});

test('refunds modal buyer tab hides process action and still renders buyer-side fields', () => {
  const markup = renderToStaticMarkup(
    <GigSquareRefundsModal
      isOpen
      refunds={sampleRefunds}
      activeTab="initiatedByMe"
      onTabChange={() => {}}
      onClose={() => {}}
      onRetry={() => {}}
      onProcessRefund={async () => {}}
    />,
  );

  assert.match(markup, /我发起的退款/);
  assert.match(markup, /Seller One/);
  assert.doesNotMatch(markup, /处理退款/);
});

test('refunds modal renders date, failure reason, and tab-specific empty copy', () => {
  const filledMarkup = renderToStaticMarkup(
    <GigSquareRefundsModal
      isOpen
      refunds={sampleRefunds}
      activeTab="pendingForMe"
      onTabChange={() => {}}
      onClose={() => {}}
      onRetry={() => {}}
      onProcessRefund={async () => {}}
    />,
  );

  assert.match(filledMarkup, /delivery_timeout|first_response_timeout/);
  assert.match(filledMarkup, /1\.5/);
  assert.match(filledMarkup, /2026|2025|\/|-/);

  const emptyMarkup = renderToStaticMarkup(
    <GigSquareRefundsModal
      isOpen
      refunds={{ pendingCount: 0, pendingForMe: [], initiatedByMe: [] }}
      activeTab="initiatedByMe"
      onTabChange={() => {}}
      onClose={() => {}}
      onRetry={() => {}}
      onProcessRefund={async () => {}}
    />,
  );

  assert.match(emptyMarkup, /暂无你发起的退款|No refunds initiated yet/);
});
```

- [ ] **Step 2: Run the renderer test to verify it fails**

Run:

```bash
npx tsx --test tests/gigSquareRefundsModal.test.tsx
```

Expected:

- FAIL because `GigSquareRefundsModal.tsx` does not exist yet
- or FAIL because the expected tab labels and buttons are not rendered

- [ ] **Step 3: Implement the modal with controlled tab support, states, and row actions**

```tsx
// src/renderer/components/gigSquare/GigSquareRefundsModal.tsx
type RefundTab = 'pendingForMe' | 'initiatedByMe';

interface GigSquareRefundsModalProps {
  isOpen: boolean;
  refunds: GigSquareRefundCollections | null;
  activeTab?: RefundTab;
  onTabChange?: (tab: RefundTab) => void;
  isLoading?: boolean;
  loadError?: string | null;
  processingOrderId?: string | null;
  onRetry: () => void;
  onClose: () => void;
  onProcessRefund: (orderId: string) => Promise<void> | void;
}

const GigSquareRefundsModal: React.FC<GigSquareRefundsModalProps> = ({
  isOpen,
  refunds,
  activeTab,
  onTabChange,
  isLoading = false,
  loadError = null,
  processingOrderId = null,
  onRetry,
  onClose,
  onProcessRefund,
}) => {
  const formatRefundDate = (value: number | null | undefined) => {
    if (!value) return '—';
    return new Date(value).toLocaleString();
  };

  const [internalTab, setInternalTab] = useState<RefundTab>('pendingForMe');
  const resolvedTab = activeTab ?? internalTab;
  const items = resolvedTab === 'pendingForMe'
    ? refunds?.pendingForMe ?? []
    : refunds?.initiatedByMe ?? [];

  const setTab = (tab: RefundTab) => {
    if (activeTab == null) setInternalTab(tab);
    onTabChange?.(tab);
  };

  const handleViewSession = (sessionId: string | null) => {
    if (!sessionId) return;
    window.dispatchEvent(new CustomEvent('cowork:viewSession', { detail: { sessionId } }));
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div>
      <h2>{i18nService.t('gigSquareRefundsTitle')}</h2>
      <button type="button" onClick={() => setTab('pendingForMe')}>{i18nService.t('gigSquareRefundsTabPending')}</button>
      <button type="button" onClick={() => setTab('initiatedByMe')}>{i18nService.t('gigSquareRefundsTabInitiated')}</button>
      {isLoading && <div>{i18nService.t('gigSquareRefundsLoading')}</div>}
      {loadError && <button type="button" onClick={onRetry}>{loadError}</button>}
      {!isLoading && !loadError && items.length === 0 && (
        <div>
          {resolvedTab === 'pendingForMe'
            ? i18nService.t('gigSquareRefundsEmptyPending')
            : i18nService.t('gigSquareRefundsEmptyInitiated')}
        </div>
      )}
      {!isLoading && !loadError && items.map((item) => (
        <div key={item.orderId}>
          <div>{item.counterpartyName || item.counterpartyGlobalMetaid}</div>
          <div>{item.counterpartyGlobalMetaid}</div>
          <div>{item.serviceName}</div>
          <div>{item.paymentAmount} {item.paymentCurrency}</div>
          <div>{formatRefundDate(item.status === 'refunded' ? item.refundCompletedAt : item.refundRequestedAt)}</div>
          <div>{item.status === 'refund_pending' ? i18nService.t('gigSquareRefundsStatusPending') : i18nService.t('gigSquareRefundsStatusRefunded')}</div>
          {item.failureReason && <div>{item.failureReason}</div>}
          {item.coworkSessionId && (
            <button type="button" onClick={() => handleViewSession(item.coworkSessionId)}>
              {i18nService.t('gigSquareRefundsViewSession')}
            </button>
          )}
          {item.canProcessRefund && (
            <button
              type="button"
              onClick={() => void onProcessRefund(item.orderId)}
              disabled={processingOrderId === item.orderId}
            >
              {processingOrderId === item.orderId
                ? i18nService.t('gigSquareRefundsProcessing')
                : i18nService.t('gigSquareRefundsProcess')}
            </button>
          )}
        </div>
      ))}
    </div>
  );
};
```

```ts
// src/renderer/services/i18n.ts
// zh block
gigSquareRefundsButton: '服务退款',
gigSquareRefundsTitle: '服务退款',
gigSquareRefundsSubtitle: '集中查看待处理退款与我发起的退款',
gigSquareRefundsTabPending: '我需处理的退款',
gigSquareRefundsTabInitiated: '我发起的退款',
gigSquareRefundsLoading: '正在加载退款列表...',
gigSquareRefundsLoadFailed: '退款列表加载失败',
gigSquareRefundsStatusPending: '待处理',
gigSquareRefundsStatusRefunded: '已退款',
gigSquareRefundsProcess: '处理退款',
gigSquareRefundsProcessing: '处理中...',
gigSquareRefundsProcessFailed: '退款处理失败',
gigSquareRefundsProcessSuccess: '退款处理完成',
gigSquareRefundsViewSession: '查看会话',
gigSquareRefundsEmptyPending: '暂无需要你处理的退款',
gigSquareRefundsEmptyInitiated: '暂无你发起的退款',

// en block
gigSquareRefundsButton: 'Service refunds',
gigSquareRefundsTitle: 'Service refunds',
gigSquareRefundsSubtitle: 'Track refund work items and refunds you initiated',
gigSquareRefundsTabPending: 'Refunds for me',
gigSquareRefundsTabInitiated: 'Refunds I initiated',
gigSquareRefundsLoading: 'Loading refunds...',
gigSquareRefundsLoadFailed: 'Failed to load refunds',
gigSquareRefundsStatusPending: 'Pending',
gigSquareRefundsStatusRefunded: 'Refunded',
gigSquareRefundsProcess: 'Process refund',
gigSquareRefundsProcessing: 'Processing...',
gigSquareRefundsProcessFailed: 'Failed to process refund',
gigSquareRefundsProcessSuccess: 'Refund completed',
gigSquareRefundsViewSession: 'View session',
gigSquareRefundsEmptyPending: 'No refunds need your action',
gigSquareRefundsEmptyInitiated: 'No refunds initiated yet',
```

- [ ] **Step 4: Re-run the renderer modal test and make it pass**

Run:

```bash
npx tsx --test tests/gigSquareRefundsModal.test.tsx
```

Expected:

- PASS for `refunds modal seller tab renders process action and session action`
- PASS for `refunds modal buyer tab hides process action and still renders buyer-side fields`
- PASS for `refunds modal renders date, failure reason, and tab-specific empty copy`

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/gigSquare/GigSquareRefundsModal.tsx src/renderer/services/i18n.ts tests/gigSquareRefundsModal.test.tsx
git commit -m "feat: add refund hub modal"
```

---

### Task 4: Integrate the Bot Hub Header Button and Refund Refresh Flow

**Files:**
- Create: `src/renderer/components/gigSquare/GigSquareHeaderActions.tsx`
- Modify: `src/renderer/components/gigSquare/GigSquareView.tsx`
- Modify: `src/renderer/services/i18n.ts`
- Test: `tests/gigSquareHeaderActions.test.tsx`
- Test: `tests/gigSquareRefundsModal.test.tsx`

- [ ] **Step 1: Write the failing header-actions test and extend the modal test for processing state**

```tsx
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import GigSquareHeaderActions from '../src/renderer/components/gigSquare/GigSquareHeaderActions';

test('header actions render the service refunds button with a pending badge', () => {
  const markup = renderToStaticMarkup(
    <GigSquareHeaderActions
      pendingRefundCount={3}
      onOpenMyServices={() => {}}
      onOpenRefunds={() => {}}
      onOpenPublish={() => {}}
    />,
  );

  assert.match(markup, /我的服务/);
  assert.match(markup, /服务退款/);
  assert.match(markup, />3<\/span>/);
  assert.match(markup, /发布技能服务/);
});
```

```tsx
test('refunds modal shows processing label for the active seller row', () => {
  const markup = renderToStaticMarkup(
    <GigSquareRefundsModal
      isOpen
      refunds={sampleRefunds}
      activeTab="pendingForMe"
      processingOrderId="seller-pending"
      onTabChange={() => {}}
      onClose={() => {}}
      onRetry={() => {}}
      onProcessRefund={async () => {}}
    />,
  );

  assert.match(markup, /处理中\.\.\./);
});
```

- [ ] **Step 2: Run the renderer tests to verify they fail**

Run:

```bash
npx tsx --test tests/gigSquareRefundsModal.test.tsx tests/gigSquareHeaderActions.test.tsx
```

Expected:

- FAIL because `GigSquareHeaderActions.tsx` does not exist yet
- or FAIL because the header badge and processing label are not wired

- [ ] **Step 3: Implement header actions plus `GigSquareView` state loading and refresh wiring**

```tsx
// src/renderer/components/gigSquare/GigSquareHeaderActions.tsx
interface GigSquareHeaderActionsProps {
  pendingRefundCount: number;
  onOpenMyServices: () => void;
  onOpenRefunds: () => void;
  onOpenPublish: () => void;
}

const GigSquareHeaderActions: React.FC<GigSquareHeaderActionsProps> = ({
  pendingRefundCount,
  onOpenMyServices,
  onOpenRefunds,
  onOpenPublish,
}) => (
  <div className="flex items-center gap-2.5">
    <button type="button" onClick={onOpenMyServices} className="btn-idchat-primary whitespace-nowrap px-3 py-1.5 text-xs font-medium">
      {i18nService.t('gigSquareMyServicesButton')}
    </button>
    <button type="button" onClick={onOpenRefunds} className="btn-idchat-primary relative whitespace-nowrap px-3 py-1.5 text-xs font-medium">
      {i18nService.t('gigSquareRefundsButton')}
      {pendingRefundCount > 0 && (
        <span className="ml-2 inline-flex min-w-5 items-center justify-center rounded-full bg-orange-500 px-1.5 py-0.5 text-[10px] font-semibold text-white">
          {pendingRefundCount}
        </span>
      )}
    </button>
    <button type="button" onClick={onOpenPublish} className="btn-idchat-primary whitespace-nowrap px-3 py-1.5 text-xs font-medium">
      {i18nService.t('gigSquarePublishButton')}
    </button>
  </div>
);
```

```tsx
// src/renderer/components/gigSquare/GigSquareView.tsx
const [refunds, setRefunds] = useState<GigSquareRefundCollections | null>(null);
const [refundsLoading, setRefundsLoading] = useState(false);
const [refundsError, setRefundsError] = useState<string | null>(null);
const [isRefundsModalOpen, setIsRefundsModalOpen] = useState(false);
const [processingRefundOrderId, setProcessingRefundOrderId] = useState<string | null>(null);

const loadRefunds = useCallback(async () => {
  setRefundsLoading(true);
  setRefundsError(null);
  try {
    const result = await window.electron.gigSquare.fetchRefunds();
    if (result?.success && result.refunds) {
      setRefunds(result.refunds);
    } else {
      setRefundsError(result?.error || i18nService.t('gigSquareRefundsLoadFailed'));
    }
  } catch (error) {
    setRefundsError(error instanceof Error ? error.message : i18nService.t('gigSquareRefundsLoadFailed'));
  } finally {
    setRefundsLoading(false);
  }
}, []);

useEffect(() => {
  void loadRefunds();
}, [loadRefunds]);

const handleOpenRefunds = useCallback(() => {
  setIsRefundsModalOpen(true);
  void loadRefunds();
}, [loadRefunds]);

const handleProcessRefund = useCallback(async (orderId: string) => {
  if (!orderId || processingRefundOrderId) return;
  setProcessingRefundOrderId(orderId);
  try {
    const result = await window.electron.gigSquare.processRefundOrder({ orderId });
    if (!result?.success) {
      throw new Error(result?.error || i18nService.t('gigSquareRefundsProcessFailed'));
    }
    showToastMessage(i18nService.t('gigSquareRefundsProcessSuccess'));
    await loadRefunds();
  } catch (error) {
    showToastMessage(error instanceof Error ? error.message : i18nService.t('gigSquareRefundsProcessFailed'));
  } finally {
    setProcessingRefundOrderId(null);
  }
}, [loadRefunds, processingRefundOrderId]);
```

```tsx
// src/renderer/components/gigSquare/GigSquareView.tsx
<GigSquareHeaderActions
  pendingRefundCount={refunds?.pendingCount ?? 0}
  onOpenMyServices={() => setIsMyServicesModalOpen(true)}
  onOpenRefunds={handleOpenRefunds}
  onOpenPublish={() => setIsPublishModalOpen(true)}
/>

<button
  type="button"
  onClick={() => void handleRefresh()}
  className="inline-flex items-center justify-center rounded-lg border border-claude-border p-2 text-claude-textSecondary transition hover:bg-claude-surfaceHover dark:border-claude-darkBorder dark:text-claude-darkTextSecondary dark:hover:bg-claude-darkSurfaceHover"
  title={i18nService.t('refresh')}
  aria-label={i18nService.t('refresh')}
>
  <ArrowPathIcon className="h-4 w-4" />
</button>

<GigSquareRefundsModal
  isOpen={isRefundsModalOpen}
  refunds={refunds}
  isLoading={refundsLoading}
  loadError={refundsError}
  processingOrderId={processingRefundOrderId}
  onRetry={() => void loadRefunds()}
  onClose={() => setIsRefundsModalOpen(false)}
  onProcessRefund={handleProcessRefund}
/>
```

```ts
// src/renderer/services/i18n.ts
// zh block
gigSquareRefundsButton: '服务退款',
gigSquareRefundsLoadFailed: '退款列表加载失败',
gigSquareRefundsProcessFailed: '退款处理失败',
gigSquareRefundsProcessSuccess: '退款处理完成',

// en block
gigSquareRefundsButton: 'Service refunds',
gigSquareRefundsLoadFailed: 'Failed to load refunds',
gigSquareRefundsProcessFailed: 'Failed to process refund',
gigSquareRefundsProcessSuccess: 'Refund completed',
```

- [ ] **Step 4: Re-run the renderer tests, then run lint and a manual app smoke**

Run:

```bash
npx tsx --test tests/gigSquareRefundsModal.test.tsx tests/gigSquareHeaderActions.test.tsx
npm run lint
npm run electron:dev
```

Expected:

- Both renderer tests PASS
- `npm run lint` exits cleanly
- In `electron:dev`, Bot Hub still keeps the existing manual refresh button, shows `服务退款` beside `我的服务`, re-fetches refunds on modal-open, and processing a seller pending row refreshes the badge and row state without changing A2A behavior

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/gigSquare/GigSquareHeaderActions.tsx src/renderer/components/gigSquare/GigSquareView.tsx src/renderer/services/i18n.ts tests/gigSquareHeaderActions.test.tsx tests/gigSquareRefundsModal.test.tsx
git commit -m "feat: add bot hub refund entry"
```

---

### Task 5: Add Regression Coverage for the Existing A2A Refund Flow

**Files:**
- Create: `tests/coworkServiceOrderPresentation.test.mjs`
- Test: `tests/serviceRefundSettlementService.test.mjs`

- [ ] **Step 1: Write the failing A2A presentation regression tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getRefundCardVariant,
  shouldShowRefundStatusCard,
} from '../src/renderer/components/cowork/coworkServiceOrderPresentation.js';

test('seller refund_pending summaries still render the seller action variant', () => {
  const summary = {
    role: 'seller',
    status: 'refund_pending',
    failureReason: 'delivery_timeout',
    refundRequestPinId: 'refund-pin-1',
    refundTxid: null,
  };

  assert.equal(shouldShowRefundStatusCard(summary), true);
  assert.equal(getRefundCardVariant(summary), 'seller-action');
});

test('buyer refund_pending and refunded summaries keep their legacy variants', () => {
  assert.equal(getRefundCardVariant({ role: 'buyer', status: 'refund_pending' }), 'buyer-pending');
  assert.equal(getRefundCardVariant({ role: 'buyer', status: 'refunded' }), 'refunded');
  assert.equal(getRefundCardVariant({ role: 'seller', status: 'refunded' }), 'refunded');
});
```

- [ ] **Step 2: Run the legacy-flow regression tests to verify the new test file is missing**

Run:

```bash
node --test tests/coworkServiceOrderPresentation.test.mjs
```

Expected:

- FAIL because `tests/coworkServiceOrderPresentation.test.mjs` does not exist yet

- [ ] **Step 3: Add the regression test file without changing existing A2A refund behavior**

```js
// tests/coworkServiceOrderPresentation.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getRefundCardVariant,
  shouldShowRefundStatusCard,
} from '../src/renderer/components/cowork/coworkServiceOrderPresentation.js';

test('seller refund_pending summaries still render the seller action variant', () => {
  const summary = {
    role: 'seller',
    status: 'refund_pending',
    failureReason: 'delivery_timeout',
    refundRequestPinId: 'refund-pin-1',
    refundTxid: null,
  };

  assert.equal(shouldShowRefundStatusCard(summary), true);
  assert.equal(getRefundCardVariant(summary), 'seller-action');
});

test('buyer refund_pending and refunded summaries keep their legacy variants', () => {
  assert.equal(getRefundCardVariant({ role: 'buyer', status: 'refund_pending' }), 'buyer-pending');
  assert.equal(getRefundCardVariant({ role: 'buyer', status: 'refunded' }), 'refunded');
  assert.equal(getRefundCardVariant({ role: 'seller', status: 'refunded' }), 'refunded');
});
```

- [ ] **Step 4: Re-run the A2A regression suite**

Run:

```bash
node --test tests/coworkServiceOrderPresentation.test.mjs tests/serviceRefundSettlementService.test.mjs
```

Expected:

- PASS for the new A2A refund-card regression tests
- PASS for the existing seller refund settlement tests, confirming the legacy business path still behaves as before

- [ ] **Step 5: Commit**

```bash
git add tests/coworkServiceOrderPresentation.test.mjs
git commit -m "test: guard legacy a2a refund flow"
```

---

## Self-Review

### Spec coverage

- Top-bar `服务退款` button beside `我的服务`: covered by Task 4
- Two refund tabs with seller vs buyer roles: covered by Task 3
- Seller rows show `处理退款`, buyer rows do not: covered by Tasks 1 and 3
- Order-based processing instead of session-only processing: covered by Tasks 1 and 2
- A2A flow remains unchanged because refund execution still reuses `processSellerRefundForOrderId(...)`: covered by Tasks 1 and 2
- `查看会话` remains optional and session resolution is fallback-only: covered by Task 1 and rendered in Task 3
- Pending badge refresh after seller processing and modal-open refresh: covered by Task 4
- Legacy A2A refund-card semantics stay protected by automated tests: covered by Task 5

No uncovered spec requirement remains.

### Placeholder scan

- Searched for `TODO`, `TBD`, `implement later`, `fill in details`, and similar placeholders: none remain
- Every task includes explicit file paths, code snippets, and commands

### Type consistency

- The plan uses one canonical renderer payload shape: `GigSquareRefundItem` / `GigSquareRefundCollections`
- The new IPC names are consistent everywhere: `fetchRefunds` and `processRefundOrder`
- The tab keys are consistent everywhere: `pendingForMe` and `initiatedByMe`
