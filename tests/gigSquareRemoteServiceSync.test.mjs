import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
  syncRemoteSkillServicesWithCursor,
  parseRemoteSkillServiceRow,
} = require('../dist-electron/services/gigSquareRemoteServiceSync.js');

const makeRemoteItem = (id, overrides = {}) => ({
  id,
  metaid: 'meta-1',
  address: '1abc',
  contentSummary: {
    serviceName: `service-${id}`,
    displayName: `Display ${id}`,
    description: 'desc',
    price: '1',
    currency: 'SPACE',
  },
  ...overrides,
});

test('syncRemoteSkillServicesWithCursor keeps following nextCursor until exhausted', async () => {
  const calls = [];
  const inserted = [];
  await syncRemoteSkillServicesWithCursor({
    pageSize: 2,
    fetchPage: async (cursor) => {
      calls.push(cursor ?? null);
      if (!cursor) return { list: [makeRemoteItem('svc-1'), makeRemoteItem('svc-2')], nextCursor: 'cursor-2' };
      if (cursor === 'cursor-2') return { list: [makeRemoteItem('svc-3')], nextCursor: null };
      return { list: [], nextCursor: null };
    },
    upsertService: (row) => inserted.push(row.id),
  });

  assert.deepEqual(calls, [null, 'cursor-2']);
  assert.deepEqual(inserted, ['svc-1', 'svc-2', 'svc-3']);
});

test('syncRemoteSkillServicesWithCursor stops when nextCursor repeats', async () => {
  const calls = [];
  const inserted = [];
  await syncRemoteSkillServicesWithCursor({
    pageSize: 2,
    fetchPage: async (cursor) => {
      calls.push(cursor ?? null);
      if (calls.length > 2) {
        throw new Error('loop guard failed');
      }
      if (!cursor) return { list: [makeRemoteItem('svc-1')], nextCursor: 'cursor-repeat' };
      return { list: [makeRemoteItem('svc-2')], nextCursor: 'cursor-repeat' };
    },
    upsertService: (row) => inserted.push(row.id),
  });

  assert.deepEqual(calls, [null, 'cursor-repeat']);
  assert.deepEqual(inserted, ['svc-1', 'svc-2']);
});

test('syncRemoteSkillServicesWithCursor stops at maxPages when cursor keeps changing', async () => {
  const calls = [];
  await syncRemoteSkillServicesWithCursor({
    pageSize: 2,
    maxPages: 3,
    fetchPage: async (cursor) => {
      calls.push(cursor ?? null);
      return {
        list: [makeRemoteItem(`svc-${calls.length}`)],
        nextCursor: `cursor-${calls.length}`,
      };
    },
    upsertService: () => {},
  });

  assert.equal(calls.length, 3);
  assert.deepEqual(calls, [null, 'cursor-1', 'cursor-2']);
});

test('syncRemoteSkillServicesWithCursor skips invalid remote items', async () => {
  const inserted = [];
  await syncRemoteSkillServicesWithCursor({
    pageSize: 5,
    fetchPage: async () => ({
      list: [
        { id: 'invalid-no-summary' },
        makeRemoteItem('invalid-no-metaid', { metaid: '' }),
        makeRemoteItem('invalid-no-address', { address: '' }),
        makeRemoteItem('svc-valid'),
      ],
      nextCursor: null,
    }),
    upsertService: (row) => inserted.push(row.id),
  });

  assert.deepEqual(inserted, ['svc-valid']);
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

test('parseRemoteSkillServiceRow normalizes second-based updated_at to milliseconds', () => {
  const row = parseRemoteSkillServiceRow({
    id: 'svc-1',
    updated_at: 1_773_514_659,
  });

  assert.equal(row.updatedAt, 1_773_514_659_000);
});
