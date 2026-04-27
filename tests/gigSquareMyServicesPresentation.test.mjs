import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getMyServiceActionState,
  getMyServiceMetricLabel,
} from '../src/renderer/components/gigSquare/gigSquareMyServicesPresentation.js';

test('撤销 and 修改 are enabled actions for local services', () => {
  assert.deepEqual(getMyServiceActionState('revoke'), {
    disabled: false,
    key: null,
  });
  assert.deepEqual(getMyServiceActionState('edit'), {
    disabled: false,
    key: null,
  });
});

test('metric labels map to stable i18n keys', () => {
  assert.equal(getMyServiceMetricLabel('successCount'), 'gigSquareMyServicesSuccessCount');
  assert.equal(getMyServiceMetricLabel('netIncome'), 'gigSquareMyServicesNetIncome');
});
