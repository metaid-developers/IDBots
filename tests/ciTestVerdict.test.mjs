import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectFailures } from '../scripts/ci-test-verdict.mjs';

test('collectFailures: success and skipped test steps are not failures', () => {
  const env = {
    TEST_AGENT_GAME_OUTCOME: 'success',
    TEST_COMMERCE_OUTCOME: 'success',
    TEST_NSIS_HARNESS_OUTCOME: 'skipped',
    CI: 'true',
    SOME_OTHER_OUTCOME: 'failure',
  };
  assert.deepEqual(collectFailures(env), []);
});

test('collectFailures: every non-success test step is listed, so one round reports all of them', () => {
  const failures = collectFailures({
    TEST_AGENT_GAME_OUTCOME: 'success',
    TEST_COMMERCE_OUTCOME: 'failure',
    TEST_WALLET_SECURITY_OUTCOME: 'failure',
    TEST_RELEASE_REVIEW_OUTCOME: 'cancelled',
  });
  assert.deepEqual(failures, [
    { name: 'TEST_COMMERCE_OUTCOME', outcome: 'failure' },
    { name: 'TEST_RELEASE_REVIEW_OUTCOME', outcome: 'cancelled' },
    { name: 'TEST_WALLET_SECURITY_OUTCOME', outcome: 'failure' },
  ]);
});

test('collectFailures ignores env entries that are not test-step outcomes', () => {
  assert.deepEqual(
    collectFailures({ OUTCOME_TEST_X: 'failure', TEST_X: 'failure', TEST_Y_RESULT: 'failure' }),
    [],
  );
});

test('collectFailures: an outcome GitHub never set cannot pass silently', () => {
  assert.deepEqual(collectFailures({ TEST_COMMERCE_OUTCOME: '' }), [{ name: 'TEST_COMMERCE_OUTCOME', outcome: '(unset)' }]);
});
