import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createNativeSqliteDatabase } from '../src/main/nativeSqliteDatabase';
import {
  SwapOrderTrackerService,
  ensureNftSwapClientOrderSchema,
  type NftSwapOrderCompletedEvent,
} from '../src/main/services/swapOrderTrackerService';
import {
  formatSwapWireMessage,
  parseSwapWireMessage,
} from '../src/main/services/swapWireProtocol';

function disposeDb(db: { close: () => void }, dir: string): void {
  try {
    db.close();
  } catch {
    // already closed
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows CI tolerant temp cleanup
  }
}

const STATION_GMID = 'idq1officialswapstation000000000000000000';
const TARGET_PIN = `${'cc'.repeat(32)}i0`;
const ITEM_PIN_1 = `${'11'.repeat(32)}i0`;
const ITEM_PIN_2 = `${'22'.repeat(32)}i0`;
const RECIPIENT_ADDR = '1TwinRecipientAddress11111111111111111';

test('swapWireProtocol round-trips SWAP_CLAIM_V1, SWAP_STATUS_V1, and SWAP_COMPLETED_V1', () => {
  const claim = formatSwapWireMessage({
    type: 'SWAP_CLAIM_V1',
    requestId: 'req-1',
    collectionSlug: 'metabot-avatar',
    codehash: 'e205939ad9956673ce7da9fbd40514b30f66dc35',
    genesis: '005d69cba8c80e6978157e146f998c21288a9d49',
    recipientAddress: RECIPIENT_ADDR,
    recipientGlobalMetaId: 'idq1twinuser00000000000000000000000000000',
    items: [{ tokenIndex: '101', depositTxId: 'aa'.repeat(32) }],
  });
  const parsedClaim = parseSwapWireMessage(claim);
  assert.equal(parsedClaim?.type, 'SWAP_CLAIM_V1');
  if (parsedClaim?.type === 'SWAP_CLAIM_V1') {
    assert.equal(parsedClaim.requestId, 'req-1');
    assert.equal(parsedClaim.items[0].tokenIndex, '101');
  }

  const statusMsg = formatSwapWireMessage({
    type: 'SWAP_STATUS_V1',
    requestId: 'req-1',
    collectionSlug: 'metabot-avatar',
    status: 'pending_1_conf',
    note: 'Waiting 1 block confirmation',
  });
  const parsedStatus = parseSwapWireMessage(statusMsg);
  assert.equal(parsedStatus?.type, 'SWAP_STATUS_V1');

  const completedMsg = formatSwapWireMessage({
    type: 'SWAP_COMPLETED_V1',
    requestId: 'req-1',
    collectionSlug: 'metabot-avatar',
    collectionPinId: TARGET_PIN,
    results: [
      {
        tokenIndex: '101',
        status: 'completed',
        itemPinId: ITEM_PIN_1,
        deliveryTxId: 'bb'.repeat(32),
        itemName: 'MetaBot Avatar #101',
      },
    ],
  });
  const parsedCompleted = parseSwapWireMessage(completedMsg);
  assert.equal(parsedCompleted?.type, 'SWAP_COMPLETED_V1');

  // Contract C5.1 wire status "sent" parses cleanly; unknown status is ignored
  const sentWireMsg = formatSwapWireMessage({
    type: 'SWAP_COMPLETED_V1',
    requestId: 'req-sent',
    collectionSlug: 'metabot-avatar',
    collectionPinId: TARGET_PIN,
    results: [
      {
        tokenIndex: '0',
        status: 'sent' as unknown as 'completed',
        itemPinId: ITEM_PIN_1,
        cover: 'metafile://cover0',
      },
      {
        tokenIndex: '1',
        status: 'bogus_status' as unknown as 'completed',
        itemPinId: ITEM_PIN_2,
      },
    ],
  });
  const parsedSent = parseSwapWireMessage(sentWireMsg);
  assert.equal(parsedSent?.type, 'SWAP_COMPLETED_V1');
  if (parsedSent?.type === 'SWAP_COMPLETED_V1') {
    assert.equal(parsedSent.results.length, 1);
    assert.equal(parsedSent.results[0].tokenIndex, '0');
    assert.equal(parsedSent.results[0].status, 'completed');
    assert.equal(parsedSent.results[0].cover, 'metafile://cover0');
  }
});

test('SwapOrderTrackerService schema migration is idempotent across restarts and cleans up handles safely', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swap-order-tracker-schema-'));
  const dbPath = path.join(dir, 'tracker.sqlite');
  let db = createNativeSqliteDatabase(dbPath);
  try {
    ensureNftSwapClientOrderSchema(db);
    // Re-running schema ensure must be completely idempotent
    ensureNftSwapClientOrderSchema(db);

    const tracker = new SwapOrderTrackerService(db, () => {});
    tracker.registerOrder({
      requestId: 'req-persist-1',
      metabotId: 7,
      stationGlobalMetaId: STATION_GMID,
      collectionSlug: 'metabot-avatar',
      targetCollectionPinId: TARGET_PIN,
      recipientAddress: RECIPIENT_ADDR,
      items: [{ tokenIndex: '88', depositTxId: 'aa'.repeat(32) }],
    });
    db.close();

    // Re-open persisted file and re-run migration
    db = createNativeSqliteDatabase(dbPath);
    const tracker2 = new SwapOrderTrackerService(db, () => {});
    const loaded = tracker2.getOrder('req-persist-1');
    assert.ok(loaded);
    assert.equal(loaded.status, 'submitted');
    assert.equal(loaded.items[0].tokenIndex, '88');
  } finally {
    disposeDb(db, dir);
  }
});

test('SwapOrderTrackerService processes SWAP_COMPLETED_V1 A2A receipt once and emits nftSwap:orderCompleted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swap-order-tracker-a2a-'));
  const db = createNativeSqliteDatabase(path.join(dir, 'tracker.sqlite'));
  const emitted: Array<{ channel: string; payload: unknown }> = [];
  const callbacks: NftSwapOrderCompletedEvent[] = [];

  try {
    const tracker = new SwapOrderTrackerService(db, () => {}, {
      emitToRenderer: (channel, payload) => emitted.push({ channel, payload }),
      onOrderCompleted: (ev) => {
        callbacks.push(ev);
      },
    });

    tracker.registerOrder({
      requestId: 'req-a2a-1',
      metabotId: 1,
      stationGlobalMetaId: STATION_GMID,
      collectionSlug: 'metabot-avatar',
      targetCollectionPinId: TARGET_PIN,
      sessionId: 'sess-123',
      recipientAddress: RECIPIENT_ADDR,
      items: [
        { tokenIndex: '101', depositTxId: 'aa'.repeat(32) },
        { tokenIndex: '102', depositTxId: 'bb'.repeat(32) },
      ],
    });

    // Reject spoofed receipt from non-station sender
    const spoofed = await tracker.handleIncomingSwapMessage({
      metabotId: 1,
      fromGlobalMetaId: 'idq1imposter000000000000000000000000000',
      plaintext: formatSwapWireMessage({
        type: 'SWAP_COMPLETED_V1',
        requestId: 'req-a2a-1',
        collectionSlug: 'metabot-avatar',
        collectionPinId: TARGET_PIN,
        results: [{ tokenIndex: '101', status: 'completed', itemPinId: ITEM_PIN_1 }],
      }),
    });
    assert.equal(spoofed.handled, true);
    assert.equal(spoofed.matched, false);
    assert.equal(emitted.length, 0);

    // Authentic station receipt
    const ok = await tracker.handleIncomingSwapMessage({
      metabotId: 1,
      fromGlobalMetaId: STATION_GMID,
      plaintext: formatSwapWireMessage({
        type: 'SWAP_COMPLETED_V1',
        requestId: 'req-a2a-1',
        collectionSlug: 'metabot-avatar',
        collectionPinId: TARGET_PIN,
        results: [
          { tokenIndex: '101', status: 'completed', itemPinId: ITEM_PIN_1, itemName: 'MetaBot Avatar #101' },
          { tokenIndex: '102', status: 'completed', itemPinId: ITEM_PIN_2, itemName: 'MetaBot Avatar #102' },
        ],
      }),
    });
    assert.equal(ok.handled, true);
    assert.equal(ok.matched, true);
    assert.equal(ok.notified, true);
    assert.equal(tracker.getOrder('req-a2a-1')?.status, 'completed');
    assert.equal(emitted.length, 1);
    assert.equal(emitted[0].channel, 'nftSwap:orderCompleted');
    assert.equal(callbacks.length, 1);
    assert.equal(callbacks[0].results.length, 2);

    // Duplicate delivery must not emit duplicate notification
    const dup = await tracker.handleIncomingSwapMessage({
      metabotId: 1,
      fromGlobalMetaId: STATION_GMID,
      plaintext: formatSwapWireMessage({
        type: 'SWAP_COMPLETED_V1',
        requestId: 'req-a2a-1',
        collectionSlug: 'metabot-avatar',
        collectionPinId: TARGET_PIN,
        results: [
          { tokenIndex: '101', status: 'completed', itemPinId: ITEM_PIN_1 },
          { tokenIndex: '102', status: 'completed', itemPinId: ITEM_PIN_2 },
        ],
      }),
    });
    assert.equal(dup.notified, false);
    assert.equal(emitted.length, 1);
  } finally {
    disposeDb(db, dir);
  }
});

test('SwapOrderTrackerService MetaSo polling fallback detects creatorMinted arrival and deduplicates', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swap-order-tracker-poll-'));
  const db = createNativeSqliteDatabase(path.join(dir, 'tracker.sqlite'));
  const emitted: unknown[] = [];

  try {
    const tracker = new SwapOrderTrackerService(db, () => {}, {
      emitToRenderer: (channel, payload) => {
        if (channel === 'nftSwap:orderCompleted') emitted.push(payload);
      },
      fetchAddressCollectionItems: async () => [
        {
          itemPinId: ITEM_PIN_1,
          collectionPinId: TARGET_PIN,
          name: 'MetaBot Avatar #404',
          creatorMinted: false, // require verifyItem fallback to prove creatorMinted
          cover: 'metafile://cover1',
          genesisTx: 'dd'.repeat(32),
        },
      ],
      verifyItem: async (pinId) => ({
        collected: true,
        collectionPinId: TARGET_PIN,
        creatorMinted: pinId === ITEM_PIN_1,
      }),
    });

    tracker.registerOrder({
      requestId: 'req-poll-1',
      metabotId: 3,
      stationGlobalMetaId: STATION_GMID,
      collectionSlug: 'metabot-avatar',
      targetCollectionPinId: TARGET_PIN,
      recipientAddress: RECIPIENT_ADDR,
      items: [{ tokenIndex: '404', depositTxId: 'cc'.repeat(32) }],
    });

    const firstPass = await tracker.pollPendingOrdersOnce();
    assert.equal(firstPass.checked, 1);
    assert.equal(firstPass.notified, 1);
    assert.equal(emitted.length, 1);
    assert.equal(tracker.getOrder('req-poll-1')?.status, 'completed');

    // Second pass: no pending orders left, no duplicate emit
    const secondPass = await tracker.pollPendingOrdersOnce();
    assert.equal(secondPass.checked, 0);
    assert.equal(secondPass.notified, 0);
    assert.equal(emitted.length, 1);
  } finally {
    disposeDb(db, dir);
  }
});

test('SwapOrderTrackerService default MetaSo fetcher paginates cursor across >100 items', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'swap-order-tracker-paginate-'));
  const db = createNativeSqliteDatabase(path.join(dir, 'tracker.sqlite'));
  const emitted: unknown[] = [];

  const prevFetch = globalThis.fetch;
  let pageRequests = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.includes('/api/mrc721/address/item')) {
      pageRequests += 1;
      const u = new URL(url);
      const cursor = u.searchParams.get('cursor');
      if (!cursor) {
        return new Response(
          JSON.stringify({
            code: 1,
            data: {
              list: [
                {
                  itemPinId: ITEM_PIN_1,
                  collectionPinId: TARGET_PIN,
                  name: 'MetaBot Avatar #1',
                  creatorMinted: true,
                },
              ],
              cursor: 'page2',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          code: 1,
          data: {
            list: [
              {
                itemPinId: ITEM_PIN_2,
                collectionPinId: TARGET_PIN,
                name: 'MetaBot Avatar #0',
                creatorMinted: true,
                cover: 'metafile://cover0',
              },
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  };

  try {
    const tracker = new SwapOrderTrackerService(db, () => {}, {
      emitToRenderer: (channel, payload) => {
        if (channel === 'nftSwap:orderCompleted') emitted.push(payload);
      },
    });

    tracker.registerOrder({
      requestId: 'req-page-1',
      metabotId: 5,
      stationGlobalMetaId: STATION_GMID,
      collectionSlug: 'metabot-avatar',
      targetCollectionPinId: TARGET_PIN,
      recipientAddress: RECIPIENT_ADDR,
      items: [{ tokenIndex: '0', depositTxId: 'ee'.repeat(32) }],
    });

    const pass = await tracker.pollPendingOrdersOnce();
    assert.equal(pass.checked, 1);
    assert.equal(pass.notified, 1);
    assert.equal(pageRequests, 2);
    assert.equal(tracker.getOrder('req-page-1')?.status, 'completed');
    assert.equal(emitted.length, 1);
  } finally {
    globalThis.fetch = prevFetch;
    disposeDb(db, dir);
  }
});
