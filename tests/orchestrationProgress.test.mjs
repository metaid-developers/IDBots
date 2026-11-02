import test from 'node:test';
import assert from 'node:assert/strict';

const {
  parseWorkerHandoff,
  deriveOrchestrationAttention,
} = await import('../dist-electron/main/services/orchestrationProgress.js');

function task(status = 'running', origin = 'twin_delegate') {
  return { id: 'task-1', status, origin };
}

function step({ status = 'running', attemptStatus = 'running', result = null } = {}) {
  return {
    id: 'step-1',
    status,
    activeAttemptId: 'attempt-1',
    attempts: [{ id: 'attempt-1', status: attemptStatus, result, queuedAt: '2026-11-02T00:00:00.000Z' }],
  };
}

test('legacy plain text remains a ready handoff', () => {
  const handoff = parseWorkerHandoff('Built index.html; evidence: file exists.');
  assert.equal(handoff.state, 'ready');
  assert.equal(handoff.structured, false);
  assert.equal(handoff.humanAction, null);
  assert.match(handoff.summary, /Built index.html/);
});

test('structured handoff preserves state, evidence, blockers, and human action', () => {
  const reply = `Work summary\n<worker_handoff>${JSON.stringify({
    state: 'blocked',
    summary: 'Implementation is ready but deployment needs a decision',
    deliverables: [{ uri: 'metaapp://demo' }],
    verificationEvidence: ['pnpm test passed'],
    blockers: ['production deploy not approved'],
    humanAction: 'Approve production deploy?',
  })}</worker_handoff>`;
  const handoff = parseWorkerHandoff(reply);
  assert.equal(handoff.state, 'blocked');
  assert.equal(handoff.structured, true);
  assert.equal(handoff.deliverables[0].uri, 'metaapp://demo');
  assert.deepEqual(handoff.verificationEvidence, ['pnpm test passed']);
  assert.equal(handoff.humanAction, 'Approve production deploy?');
});

test('malformed or invalid structured handoffs fail closed instead of becoming ready', () => {
  const malformed = parseWorkerHandoff('<worker_handoff>{not json}</worker_handoff>');
  assert.equal(malformed.state, 'failed');
  assert.equal(malformed.parseError, 'WORKER_HANDOFF_INVALID');

  const invalid = parseWorkerHandoff('<worker_handoff>{"state":"completed"}</worker_handoff>');
  assert.equal(invalid.state, 'failed');
  assert.equal(invalid.parseError, 'WORKER_HANDOFF_STATE_INVALID');

  const unclosed = parseWorkerHandoff('<worker_handoff>{"state":"ready"}');
  assert.equal(unclosed.state, 'failed');
  assert.equal(unclosed.parseError, 'WORKER_HANDOFF_INVALID');
});

test('an active attempt means waiting for the Worker', () => {
  const attention = deriveOrchestrationAttention(task(), [step({ attemptStatus: 'running' })]);
  assert.equal(attention.waitingOn, 'worker');
  assert.equal(attention.attemptId, 'attempt-1');
});

test('a human question takes priority over other active work', () => {
  const result = {
    replyText: 'question',
    handoff: { ...parseWorkerHandoff('question'), humanAction: 'Choose A or B?' },
  };
  const attention = deriveOrchestrationAttention(task(), [step({ attemptStatus: 'running', result })]);
  assert.equal(attention.waitingOn, 'owner');
  assert.equal(attention.humanAction, 'Choose A or B?');
});

test('an external wait is distinct from a Worker or Twin wait', () => {
  const result = {
    replyText: 'waiting',
    handoff: parseWorkerHandoff('<worker_handoff>{"state":"waiting_external","summary":"Wait for CI","blockers":["CI still running"],"humanAction":null}</worker_handoff>'),
  };
  const attention = deriveOrchestrationAttention(task(), [step({ status: 'waiting_input', attemptStatus: 'completed', result })]);
  assert.equal(attention.waitingOn, 'external');
  assert.match(attention.reason, /CI still running/);
});

test('failed and ready steps require Twin action; owner acceptance stays separate', () => {
  const failed = deriveOrchestrationAttention(task(), [step({ status: 'ready', attemptStatus: 'failed' })]);
  assert.equal(failed.waitingOn, 'twin');

  const result = { replyText: 'done', handoff: parseWorkerHandoff('done') };
  const twinReview = deriveOrchestrationAttention(task('review'), [step({ status: 'completed', attemptStatus: 'completed', result })]);
  assert.equal(twinReview.waitingOn, 'twin');

  const ownerReview = deriveOrchestrationAttention(task('review', 'owner'), [step({ status: 'waiting_input', attemptStatus: 'completed', result })]);
  assert.equal(ownerReview.waitingOn, 'owner');
});

test('completed and cancelled tasks have no pending attention', () => {
  assert.equal(deriveOrchestrationAttention(task('completed'), []).waitingOn, 'none');
  assert.equal(deriveOrchestrationAttention(task('cancelled'), []).waitingOn, 'none');
  assert.equal(deriveOrchestrationAttention(task('failed'), []).waitingOn, 'twin');
});
