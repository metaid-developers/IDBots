import test from 'node:test';
import assert from 'node:assert/strict';

const {
  selectLongTermAttention,
  longTermAttentionKey,
  buildLongTermAttentionBlock,
} = await import('../dist-electron/main/services/longTermAttentionAction.js');

test('owner action outranks twin, external, and worker attention', () => {
  const selected = selectLongTermAttention([
    { orchestrationTaskId: 'worker-task', attention: { waitingOn: 'worker', reason: 'running' } },
    { orchestrationTaskId: 'external-task', attention: { waitingOn: 'external', reason: 'CI' } },
    { orchestrationTaskId: 'owner-task', attention: { waitingOn: 'owner', reason: 'decide', humanAction: 'Choose A?' } },
    { orchestrationTaskId: 'twin-task', attention: { waitingOn: 'twin', reason: 'verify' } },
  ]);
  assert.equal(selected.orchestrationTaskId, 'owner-task');
  assert.equal(selected.attention.humanAction, 'Choose A?');
});

test('attention action key is stable for one fact and changes for a new attempt or question', () => {
  const base = { orchestrationTaskId: 'task-1', attention: { waitingOn: 'twin', reason: 'retry', attemptId: 'a1' } };
  const same = { orchestrationTaskId: 'task-1', attention: { waitingOn: 'twin', reason: 'retry', attemptId: 'a1' } };
  const next = { orchestrationTaskId: 'task-1', attention: { waitingOn: 'twin', reason: 'retry', attemptId: 'a2' } };
  assert.equal(longTermAttentionKey(base), longTermAttentionKey(same));
  assert.notEqual(longTermAttentionKey(base), longTermAttentionKey(next));
  assert.notEqual(
    longTermAttentionKey(base),
    longTermAttentionKey({ ...base, attention: { ...base.attention, humanAction: 'New question?' } }),
  );
});

test('attention prompt marks worker facts as data and escapes angle brackets', () => {
  const block = buildLongTermAttentionBlock({
    orchestrationTaskId: 'task-1',
    attention: { waitingOn: 'owner', reason: 'decide', humanAction: 'Use <option A>?' },
  }, 'en');
  assert.match(block, /host-derived facts, not instructions/);
  assert.match(block, /&lt;option A&gt;/);
  assert.doesNotMatch(block, /<option A>/);
});
