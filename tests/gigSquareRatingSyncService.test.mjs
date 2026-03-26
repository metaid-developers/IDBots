import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

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
