/**
 * Owner-gate steer semantics: free-form chat text must never be read as
 * consent for a safety approval (delete / wallet transfer / chain upload /
 * multisig sign+broadcast). Only a real option label, or the canonical
 * 允许/拒绝 words, may answer such a gate; anything else leaves it pending.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isSafetyApprovalToolInput,
  planSafetyGateSteerAnswer,
} from '../src/main/libs/safetyGateSteer';

function gateInput(options: string[], question = '允许这次操作吗？') {
  return {
    questions: [{
      question,
      options: options.map((label) => ({ label, description: '' })),
    }],
    answers: {},
    context: { requestedToolName: 'wallet_btc_broadcast', requestedToolInput: {}, destructive: false },
  };
}

const zhGate = () => gateInput(['允许本次操作', '拒绝本次操作']);
const enGate = () => gateInput(['Allow this operation', 'Deny this operation'], 'Allow this broadcast?');

test('a safety gate is recognised by its requestedToolName context', () => {
  assert.equal(isSafetyApprovalToolInput(zhGate()), true);
  assert.equal(isSafetyApprovalToolInput({ questions: [], answers: {} }), false);
  assert.equal(isSafetyApprovalToolInput(null), false);
});

test('free-form text never approves a safety gate', () => {
  for (const text of ['不要广播', 'ok', '继续', 'A，gogo', '允许吗?', '拒绝?']) {
    assert.deepEqual(planSafetyGateSteerAnswer(zhGate(), text), { action: 'pass' }, `text ${JSON.stringify(text)} must not answer the gate`);
  }
});

test('an exact option label, or the canonical allow/deny words, answer the gate', () => {
  assert.deepEqual(planSafetyGateSteerAnswer(zhGate(), '允许本次操作'), {
    action: 'allow',
    answers: { '允许这次操作吗？': '允许本次操作' },
  });
  assert.deepEqual(planSafetyGateSteerAnswer(zhGate(), '允许'), {
    action: 'allow',
    answers: { '允许这次操作吗？': '允许本次操作' },
  });
  assert.deepEqual(planSafetyGateSteerAnswer(zhGate(), '拒绝'), {
    action: 'deny',
    answers: { '允许这次操作吗？': '拒绝本次操作' },
  });
  assert.equal(planSafetyGateSteerAnswer(enGate(), 'yes').action, 'allow');
  assert.equal(planSafetyGateSteerAnswer(enGate(), 'no').action, 'deny');
  assert.equal(planSafetyGateSteerAnswer(enGate(), 'Allow this operation').action, 'allow');
});

test('a structured owner question (no safety context) is left to the legacy path', () => {
  assert.deepEqual(
    planSafetyGateSteerAnswer({ questions: [{ question: '选哪个？', options: [{ label: 'A' }] }], answers: {} }, '随便'),
    { action: 'pass' },
  );
});

test('an empty gate or empty text does not answer', () => {
  assert.deepEqual(planSafetyGateSteerAnswer({ questions: [], context: { requestedToolName: 'x' } }, '允许'), { action: 'pass' });
  assert.deepEqual(planSafetyGateSteerAnswer(zhGate(), '   '), { action: 'pass' });
});
