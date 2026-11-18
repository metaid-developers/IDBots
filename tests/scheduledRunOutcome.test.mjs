// src/main/libs/scheduledRunOutcome.ts — run receipt tiering (T-A).
//
// Contract under test:
//   a. classification — submitted + work → completed; submitted + zero work →
//      completed_empty; turn settled abnormally in-window → crashed; the
//      wall-clock watchdog kill → timeout; any other throw → crashed;
//   b. unknown work evidence (null) can never prove "empty" → completed;
//   c. the watchdog discriminator matches ONLY the watchdog's exact template
//      prefix, never free text;
//   d. work counting — assistant/tool_use messages at/after runStartMs;
//      other types and older messages never count.
//
// The pure module loads straight from src/ (Node type stripping).

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyScheduledRunOutcome,
  countRunWorkMessages,
  isWallClockBudgetError,
  TURN_SETTLED_ABNORMALLY_ERROR,
  WALL_CLOCK_BUDGET_EXCEEDED_MARKER,
} from '../src/main/libs/scheduledRunOutcome.ts';

test('classify: normal exit with work → completed', () => {
  assert.equal(
    classifyScheduledRunOutcome({
      submitted: true,
      errorMessage: null,
      turnSettledAbnormally: false,
      workMessageCount: 3,
    }),
    'completed',
  );
});

test('classify: normal exit with zero work → completed_empty (the 2026-11-17 defect)', () => {
  // A broken DSH runtime day: the executor exits normally, zero assistant /
  // tool_use messages land, and the old receipt called that success.
  assert.equal(
    classifyScheduledRunOutcome({
      submitted: true,
      errorMessage: null,
      turnSettledAbnormally: false,
      workMessageCount: 0,
    }),
    'completed_empty',
  );
});

test('classify: turn settled abnormally in-window → crashed with diagnostic', () => {
  assert.equal(
    classifyScheduledRunOutcome({
      submitted: true,
      errorMessage: null,
      turnSettledAbnormally: true,
      workMessageCount: 0,
    }),
    'crashed',
  );
  assert.match(TURN_SETTLED_ABNORMALLY_ERROR, /settled/);
});

test('classify: wall-clock watchdog kill → timeout; other throws → crashed', () => {
  const watchdog = 'Practice run exceeded its 20-minute wall-clock budget';
  assert.equal(
    classifyScheduledRunOutcome({
      submitted: false,
      errorMessage: watchdog,
      turnSettledAbnormally: false,
      workMessageCount: null,
    }),
    'timeout',
  );
  assert.equal(
    classifyScheduledRunOutcome({
      submitted: false,
      errorMessage: 'Session not found',
      turnSettledAbnormally: false,
      workMessageCount: null,
    }),
    'crashed',
  );
});

test('classify: unknown work evidence (null) can never prove empty → completed', () => {
  assert.equal(
    classifyScheduledRunOutcome({
      submitted: true,
      errorMessage: null,
      turnSettledAbnormally: false,
      workMessageCount: null,
    }),
    'completed',
  );
});

test('watchdog discriminator: exact template prefix only', () => {
  assert.equal(isWallClockBudgetError('Practice run exceeded its 20-minute wall-clock budget'), true);
  assert.equal(isWallClockBudgetError('practice run exceeded its 20-minute wall-clock budget'), false, 'case-sensitive prefix');
  assert.equal(isWallClockBudgetError('the Practice run exceeded its budget eventually'), false, 'prefix anchored');
  assert.equal(isWallClockBudgetError(null), false);
  assert.equal(WALL_CLOCK_BUDGET_EXCEEDED_MARKER, 'Practice run exceeded its');
});

test('work counting: assistant/tool_use at-or-after runStartMs; older and other types never count', () => {
  const runStartMs = 1_000;
  const messages = [
    { type: 'user', timestamp: runStartMs - 1 },        // before window, wrong type
    { type: 'user', timestamp: runStartMs + 1 },        // the fire's prompt — never work
    { type: 'assistant', timestamp: runStartMs },       // boundary inclusive
    { type: 'tool_use', timestamp: runStartMs + 500 },
    { type: 'tool_result', timestamp: runStartMs + 501 }, // follows tool_use, not counted twice
    { type: 'system', timestamp: runStartMs + 502 },      // diagnostics are not work
    { type: 'assistant', timestamp: runStartMs - 100 },   // a previous fire's output
  ];
  assert.equal(countRunWorkMessages(messages, runStartMs), 2);
  assert.equal(countRunWorkMessages([], runStartMs), 0);
});
