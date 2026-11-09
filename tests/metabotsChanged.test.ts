import test from 'node:test';
import assert from 'node:assert/strict';

import {
  METABOTS_CHANGED_EVENT,
  dispatchMetabotsChanged,
  normalizeMetabotsChangedDetail,
  subscribeMetabotsChanged,
  type MetabotsChangedDetail,
} from '../src/renderer/services/metabotEvents';

// Behavior coverage for the cross-view roster broadcast (owner finding
// 2026-11-08): completing a Twin-seat appointment in the Bot Internet panel
// must refresh an already-open My Bots pane, and a My Bots save must refresh
// the panel — no pane switch. The transport is a real EventTarget; no DOM and
// no real electron IPC involved.

test('the broadcast keeps the established app event name', () => {
  assert.equal(METABOTS_CHANGED_EVENT, 'app:metabots-changed');
});

test('dispatch carries a deduped metabot id set and reason', () => {
  const bus = new EventTarget();
  const seen: MetabotsChangedDetail[] = [];
  const off = subscribeMetabotsChanged((detail) => seen.push(detail), bus);

  dispatchMetabotsChanged({ metabotIds: [3, 3, 1], reason: 'twin-seat' }, bus);

  assert.deepEqual(seen, [{ metabotIds: [3, 1], reason: 'twin-seat' }]);
  off();
});

test('unsubscribe stops delivery', () => {
  const bus = new EventTarget();
  const seen: MetabotsChangedDetail[] = [];
  const off = subscribeMetabotsChanged((detail) => seen.push(detail), bus);
  off();

  dispatchMetabotsChanged({ metabotIds: [7], reason: 'edit' }, bus);

  assert.deepEqual(seen, []);
});

test('a bare legacy dispatch (no detail) means "the roster moved"', () => {
  const bus = new EventTarget();
  const seen: MetabotsChangedDetail[] = [];
  const off = subscribeMetabotsChanged((detail) => seen.push(detail), bus);

  // UserSettings' chain-restore flow dispatches exactly this bare event.
  bus.dispatchEvent(new CustomEvent(METABOTS_CHANGED_EVENT));

  assert.deepEqual(seen, [{ metabotIds: [] }]);
  off();
});

test('malformed detail never reaches a subscriber as anything but an id set', () => {
  assert.deepEqual(normalizeMetabotsChangedDetail(undefined), { metabotIds: [] });
  assert.deepEqual(normalizeMetabotsChangedDetail(null), { metabotIds: [] });
  assert.deepEqual(normalizeMetabotsChangedDetail({ metabotIds: 'nope', reason: 42 }), {
    metabotIds: [],
  });
  assert.deepEqual(
    normalizeMetabotsChangedDetail({ metabotIds: [2, 'x', Number.NaN, 2], reason: ' edit ' }),
    { metabotIds: [2], reason: 'edit' },
  );
});
