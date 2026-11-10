import test from 'node:test';
import assert from 'node:assert/strict';

import {
  elementSelectionsStore,
  ElementSelectionsStore,
} from '../src/renderer/features/botBrowser/elementSelectionsStore';
import type { BrowserElementSelectionsSnapshot } from '@openagentinternet/agent-browser-host-contract';

const snapshotOf = (
  overrides: Partial<BrowserElementSelectionsSnapshot> = {},
): BrowserElementSelectionsSnapshot => ({
  tabId: 3,
  uri: 'metaapp://abc',
  title: 'Chess App',
  selections: [{ markerId: 'marker-1', comment: 'Make the label uppercase' } as never],
  ...overrides,
});

const FRESH = 1_000_000;
const OLD = FRESH + 16 * 60 * 1000;

test('recordSnapshot keeps the latest per tab and the last non-empty for rescue', () => {
  const store = new ElementSelectionsStore();
  store.recordSnapshot(snapshotOf({ selections: [{ markerId: 'a' } as never] }), FRESH);
  // Navigation cleared the markers: latest is empty, the non-empty capture survives.
  store.recordSnapshot(snapshotOf({ selections: [] }), FRESH + 1000);

  const capture = store.captureForTurn(FRESH + 2000);
  return capture.then((result) => {
    assert.ok(result);
    assert.equal(result.stale, true);
    assert.equal(result.snapshot.selections[0].markerId, 'a');
  });
});

test('captureForTurn prefers a fresh live read with marks', async () => {
  const store = new ElementSelectionsStore();
  store.recordSnapshot(snapshotOf({ selections: [{ markerId: 'old' } as never] }), FRESH);
  const unregister = store.registerFetcher(async () => snapshotOf({ selections: [{ markerId: 'live' } as never] }));

  const result = await store.captureForTurn(FRESH + 2000);
  unregister();
  assert.ok(result);
  assert.equal(result.stale, false);
  assert.equal(result.snapshot.selections[0].markerId, 'live');
});

test('captureForTurn falls back to the tab-scoped cache when the live read is empty', async () => {
  const store = new ElementSelectionsStore();
  store.recordSnapshot(snapshotOf({ selections: [{ markerId: 'kept' } as never] }), FRESH);
  const unregister = store.registerFetcher(async () => snapshotOf({ selections: [] }));

  const result = await store.captureForTurn(FRESH + 2000);
  unregister();
  assert.ok(result);
  assert.equal(result.stale, true);
  assert.equal(result.snapshot.selections[0].markerId, 'kept');
});

test('captureForTurn uses the last non-empty tab when the live fetch fails', async () => {
  const store = new ElementSelectionsStore();
  store.recordSnapshot(snapshotOf({ tabId: 9, selections: [{ markerId: 'rescued' } as never] }), FRESH);
  const unregister = store.registerFetcher(async () => {
    throw new Error('frame gone');
  });

  const result = await store.captureForTurn(FRESH + 2000);
  unregister();
  assert.ok(result);
  assert.equal(result.snapshot.tabId, 9);
  assert.equal(result.snapshot.selections[0].markerId, 'rescued');
});

test('stale cache entries past the age window are dropped', async () => {
  const store = new ElementSelectionsStore();
  store.recordSnapshot(snapshotOf({ selections: [{ markerId: 'ancient' } as never] }), FRESH);
  const result = await store.captureForTurn(OLD);
  assert.equal(result, null);
});

test('captureForTurn returns null when nothing was ever marked', async () => {
  const store = new ElementSelectionsStore();
  assert.equal(await store.captureForTurn(FRESH), null);
});

test('capturePromptBlock renders the block only when marks exist', async () => {
  const store = new ElementSelectionsStore();
  assert.equal(await store.capturePromptBlock(FRESH), '');
  store.recordSnapshot(snapshotOf({ selections: [{ markerId: 'a' } as never] }), FRESH);
  const block = await store.capturePromptBlock(FRESH + 1000);
  assert.match(block, /> Marked elements on "Chess App"/);
});

test('registerFetcher unregisters exactly its own closure', async () => {
  const store = new ElementSelectionsStore();
  const unregister = store.registerFetcher(async () => snapshotOf());
  unregister();
  unregister(); // idempotent
  assert.equal(await store.captureForTurn(FRESH), null);
});

test('the shared singleton exposes the same API surface', () => {
  assert.equal(typeof elementSelectionsStore.recordSnapshot, 'function');
  assert.equal(typeof elementSelectionsStore.registerFetcher, 'function');
  assert.equal(typeof elementSelectionsStore.captureForTurn, 'function');
  assert.equal(typeof elementSelectionsStore.capturePromptBlock, 'function');
});
