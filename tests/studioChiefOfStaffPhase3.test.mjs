import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';

const require = Module.createRequire(import.meta.url);
const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') {
    return {
      app: {
        isPackaged: false,
        getAppPath: () => process.cwd(),
        getPath: () => process.cwd(),
      },
    };
  }
  return originalLoad.apply(this, arguments);
};
const { createStudioLiveStageService } = require('../dist-electron/main/services/studioLiveStageService.js');
const { buildStudioDecisionReportHtml } = require('../dist-electron/main/libs/studioDecisionReportHtml.js');
Module._load = originalLoad;

test('buildStudioDecisionReportHtml produces a self-contained executive briefing page with queue position, progress bar, options, and evidence', () => {
  const html = buildStudioDecisionReportHtml({
    item: {
      id: 'sdq_1',
      dedupeKey: 'k1',
      twinMetabotId: 1,
      originStudioSessionId: 'studio-1',
      orchestrationTaskId: 'ot-1',
      longtermTaskId: 'ltt-1',
      longtermSubtaskId: 'lts-1',
      kind: 'decision',
      priority: 100,
      title: '07 Mobile Article Wording',
      backgroundSummary: 'Writing 8-part AI Internet tutorial series.',
      progressSummary: 'Lucy, Aming, Xiaoxin finished 6/6 drafts.',
      question: 'Use conservative "Not yet listed" wording for iOS?',
      options: [
        { label: 'Not yet listed', description: 'Durable on-chain', recommended: true },
        { label: 'In App Store review', description: 'Will age poorly' },
      ],
      recommendation: 'Choose option 1 so the immutable pin never goes stale.',
      nextStep: 'Twin stamp-publishes all 6 tutorials + index.',
      reportHtmlPath: null,
      evidence: [{ kind: 'dir', uri: '/tmp/bots/2/07.md', note: '1904 CJK chars' }],
      status: 'presenting',
      presentedSessionId: 'studio-1',
      presentedAt: '2026-11-15T10:00:00.000Z',
      resolvedAt: null,
      resolutionNote: null,
      createdAt: '2026-11-15T10:00:00.000Z',
      updatedAt: '2026-11-15T10:00:00.000Z',
    },
    queuePosition: 1,
    queueTotal: 3,
    taskProgress: { accepted: 3, total: 4, percent: 75 },
    language: 'zh',
  });

  assert.match(html, /需要你拍板/);
  assert.match(html, /待拍板队列 1 \/ 3/);
  assert.match(html, /3 \/ 4 \(75%\)/);
  assert.match(html, /首推/);
  assert.match(html, /\/tmp\/bots\/2\/07\.md/);
  assert.doesNotMatch(html, /https?:\/\//, 'self-contained with zero external assets');
});

test('StudioLiveStageService streams multi-Worker directional flows and live task-tree HUD updates via refreshChiefOfStaffHud', async () => {
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-cos-stage-p3-'));
  try {
    const patches = [];
    let boundUri = null;
    let workers = [
      { id: 'a1', name: 'Lucy', direction: 'dispatch', title: '02/03 articles', startedAt: 1000 },
      { id: 'a2', name: 'Aming', direction: 'working', title: '05/06 articles', startedAt: 1000 },
      { id: 'a3', name: 'Xiaoxin', direction: 'return', title: '04/07 articles', startedAt: 1000 },
    ];
    let hud = {
      queuedDecisions: 1,
      tasks: [
        { id: 'ltt_1', title: 'IDBots Tutorial Series', state: 'in_progress', accepted: 1, total: 3, currentSubtask: 'Write 02-07' },
      ],
    };

    const service = createStudioLiveStageService({
      getSession: (id) => (id === 'studio-1'
        ? { id: 'studio-1', sessionType: 'browser', assistantMode: true, metabotId: 1, metabotName: 'AI_Sunny' }
        : null),
      getMetabotById: () => ({ name: 'AI_Sunny', avatar: 'data:image/png;base64,AA==' }),
      getSettings: () => ({ enabled: true, directorEnabled: false }),
      getLanguage: () => 'zh',
      project: async (input) => {
        boundUri = `preview-metaapp://localhost${input.localPath}`;
        return { uri: boundUri, tabId: 11, announced: true };
      },
      getStageTab: async () => (boundUri ? { id: 11, uri: boundUri } : null),
      applyPatch: async (input) => {
        patches.push(input.state);
      },
      listCollaboratingWorkers: () => workers,
      getLiveTaskHud: () => hud,
      stageRoot,
      assetRoot: path.resolve('public/live-stage'),
      fallbackAvatarDataUri: 'data:image/png;base64,AA==',
      projectionRetryBackoffMs: [5],
    });

    service.observeMessage('studio-1', {
      id: 'u1',
      type: 'user',
      content: 'Write tutorials',
      timestamp: 1000,
    });

    for (let i = 0; i < 40 && patches.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 15));
    }
    assert.ok(patches.length >= 1);

    // Simulate background subtask completion + decision queue update without any chat message!
    hud = {
      queuedDecisions: 2,
      tasks: [
        { id: 'ltt_1', title: 'IDBots Tutorial Series', state: 'waiting_owner', accepted: 3, total: 3, currentSubtask: 'Final stamp' },
      ],
    };
    const countBefore = patches.length;
    service.refreshChiefOfStaffHud('studio-1');

    for (let i = 0; i < 40 && patches.length <= countBefore; i += 1) {
      await new Promise((r) => setTimeout(r, 15));
    }

    const latest = patches.at(-1);
    assert.equal(latest.activeWorkers.length, 3);
    assert.deepEqual(
      latest.activeWorkers.map((w) => [w.name, w.direction]),
      [['Lucy', 'dispatch'], ['Aming', 'working'], ['Xiaoxin', 'return']],
    );
    assert.equal(latest.taskHud.queuedDecisions, 2);
    assert.equal(latest.taskHud.tasks[0].accepted, 3);
    assert.equal(latest.taskHud.tasks[0].state, 'waiting_owner');

    service.dispose();
  } finally {
    try {
      fs.rmSync(stageRoot, { recursive: true, force: true });
    } catch {
      // Tolerant Windows CI cleanup.
    }
  }
});

test('Live Stage template carries the companion rail and task HUD elements with zero innerHTML', () => {
  const html = fs.readFileSync(path.resolve('public/live-stage/stage.html'), 'utf8');
  const js = fs.readFileSync(path.resolve('public/live-stage/stage.js'), 'utf8');
  const scenes = fs.readFileSync(path.resolve('public/live-stage/stage-scenes.js'), 'utf8');
  const css = fs.readFileSync(path.resolve('public/live-stage/stage.css'), 'utf8');

  assert.match(html, /data-companion-rail/);
  assert.match(html, /data-task-hud/);
  assert.match(scenes, /function buildRail\(\)/);
  assert.match(js, /function updateTaskHud\(\)/);
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(scenes, /innerHTML|insertAdjacentHTML|document\.write/);
  assert.match(css, /\.companion-rail\{/);
  assert.match(css, /\.task-hud\{/);
});
