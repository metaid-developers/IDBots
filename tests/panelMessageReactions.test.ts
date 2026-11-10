import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PANEL_REACTIONS_STORAGE_PREFIX,
  applyPanelReactionToggle,
  panelReactionStorageKey,
  readPanelReaction,
  readPanelReactionsForSession,
  writePanelReaction,
  type PanelReactionsStorage,
} from '../src/renderer/features/botBrowser/panelMessageReactions';

// Bubble reactions MVP (purity pass #1, item ③): localStorage under
// `twinChatReactions:{sessionId}:{messageId}`, single-choice, toggleable.
// Every test drives a fake storage — the module's public surface takes the
// storage as a parameter precisely so no test touches a real localStorage.

class FakeStorage implements PanelReactionsStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, String(value)); }
  removeItem(key: string): void { this.map.delete(key); }
  key(index: number): string | null { return [...this.map.keys()][index] ?? null; }
  get length(): number { return this.map.size; }
}

const SESSION = '51e69c1a-acb5-4c93-903f-d9d054ff46df';
const MESSAGE = 'msg-42';

test('the storage key carries the exact namespaced shape', () => {
  assert.equal(
    panelReactionStorageKey(SESSION, MESSAGE),
    `twinChatReactions:${SESSION}:${MESSAGE}`,
  );
  assert.ok(panelReactionStorageKey(SESSION, MESSAGE).startsWith(`${PANEL_REACTIONS_STORAGE_PREFIX}:`));
});

test('write then read round-trips up and down ratings', () => {
  const storage = new FakeStorage();
  assert.equal(readPanelReaction(storage, SESSION, MESSAGE), null);
  writePanelReaction(storage, SESSION, MESSAGE, 'up');
  assert.equal(readPanelReaction(storage, SESSION, MESSAGE), 'up');
  writePanelReaction(storage, SESSION, MESSAGE, 'down');
  assert.equal(readPanelReaction(storage, SESSION, MESSAGE), 'down');
});

test('writePanelReaction(null) clears the stored rating', () => {
  const storage = new FakeStorage();
  writePanelReaction(storage, SESSION, MESSAGE, 'up');
  writePanelReaction(storage, SESSION, MESSAGE, null);
  assert.equal(readPanelReaction(storage, SESSION, MESSAGE), null);
});

test('applyPanelReactionToggle: re-pick cancels, other side switches', () => {
  assert.equal(applyPanelReactionToggle(null, 'up'), 'up');
  assert.equal(applyPanelReactionToggle('up', 'up'), null);
  assert.equal(applyPanelReactionToggle('up', 'down'), 'down');
  assert.equal(applyPanelReactionToggle('down', 'down'), null);
  assert.equal(applyPanelReactionToggle(null, 'down'), 'down');
});

test('malformed stored values read as no reaction, never throw', () => {
  const storage = new FakeStorage();
  storage.setItem(panelReactionStorageKey(SESSION, MESSAGE), 'not json {{{');
  assert.equal(readPanelReaction(storage, SESSION, MESSAGE), null);
  storage.setItem(panelReactionStorageKey(SESSION, MESSAGE), JSON.stringify({ rating: 'sideways' }));
  assert.equal(readPanelReaction(storage, SESSION, MESSAGE), null);
  storage.setItem(panelReactionStorageKey(SESSION, MESSAGE), JSON.stringify({ rating: 42 }));
  assert.equal(readPanelReaction(storage, SESSION, MESSAGE), null);
});

test('a throwing storage degrades to no-op instead of crashing render paths', () => {
  const throwing: PanelReactionsStorage = {
    getItem: () => { throw new Error('privacy mode'); },
    setItem: () => { throw new Error('quota'); },
    removeItem: () => { throw new Error('privacy mode'); },
    key: () => null,
    length: 0,
  };
  assert.equal(readPanelReaction(throwing, SESSION, MESSAGE), null);
  assert.doesNotThrow(() => writePanelReaction(throwing, SESSION, MESSAGE, 'up'));
  assert.doesNotThrow(() => writePanelReaction(throwing, SESSION, MESSAGE, null));
  assert.deepEqual(readPanelReactionsForSession(throwing, SESSION), {});
  assert.equal(readPanelReaction(null, SESSION, MESSAGE), null);
  assert.doesNotThrow(() => writePanelReaction(null, SESSION, MESSAGE, 'up'));
});

test('the session sweep reads only this session bubbles and skips foreign keys', () => {
  const storage = new FakeStorage();
  writePanelReaction(storage, SESSION, 'msg-1', 'up');
  writePanelReaction(storage, SESSION, 'msg-2', 'down');
  writePanelReaction(storage, 'other-session', 'msg-3', 'up');
  storage.setItem('unrelated:key', JSON.stringify({ rating: 'up' }));
  storage.setItem(`${PANEL_REACTIONS_STORAGE_PREFIX}:${SESSION}:`, JSON.stringify({ rating: 'up' })); // empty id ignored
  const swept = readPanelReactionsForSession(storage, SESSION);
  assert.deepEqual(swept, { 'msg-1': 'up', 'msg-2': 'down' });
});
