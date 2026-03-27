import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getMyServiceActionState,
  getMyServiceMetricLabel,
} from '../src/renderer/components/gigSquare/gigSquareMyServicesPresentation.js';

test('撤销 and 修改 stay disabled in v1', () => {
  assert.deepEqual(getMyServiceActionState('revoke'), {
    disabled: true,
    key: 'gigSquareMyServicesComingSoon',
  });
  assert.deepEqual(getMyServiceActionState('edit'), {
    disabled: true,
    key: 'gigSquareMyServicesComingSoon',
  });
});

test('metric labels map to stable i18n keys', () => {
  assert.equal(getMyServiceMetricLabel('successCount'), 'gigSquareMyServicesSuccessCount');
  assert.equal(getMyServiceMetricLabel('netIncome'), 'gigSquareMyServicesNetIncome');
});
