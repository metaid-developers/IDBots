import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  commandSuccess,
  commandWaiting,
  commandManualActionRequired
} = require('../../dist/core/contracts/commandResult.js');

test('success returns ok: true', () => {
  const result = commandSuccess({ id: 'task-1' });
  assert.equal(result.ok, true);
  assert.equal(result.state, 'success');
  assert.deepEqual(result.data, { id: 'task-1' });
});

test('waiting returns ok: false with pollAfterMs', () => {
  const result = commandWaiting('WAITING_FOR_RESOURCE', 'waiting', 3000);
  assert.equal(result.ok, false);
  assert.equal(result.state, 'waiting');
  assert.equal(result.pollAfterMs, 3000);
});

test('manual_action_required can carry a local UI URL', () => {
  const result = commandManualActionRequired(
    'REQUIRES_LOCAL_APPROVAL',
    'approve in local UI',
    'http://127.0.0.1:4455/approve'
  );
  assert.equal(result.ok, false);
  assert.equal(result.state, 'manual_action_required');
  assert.equal(result.localUiUrl, 'http://127.0.0.1:4455/approve');
});
