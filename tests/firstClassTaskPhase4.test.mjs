import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

import {
  DONE_RECENT_ARCHIVE_WINDOW_MS,
  filterTaskBoardCards,
  partitionDoneArchiveCards,
  sortColumnCards,
} from '../src/renderer/utils/taskBoardOrganization.ts';

const require = createRequire(import.meta.url);
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { LongTermTaskStore } = require('../dist-electron/main/longTermTaskStore.js');
const { buildStudioLiveTaskHud } = require('../dist-electron/main/services/studioLiveStageModel.js');
const { renderLiveStageHtml } = require('../dist-electron/main/services/studioLiveStageTemplate.js');

const repoRoot = path.resolve(import.meta.dirname, '..');

test('Phase 4 UI copy & board organization: rail renamed to "任务" / "Tasks", [长期] badge rendered, waiting_owner prioritizes [长期], and Done folds >48h archive', () => {
  assert.equal(DONE_RECENT_ARCHIVE_WINDOW_MS, 48 * 3_600_000);

  const i18nSource = fs.readFileSync(path.join(repoRoot, 'src/renderer/services/i18n.ts'), 'utf8');
  assert.match(i18nSource, /railLongTermTasks:\s*'任务'/);
  assert.match(i18nSource, /railLongTermTasks:\s*'Tasks'/);
  assert.match(i18nSource, /'longTermTask\.newTask':\s*'新建任务'/);
  assert.match(i18nSource, /'longTermTask\.newTask':\s*'New task'/);
  assert.match(i18nSource, /'longTermTask\.badge\.longTerm':\s*'长期'/);

  const cardSource = fs.readFileSync(
    path.join(repoRoot, 'src/renderer/components/longTermTasks/LongTermTaskCard.tsx'),
    'utf8',
  );
  assert.match(cardSource, /data-slot="task-longterm-badge"/);

  const boardSource = fs.readFileSync(
    path.join(repoRoot, 'src/renderer/components/longTermTasks/LongTermTasksBoard.tsx'),
    'utf8',
  );
  assert.match(boardSource, /data-slot="task-board-tier-filter"/);
  assert.match(boardSource, /data-slot="done-archive-fold-toggle"/);

  const nowMs = Date.parse('2026-11-17T12:00:00.000Z');
  const makeCard = (overrides) => ({
    id: 't-1',
    title: 'Sample',
    goal: 'Goal',
    stage: 'active',
    column: 'waiting_owner',
    isLongTerm: false,
    managedState: 'waiting_owner',
    acceptanceDelegate: true,
    planArtifactUri: null,
    currentSubtaskId: 's-1',
    currentSubtaskTitle: 'Step 1',
    currentSubtaskStatus: 'waiting_owner',
    currentWaitNote: null,
    currentExpectedMinutes: null,
    progress: { accepted: 0, total: 1, percent: 0 },
    counts: { pending: 0, in_progress: 0, waiting_owner: 1, waiting_external: 0, accepted: 0, rejected: 0, skipped: 0 },
    decisionSessionIds: [],
    participants: [{ id: 15, name: 'Builder阿码', avatar: null }],
    createdAt: '2026-11-17T08:00:00.000Z',
    updatedAt: '2026-11-17T11:00:00.000Z',
    doneAt: null,
    ...overrides,
  });

  const stdQuick = makeCard({ id: 'std-1', title: '挑一张封面图', isLongTerm: false, updatedAt: '2026-11-17T11:50:00.000Z' });
  const ltStrategic = makeCard({ id: 'lt-1', title: '商业化主线拍板', isLongTerm: true, updatedAt: '2026-11-17T10:00:00.000Z' });

  // Inside waiting_owner, [长期] strategic tasks surface ahead of standard quick cards
  const sortedWaiting = sortColumnCards('waiting_owner', [stdQuick, ltStrategic]);
  assert.deepEqual(sortedWaiting.map((c) => c.id), ['lt-1', 'std-1']);

  // Tier & keyword filters
  assert.equal(filterTaskBoardCards([stdQuick, ltStrategic], { tier: 'long_term' }).length, 1);
  assert.equal(filterTaskBoardCards([stdQuick, ltStrategic], { tier: 'standard' }).length, 1);
  assert.equal(filterTaskBoardCards([stdQuick, ltStrategic], { query: 'Builder阿码 封面' }).length, 1);

  // 48-hour Done archive cutoff
  const done20h = makeCard({
    id: 'done-20h',
    stage: 'done',
    column: 'done',
    doneAt: new Date(nowMs - 20 * 3_600_000).toISOString(),
  });
  const done47h = makeCard({
    id: 'done-47h',
    stage: 'done',
    column: 'done',
    doneAt: new Date(nowMs - 47 * 3_600_000).toISOString(),
  });
  const done60h = makeCard({
    id: 'done-60h',
    stage: 'done',
    column: 'done',
    doneAt: new Date(nowMs - 60 * 3_600_000).toISOString(),
  });

  const { recentDone, archivedDone } = partitionDoneArchiveCards([done20h, done47h, done60h], nowMs);
  assert.deepEqual(recentDone.map((c) => c.id), ['done-20h', 'done-47h']);
  assert.deepEqual(archivedDone.map((c) => c.id), ['done-60h']);
});

test('Phase 4 Live Stage bottom-right HUD: expands ALL machine-wide active in_progress tasks across sessions, badges [长期], and folds paused/defining tasks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-task-p4-'));
  const sqliteStore = await SqliteStore.create(dir);
  try {
    const store = new LongTermTaskStore(sqliteStore.getDatabase(), sqliteStore.getSaveFunction(), {
      resolveParticipants: (ids) =>
        ids.map((id) => ({ id, name: id === 15 ? 'Builder阿码' : `Bot-${id}`, avatar: null })),
    });

    // Task 1: active in_progress created in an OLD Studio session ('old-sess'), assigned to Builder阿码 with live progress note
    const activeOldSess = store.createUnifiedTask(
      {
        title: '多签代码安全审查',
        originSessionId: 'old-sess',
        subtasks: [{ title: '排查广播确认闸', assigneeMetabotId: 15 }],
      },
      'twin',
    );
    store.recordSubtaskProgress(
      activeOldSess.value.subtasks[0].id,
      { note: '正在跑 29 条测试' },
      'worker:15',
    );

    // Task 2: active [长期] task created in THIS Studio session ('fresh-sess')
    const activeLongTerm = store.createUnifiedTask(
      {
        title: 'AI 互联网商业化主线',
        originSessionId: 'fresh-sess',
        isLongTerm: true,
        subtasks: [{ title: 'S7 ME 首笔成交' }],
      },
      'twin',
    );

    // Task 3: paused task from another session -> should be folded (`isCurrent: false`)
    const pausedTask = store.createUnifiedTask(
      {
        title: '移动端四周上线',
        originSessionId: 'mobile-plan-sess',
      },
      'twin',
    );
    store.pauseTask(pausedTask.value.id, 'owner', 'hold');

    const board = store.listBoard();
    // Even if the user opens a brand-new 3rd Studio session ('brand-new-sess') with zero sessionOwnedTaskIds,
    // the HUD STILL stays visible and hangs both active `in_progress` machine tasks at top while folding the paused one!
    const hud = buildStudioLiveTaskHud({
      cards: board.cards,
      sessionOwnedTaskIds: new Set(),
      studioBusy: false,
      rawQueuedDecisions: 0,
    });
    assert.ok(hud, 'HUD must stay visible whenever machine-wide tasks are active');
    const expanded = hud.tasks.filter((t) => t.isCurrent);
    const folded = hud.tasks.filter((t) => !t.isCurrent);
    assert.equal(expanded.length, 2, 'both active in_progress tasks mount expanded on the HUD');
    assert.equal(folded.length, 1, 'paused task folds under inactive/parked toggle');
    assert.equal(folded[0].id, pausedTask.value.id);

    const amaHudRow = expanded.find((t) => t.id === activeOldSess.value.id);
    assert.ok(amaHudRow);
    assert.match(amaHudRow.currentSubtask, /Builder阿码 · 正在跑 29 条测试/);

    const ltHudRow = expanded.find((t) => t.id === activeLongTerm.value.id);
    assert.equal(ltHudRow.isLongTerm, true);

    // Verify Live Stage template embeds the new [长期] pill class with zero innerHTML
    const stageHtml = renderLiveStageHtml({
      state: null,
      avatarDataUri: 'data:image/png;base64,iVBORw0KGgo=',
      assets: {
        assetRoot: path.join(repoRoot, 'public/live-stage'),
        fallbackAvatarDataUri: 'data:image/png;base64,iVBORw0KGgo=',
      },
    });
    assert.match(stageHtml, /task-hud-longterm-pill/);
    assert.doesNotMatch(stageHtml, /\.innerHTML\s*=/);
  } finally {
    try { sqliteStore.close?.(); } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
