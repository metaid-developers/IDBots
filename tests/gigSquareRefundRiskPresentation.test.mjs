import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getGigSquareRefundRiskBadge,
  shouldHideRiskyGigSquareService,
} from '../src/renderer/components/gigSquare/gigSquareRefundRiskPresentation.js';

test('providers with unresolved refunds under 72h stay visible but red', () => {
  assert.equal(
    shouldHideRiskyGigSquareService({
      hasUnresolvedRefund: true,
      unresolvedRefundAgeHours: 24,
    }),
    false
  );
  assert.equal(
    getGigSquareRefundRiskBadge({ hasUnresolvedRefund: true }),
    'REFUND RISK'
  );
});

test('providers with unresolved refunds over 72h are hidden', () => {
  assert.equal(
    shouldHideRiskyGigSquareService({
      hasUnresolvedRefund: true,
      unresolvedRefundAgeHours: 73,
    }),
    true
  );
});
