import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

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
