import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldMarkSessionRunningFromStreamMessage } from '../src/renderer/services/coworkStreamPresentation.js';

test('stream user messages mark the session running by default', () => {
  assert.equal(shouldMarkSessionRunningFromStreamMessage({ type: 'user' }), true);
  assert.equal(shouldMarkSessionRunningFromStreamMessage({ type: 'assistant' }), false);
});

test('passive observer follow-up user messages do not reopen a completed session', () => {
  assert.equal(
    shouldMarkSessionRunningFromStreamMessage({
      type: 'user',
      metadata: { suppressRunningStatus: true },
    }),
    false
  );
});
