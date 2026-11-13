import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveInitialWindowSize } from '../src/main/libs/initialWindowSize';

test('initial window scales with the work area within a comfortable range', () => {
  assert.deepEqual(resolveInitialWindowSize({ width: 1440, height: 875 }), { width: 1267, height: 800 });
  assert.deepEqual(resolveInitialWindowSize({ width: 1512, height: 944 }), { width: 1331, height: 850 });
  assert.deepEqual(resolveInitialWindowSize({ width: 1920, height: 1040 }), { width: 1680, height: 936 });
  assert.deepEqual(resolveInitialWindowSize({ width: 2560, height: 1400 }), { width: 1680, height: 1050 });
});

test('initial window never exceeds a small work area and falls back without one', () => {
  assert.deepEqual(resolveInitialWindowSize({ width: 1280, height: 720 }), { width: 1200, height: 720 });
  assert.deepEqual(resolveInitialWindowSize({ width: 1024, height: 700 }), { width: 1024, height: 700 });
  assert.deepEqual(resolveInitialWindowSize(null), { width: 1200, height: 800 });
  assert.deepEqual(resolveInitialWindowSize({ width: 0, height: 0 }), { width: 1200, height: 800 });
});
