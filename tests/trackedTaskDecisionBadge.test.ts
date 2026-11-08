// waiting_owner (待拍板) decision badges + the mandatory decision brief.
//
// A sub-project parked on an owner decision is the one state where the task's
// progress depends on the OWNER, so it must be visible without opening a tab:
// the rail's 长期任务 entry and the 长期任务 L1 tab both carry an amber dot
// driven by the same derivation. The mid column used to carry a THIRD copy on
// its record-type row; that row was removed with the type drawer (owner ruling
// 2026-11-08), so the badge contract now pins exactly two render sites and the
// mid column's absence. The same requirement forces the Twin's
// wait_note/summary to be a six-section decision brief, stated identically in
// the tool descriptions, the exec skill and the heartbeat re-presentation.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  countLongTermTasksAwaitingOwner,
  selectTrackedTasksNeedingAttention,
} from '../src/renderer/utils/trackedTaskAttention';
import type { LongTermBoard, LongTermTaskSummary } from '../src/renderer/types/longTermTask';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readSource = (relative: string): string => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const card = (id: string, column: LongTermTaskSummary['column']): LongTermTaskSummary => ({
  id,
  title: `Task ${id}`,
  goal: 'g',
  stage: 'active',
  column,
  acceptanceDelegate: false,
  currentSubtaskId: null,
  currentSubtaskTitle: null,
  currentSubtaskStatus: null,
  currentWaitNote: null,
  currentExpectedMinutes: null,
  progress: { accepted: 0, total: 1, percent: 0 },
  counts: {
    pending: 0,
    in_progress: 0,
    waiting_owner: 0,
    waiting_external: 0,
    accepted: 0,
    rejected: 0,
    skipped: 0,
  },
  participants: [],
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  doneAt: null,
});

const board = (columns: Array<LongTermTaskSummary['column']>): LongTermBoard => ({
  generatedAtMs: 0,
  columns: [],
  cards: columns.map((column, index) => card(`task-${index}`, column)),
});

test('only cards parked on an owner decision count', () => {
  assert.equal(countLongTermTasksAwaitingOwner(null), 0, 'no board yet = no badge');
  assert.equal(countLongTermTasksAwaitingOwner(board([])), 0);
  assert.equal(
    countLongTermTasksAwaitingOwner(board(['in_progress', 'waiting_external', 'defining', 'paused', 'done'])),
    0,
    'waiting_external is NOT the owner\'s call — it waits on the outside world',
  );
  assert.equal(countLongTermTasksAwaitingOwner(board(['waiting_owner', 'in_progress', 'waiting_owner'])), 2);
});

test('the combined derivation reports longTerm, the reserved metaTask slot and the total', () => {
  assert.deepEqual(selectTrackedTasksNeedingAttention({ longTermTask: { board: null } }), {
    longTerm: 0,
    metaTask: 0,
    total: 0,
  });
  assert.deepEqual(
    selectTrackedTasksNeedingAttention({ longTermTask: { board: board(['waiting_owner', 'waiting_owner']) } }),
    { longTerm: 2, metaTask: 0, total: 2 },
  );
});

test('the board is initialized app-wide, so the badges work without opening the tab', () => {
  const app = readSource('src/renderer/App.tsx');
  assert.match(
    app,
    /await Promise\.all\(\[[\s\S]*longTermTaskService\.init\(\),[\s\S]*\]\);/,
    'App.tsx hoists the long-term board init into the startup barrier',
  );

  // The board component's own init stays, and init() is idempotent.
  const service = readSource('src/renderer/services/longTermTask.ts');
  assert.match(service, /async init\(\): Promise<void> \{\s*\n\s*if \(this\.initialized\) return;/);
});

test('both badges are wired to the shared derivation and the amber decision dot', () => {
  // The Internet surface's rail keeps its amber dot on the 长期任务 entry (this
  // anchor is untouched by the Home restore — the rail is not mounted on the
  // Home face). The restored Bot Home sidebar carries the SAME derivation and
  // the SAME dot class on its own 长期任务 text row (owner ruling 2026-11-08
  // 14:22), so each face has exactly one dot and neither face has two.
  const rail = readSource('src/renderer/components/layout/WorkspaceRail.tsx');
  assert.match(rail, /selectTrackedTasksNeedingAttention\(\{ longTermTask: \{ board: longTermBoard \} \}\)/);
  assert.match(rail, /needsDecisionCount: trackedTaskAttention\.total/);
  assert.match(rail, /tracked-task-decision-indicator/);
  assert.match(rail, /indicatorKind === 'decision'/);
  assert.match(rail, /role="img"[\s\S]{0,160}aria-label=\{indicatorLabel\}/);

  const homeSidebar = readSource('src/renderer/components/HomeSidebar.tsx');
  assert.match(homeSidebar, /selectTrackedTasksNeedingAttention\(\{ longTermTask: \{ board: longTermBoard \} \}\)/);
  assert.match(homeSidebar, /needsDecisionCount: trackedTaskAttention\.total/);
  assert.match(homeSidebar, /tracked-task-decision-indicator/);
  assert.match(homeSidebar, /indicatorKind === 'decision'/);
  assert.match(homeSidebar, /role="img"[\s\S]{0,160}aria-label=\{item\.indicatorLabel\}/);

  // The Internet middle column still carries no copy of the dot (it duplicates
  // neither the rail nor the Home sidebar).
  const sidebar = readSource('src/renderer/components/Sidebar.tsx');
  assert.doesNotMatch(sidebar, /tracked-task-decision-indicator/);
  assert.doesNotMatch(sidebar, /selectTrackedTasksNeedingAttention/);
  assert.doesNotMatch(sidebar, /trackedTaskNeedsDecision/);
  assert.doesNotMatch(sidebar, /decisionLabel/);

  const view = readSource('src/renderer/components/scheduledTasks/ScheduledTasksView.tsx');
  assert.match(view, /const longTermNeedsDecisionCount = useMemo/);
  assert.match(view, /const longTermBoard = useSelector\(\(state: RootState\) => state\.longTermTask\.board\)/);
  assert.match(view, /data-testid="long-term-tab-decision-indicator"/);
  assert.match(view, /tracked-task-decision-indicator/);

  const css = readSource('src/renderer/index.css');
  assert.match(css, /\.tracked-task-decision-indicator \{/);
  assert.match(css, /\.dark \.tracked-task-decision-indicator \{/);
});

test('the decision brief contract is stated in all three enforcement surfaces', () => {
  const sections = ['背景与已完成进展', '当前状况', '需要你拍板的事项', '选项与利弊', '推荐项及理由', '拍板后的下一步'];

  const toolSource = readSource('src/main/libs/longTermTaskAgentTools.ts');
  for (const section of sections) {
    assert.ok(toolSource.includes(section), `agent tool descriptions carry section ${section}`);
  }
  assert.match(toolSource, /ownerBriefRule/);
  assert.match(toolSource, /longterm_subtask_wait[\s\S]{0,4000}ownerBriefRule/);

  const skill = readSource('SKILLs/long-term-task/SKILL.md');
  for (const section of sections) {
    assert.ok(skill.includes(section), `long-term-task skill carries section ${section}`);
  }

  const execSkill = readSource('SKILLs/long-term-task-exec/SKILL.md');
  for (const section of sections) {
    assert.ok(execSkill.includes(section), `long-term-task-exec skill carries section ${section}`);
  }

  const advance = readSource('src/main/services/longTermAdvanceService.ts');
  for (const section of sections) {
    assert.ok(advance.includes(section), `heartbeat re-presentation carries section ${section}`);
  }
});

test('the wait-note panel renders the brief as multiple lines', () => {
  const detail = readSource('src/renderer/components/longTermTasks/LongTermTaskDetail.tsx');
  assert.match(detail, /whitespace-pre-line[\s\S]{0,400}waitingOn/);
});
