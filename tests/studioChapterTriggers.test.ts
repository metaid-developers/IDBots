// Studio chapter auto-close triggers (Phase 1 slice 3, owner ruling 三者叠
// 加: budget + task boundary + manual): the turn-end decision is a pure
// function (unit-tested here) fed by the runner with real measured usage;
// the task-boundary flag comes from task_subtask_accept completing a whole
// task. Wiring is pinned with static checks (house style for this area).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  resolveStudioChapterAutoClose,
  studioChapterBudgetThreshold,
  STUDIO_CHAPTER_BUDGET_TOKENS,
  STUDIO_CHAPTER_BUDGET_WINDOW_RATIO,
  STUDIO_CHAPTER_AUTOCLOSE_MIN_INTERVAL_MS,
  STUDIO_TASK_BOUNDARY_MIN_MESSAGES,
} from '../src/main/libs/studioChapterTriggers';

const here = dirname(fileURLToPath(import.meta.url));
const readSource = (relative: string): string => readFileSync(join(here, relative), 'utf8');
const runnerSource = readSource('../src/main/libs/coworkRunner.ts');
const taskToolsSource = readSource('../src/main/libs/longTermTaskAgentTools.ts');
const mainSource = readSource('../src/main/main.ts');

const baseInput = {
  isStudioOwnerSession: true,
  usage: null,
  pendingTaskBoundary: false,
  chapterMessageCount: 0,
  lastAutoCloseAt: null,
  now: 1_000_000,
};

test('studioChapterBudgetThreshold is the smaller of the cap and the window ratio', () => {
  assert.equal(studioChapterBudgetThreshold(1_048_576), STUDIO_CHAPTER_BUDGET_TOKENS, '1M windows take the fixed cap');
  assert.equal(studioChapterBudgetThreshold(128_000), Math.floor(128_000 * STUDIO_CHAPTER_BUDGET_WINDOW_RATIO));
  assert.equal(studioChapterBudgetThreshold(48_000), Math.floor(48_000 * STUDIO_CHAPTER_BUDGET_WINDOW_RATIO));
  assert.equal(studioChapterBudgetThreshold(40_000), null, 'windows too small to chapter are excluded');
  assert.equal(studioChapterBudgetThreshold(null), null);
  assert.equal(studioChapterBudgetThreshold(undefined), null);
});

test('non-studio sessions and rate-limited sessions never auto-close', () => {
  assert.equal(resolveStudioChapterAutoClose({
    ...baseInput,
    isStudioOwnerSession: false,
    pendingTaskBoundary: true,
    chapterMessageCount: 50,
    usage: { usedTokens: 900_000, contextWindow: 1_048_576, isRealUsage: true },
  }), null);

  const closeAt = baseInput.now - 1_000;
  assert.equal(resolveStudioChapterAutoClose({
    ...baseInput,
    lastAutoCloseAt: closeAt,
    pendingTaskBoundary: true,
    chapterMessageCount: 50,
    usage: { usedTokens: 900_000, contextWindow: 1_048_576, isRealUsage: true },
  }), null, 'inside the min interval nothing fires, even with both triggers');

  const staleAt = baseInput.now - STUDIO_CHAPTER_AUTOCLOSE_MIN_INTERVAL_MS - 1;
  assert.ok(resolveStudioChapterAutoClose({
    ...baseInput,
    lastAutoCloseAt: staleAt,
    usage: { usedTokens: 900_000, contextWindow: 1_048_576, isRealUsage: true },
  }), 'past the interval the budget fires again');
});

test('a task boundary wins when the chapter has substance, and falls through when it does not', () => {
  const both = resolveStudioChapterAutoClose({
    ...baseInput,
    pendingTaskBoundary: true,
    chapterMessageCount: STUDIO_TASK_BOUNDARY_MIN_MESSAGES,
    usage: { usedTokens: 900_000, contextWindow: 1_048_576, isRealUsage: true },
  });
  assert.deepEqual(both, { reason: 'task_boundary' }, 'task boundary outranks budget');

  const thin = resolveStudioChapterAutoClose({
    ...baseInput,
    pendingTaskBoundary: true,
    chapterMessageCount: STUDIO_TASK_BOUNDARY_MIN_MESSAGES - 1,
    usage: { usedTokens: 100_000, contextWindow: 1_048_576, isRealUsage: true },
  });
  assert.equal(thin, null, 'a thin chapter does not close on the boundary alone');

  const thinButOverBudget = resolveStudioChapterAutoClose({
    ...baseInput,
    pendingTaskBoundary: true,
    chapterMessageCount: 1,
    usage: { usedTokens: 400_000, contextWindow: 1_048_576, isRealUsage: true },
  });
  assert.ok(thinButOverBudget && thinButOverBudget.reason === 'budget', 'an over-budget thin chapter still closes on budget');
});

test('the budget trigger needs REAL usage at or above the threshold', () => {
  const over = resolveStudioChapterAutoClose({
    ...baseInput,
    usage: { usedTokens: STUDIO_CHAPTER_BUDGET_TOKENS, contextWindow: 1_048_576, isRealUsage: true },
  });
  assert.ok(over && over.reason === 'budget', 'at-threshold fires');
  assert.equal(over && over.reason === 'budget' ? over.threshold : null, STUDIO_CHAPTER_BUDGET_TOKENS);

  assert.equal(resolveStudioChapterAutoClose({
    ...baseInput,
    usage: { usedTokens: STUDIO_CHAPTER_BUDGET_TOKENS - 1, contextWindow: 1_048_576, isRealUsage: true },
  }), null, 'below threshold does not fire');

  assert.equal(resolveStudioChapterAutoClose({
    ...baseInput,
    usage: { usedTokens: 900_000, contextWindow: 1_048_576, isRealUsage: false },
  }), null, 'estimator usage is not trusted for auto-closes');

  assert.equal(resolveStudioChapterAutoClose({
    ...baseInput,
    usage: { usedTokens: 900_000, contextWindow: 32_000, isRealUsage: true },
  }), null, 'an un-chapterable window never budget-fires');
});

test('the runner evaluates at turn end, keeps flags while busy, and rate-limits only real attempts', () => {
  assert.ok(
    runnerSource.includes('this.maybeAutoCloseStudioChapter(sessionId);'),
    'coworkRunner: the evaluation runs after usage settles',
  );
  const evaluate = runnerSource.slice(runnerSource.indexOf('private maybeAutoCloseStudioChapter('));
  assert.ok(
    evaluate.indexOf('localTurnState') < evaluate.indexOf('this.lastStudioChapterAutoCloseBySession.set'),
    'busy sessions return BEFORE the rate-limit stamp — a rejected close must not strand the boundary',
  );
  assert.ok(
    evaluate.includes('void this.closeSessionChapter(sessionId, { closeReason: decision.reason })'),
    'the decision drives closeSessionChapter fire-and-forget',
  );
  assert.ok(
    runnerSource.includes('noteStudioTaskBoundary(sessionId: string'),
    'coworkRunner: the boundary flag setter exists',
  );
});

test('a whole-task completion reaches the chapter trigger through the accept tool and main wiring', () => {
  assert.ok(taskToolsSource.includes('onTaskCompleted?: (sessionId: string, taskId: string) => void;'));
  const acceptAt = taskToolsSource.indexOf("'task_subtask_accept'");
  const acceptBody = taskToolsSource.slice(acceptAt, taskToolsSource.indexOf('return [', acceptAt));
  assert.ok(
    acceptBody.includes("detailAfter?.stage === 'done'") && acceptBody.includes('control.onTaskCompleted?.(mountedSessionId, target.taskId)'),
    'the accept handler fires the hook only when the WHOLE task reaches done',
  );
  assert.ok(
    mainSource.includes('onTaskCompleted: (sid, taskId) => getCoworkRunner().noteStudioTaskBoundary(sid, taskId)'),
    'main.ts wires the hook to the runner boundary setter',
  );
});
