import assert from 'node:assert/strict';
import test from 'node:test';

import {
  communityRootCacheKey,
  ownerRootCacheKey,
  readCachedListPage,
  writeCachedListPage,
} from '../src/renderer/components/metaapps/metaAppListCache.js';

const fakeStorage = (initial = {}) => {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
};

test('cache key builders are stable and scoped', () => {
  assert.equal(communityRootCacheKey(), 'idbots.metaapps.community.root.v1');
  assert.equal(ownerRootCacheKey(7), 'idbots.metaapps.owner.7.root.v1');
});

test('writeCachedListPage + readCachedListPage round-trips the payload', () => {
  const storage = fakeStorage();
  const data = { apps: [{ sourcePinId: 'pin-1' }], nextCursor: '42', seen: ['a'] };
  writeCachedListPage('k', data, storage);
  const entry = readCachedListPage('k', storage);
  assert.equal(entry.v, 1);
  assert.equal(typeof entry.savedAt, 'number');
  assert.deepEqual(entry.data, data);
});

test('readCachedListPage returns null for missing keys and corrupt JSON', () => {
  const storage = fakeStorage({ bad: '{oops', wrongV: JSON.stringify({ v: 99, data: {} }) });
  assert.equal(readCachedListPage('missing', storage), null);
  assert.equal(readCachedListPage('bad', storage), null);
  assert.equal(readCachedListPage('wrongV', storage), null);
});

test('cache helpers tolerate a throwing storage', () => {
  const throwing = {
    getItem: () => { throw new Error('denied'); },
    setItem: () => { throw new Error('quota'); },
  };
  assert.equal(readCachedListPage('k', throwing), null);
  assert.doesNotThrow(() => writeCachedListPage('k', { apps: [] }, throwing));
});
