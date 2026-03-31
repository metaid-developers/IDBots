import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const {
  isRemoteSkillServiceListSemanticMiss,
  syncRemoteSkillServicesWithCursor,
  parseRemoteSkillServiceItem,
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

test('parseRemoteSkillServiceItem preserves chain status and operation metadata', () => {
  const row = parseRemoteSkillServiceItem({
    id: 'svc-modify-1',
    status: 0,
    operation: 'modify',
    path: '@svc-root-1',
    address: '1abc',
    metaid: 'meta-1',
    globalMetaId: 'global-1',
    timestamp: 1_773_514_659,
    contentSummary: {
      serviceName: 'weather-service',
      displayName: 'Weather',
      description: 'desc',
      price: '0.0001',
      currency: 'SPACE',
      providerMetaBot: 'global-1',
      providerSkill: 'weather',
    },
  });

  assert.equal(row.operation, 'modify');
  assert.equal(row.path, '@svc-root-1');
  assert.equal(row.status, 0);
  assert.equal(row.sourceServicePinId, 'svc-root-1');
});

test('parseRemoteSkillServiceItem preserves revoke rows even when contentSummary is empty', () => {
  const row = parseRemoteSkillServiceItem({
    id: 'svc-revoke-1',
    status: -1,
    operation: 'revoke',
    path: '@svc-root-1',
    address: '1abc',
    create_address: '1abc',
    metaid: 'meta-1',
    globalMetaId: 'global-1',
    timestamp: 1_773_514_700,
    contentSummary: '',
  });

  assert.ok(row);
  assert.equal(row.operation, 'revoke');
  assert.equal(row.path, '@svc-root-1');
  assert.equal(row.sourceServicePinId, 'svc-root-1');
  assert.equal(row.status, -1);
  assert.equal(row.available, 0);
  assert.equal(row.providerMetaId, 'meta-1');
  assert.equal(row.providerGlobalMetaId, 'global-1');
});

test('parseRemoteSkillServiceItem ignores original protocol path when mutation target pin is absent', () => {
  const row = parseRemoteSkillServiceItem({
    id: 'svc-modify-2',
    status: 0,
    operation: 'modify',
    path: '/protocols/skill-service',
    originalId: '/protocols/skill-service',
    address: '1abc',
    metaid: 'meta-1',
    globalMetaId: 'global-1',
    contentSummary: {
      serviceName: 'weather-service',
      displayName: 'Weather',
      description: 'desc',
      price: '0.0001',
      currency: 'SPACE',
    },
  });

  assert.ok(row);
  assert.equal(row.sourceServicePinId, 'svc-modify-2');
});

test('parseRemoteSkillServiceItem keeps provider identity address separate from paymentAddress', () => {
  const row = parseRemoteSkillServiceItem({
    id: 'svc-btc-pay-1',
    status: 0,
    operation: 'create',
    address: 'mvc-provider-address',
    create_address: 'mvc-provider-address',
    metaid: 'meta-1',
    globalMetaId: 'global-1',
    contentSummary: {
      serviceName: 'cross-chain-service',
      displayName: 'Cross Chain',
      description: 'desc',
      price: '0.0001',
      currency: 'BTC',
      paymentAddress: 'btc-payment-address',
    },
  });

  assert.ok(row);
  assert.equal(row.providerAddress, 'mvc-provider-address');
  assert.equal(row.createAddress, 'mvc-provider-address');
  assert.equal(row.paymentAddress, 'btc-payment-address');
});

test('parseRemoteSkillServiceRow preserves createAddress and paymentAddress independently', () => {
  const row = parseRemoteSkillServiceRow({
    id: 'svc-row-1',
    create_address: 'mvc-provider-address',
    payment_address: 'btc-payment-address',
  });

  assert.equal(row.providerAddress, 'mvc-provider-address');
  assert.equal(row.createAddress, 'mvc-provider-address');
  assert.equal(row.paymentAddress, 'btc-payment-address');
});

test('isRemoteSkillServiceListSemanticMiss falls back when list items lack mutation metadata', () => {
  assert.equal(isRemoteSkillServiceListSemanticMiss({
    data: {
      list: [{
        id: 'svc-local-1',
        contentSummary: {
          serviceName: 'weather-service',
        },
      }],
    },
  }), true);

  assert.equal(isRemoteSkillServiceListSemanticMiss({
    data: {
      list: [{
        id: 'svc-remote-1',
        operation: 'create',
        status: 0,
        contentSummary: {
          serviceName: 'weather-service',
        },
      }],
    },
  }), false);
});
