// Unit coverage for the 0.2.2 headless integrations that live in
// coworkAssistantReply.ts:
//
// 1. shouldAutoReviewDshToolCall — the unattended-posture gate deciding which
//    policy checks the runtime reviewer judges instead of a blind allow
// 2. isModelSwitchCompactionFailedDshTurnError — the 0.2.2 kernel code for a
//    switch aborted by pre-switch compaction
// 3. isOverflowDshTurnError must REJECT that code even when the embedded
//    compaction cause carries overflow fingerprints — the serving route never
//    overflowed, so the fallback-brain ladder must not engage (and silently
//    override the operator's explicit model choice)
//
// Run: node --test tests/dshAutoReviewPolicy.test.mjs  (after compile:electron)

import test from 'node:test';
import assert from 'node:assert/strict';

async function importCompiled(modulePath) {
  return import(`../dist-electron/main/libs/${modulePath}.js`);
}

test('shouldAutoReviewDshToolCall reviews mutating tools only in unattended postures', async () => {
  const { shouldAutoReviewDshToolCall, AUTO_REVIEW_TOOL_NAMES } = await importCompiled('coworkAssistantReply');

  // Mutating members of the gated set review under the unattended posture.
  for (const toolName of ['bash', 'write', 'edit', 'delete']) {
    assert.equal(shouldAutoReviewDshToolCall({ toolName, autoApprove: true }), true, `${toolName} reviews under autoApprove`);
  }
  // Case-insensitive on the tool name (the bridge normalizes before calling).
  assert.equal(shouldAutoReviewDshToolCall({ toolName: 'BASH', autoApprove: true }), true, 'tool name matching is case-insensitive');

  // Observation tools never review.
  for (const toolName of ['read', 'read_image']) {
    assert.equal(shouldAutoReviewDshToolCall({ toolName, autoApprove: true }), false, `${toolName} never reviews`);
    assert.ok(!AUTO_REVIEW_TOOL_NAMES.has(toolName), `${toolName} absent from the review set`);
  }

  // bypassPermissions is a true bypass: the operator explicitly chose zero
  // checks, so no LLM review rides on top (delete-policy parity).
  assert.equal(
    shouldAutoReviewDshToolCall({ toolName: 'bash', permissionMode: 'bypassPermissions' }),
    false,
    'bypassPermissions sessions do not review',
  );

  // Attended modes keep their existing behavior (guards + dialogs).
  for (const permissionMode of ['default', 'acceptEdits', 'plan']) {
    assert.equal(
      shouldAutoReviewDshToolCall({ toolName: 'bash', permissionMode }),
      false,
      `${permissionMode} sessions do not review`,
    );
  }

  // Per-tool autoApproveTools stays an owner's explicit no-check choice.
  assert.equal(
    shouldAutoReviewDshToolCall({ toolName: 'bash', autoApprove: false, permissionMode: 'default' }),
    false,
    'attended sessions never review',
  );
});

test('isModelSwitchCompactionFailedDshTurnError matches the 0.2.2 kernel code only', async () => {
  const { isModelSwitchCompactionFailedDshTurnError } = await importCompiled('coworkAssistantReply');

  assert.equal(
    isModelSwitchCompactionFailedDshTurnError({
      kind: 'error',
      error: {
        code: 'MODEL_SWITCH_COMPACTION_FAILED',
        message: 'Cannot switch to opencode/z-ai/glm-5.3-flash: context compaction failed: 400 context_length_exceeded. The previous request model is preserved; retry or select a model with a larger context window.',
      },
    }),
    true,
    'kernel code matches (case-insensitive)',
  );
  assert.equal(
    isModelSwitchCompactionFailedDshTurnError({ kind: 'error', error: { code: 'model_switch_compaction_failed', message: 'x' } }),
    true,
    'lowercase code matches',
  );
  assert.equal(isModelSwitchCompactionFailedDshTurnError({ kind: 'completed' }), false, 'non-error outcomes never match');
  assert.equal(
    isModelSwitchCompactionFailedDshTurnError({ kind: 'error', error: { code: 'CONTEXT_WINDOW_EXCEEDED', message: '400' } }),
    false,
    'plain overflow is not a switch failure',
  );
});

test('isOverflowDshTurnError rejects a failed model switch even with overflow wording in the cause', async () => {
  const { isOverflowDshTurnError } = await importCompiled('coworkAssistantReply');

  // The kernel message embeds the compaction cause; its text can carry the
  // same fingerprints the overflow classifier matches on. The code must win.
  const outcome = {
    kind: 'error',
    error: {
      code: 'MODEL_SWITCH_COMPACTION_FAILED',
      message: 'Cannot switch to opencode/z-ai/glm-5.3-flash: context compaction failed: 400 context_length_exceeded (no body). The previous request model is preserved; retry or select a model with a larger context window.',
    },
  };
  assert.equal(isOverflowDshTurnError(outcome), false, 'switch failure never routes onto the fallback ladder');
  assert.equal(
    isOverflowDshTurnError(outcome, { compactionFailedThisTurn: true }),
    false,
    'switch failure stays non-overflow even with a same-turn compaction failure flag',
  );
  // Sanity: the classifier still catches genuine overflow.
  assert.equal(
    isOverflowDshTurnError({ kind: 'error', error: { code: 'CONTEXT_WINDOW_EXCEEDED', message: '400 status code (no body)' } }),
    true,
    'genuine overflow still classifies',
  );
});
