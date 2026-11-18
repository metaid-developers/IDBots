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
const { SqliteStore } = require('../dist-electron/main/sqliteStore.js');
const { StudioDecisionQueueStore } = require('../dist-electron/main/studioDecisionQueueStore.js');
const { StudioChiefOfStaffService } = require('../dist-electron/main/services/studioChiefOfStaffService.js');
const { LongTermTaskStore } = require('../dist-electron/main/longTermTaskStore.js');
const { OrchestrationStore } = require('../dist-electron/main/orchestrationStore.js');
const { TwinOrchestrationService } = require('../dist-electron/main/services/twinOrchestrationService.js');
const {
  createLiveStageState,
  reduceLiveStageMessage,
  completeLiveStage,
  reportReadyLiveStage,
  markdownToPlainText,
} = require('../dist-electron/main/services/studioLiveStageModel.js');
const { buildStudioDecisionReportHtml } = require('../dist-electron/main/libs/studioDecisionReportHtml.js');
Module._load = originalLoad;

function disposeTempStore(sqliteStore, dir) {
  try { sqliteStore?.close?.(); } catch { /* ignore */ }
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

async function createSqliteHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-studio-cos-polish-'));
  const sqliteStore = await SqliteStore.create(dir);
  return { dir, sqliteStore, db: sqliteStore.getDatabase(), saveDb: sqliteStore.getSaveFunction() };
}

test('Issue 1 & 6: Live Stage measures live DOM card endpoints, paints no duplicate single-worker bubble, drops orphan connectors, strips <studio_*> tags, and preserves speechRest + reportUri', () => {
  const stageJs = fs.readFileSync(path.resolve('public/live-stage/stage.js'), 'utf8');
  const stageScenes = fs.readFileSync(path.resolve('public/live-stage/stage-scenes.js'), 'utf8');
  const stageHtml = fs.readFileSync(path.resolve('public/live-stage/stage.html'), 'utf8');
  const stageCss = fs.readFileSync(path.resolve('public/live-stage/stage.css'), 'utf8');

  // Exact DOM-measured endpoints: connector anchors come from the measured
  // rail item rects walked up to .live-stage offsets — never guessed percentages:
  assert.match(stageScenes, /function itemRect\(el\) \{\s*const stage = M\.rail\.offsetParent/);
  assert.match(stageScenes, /function itemAnchor\(el\) \{\s*const r = itemRect\(el\)/);
  assert.match(stageScenes, /function avatarAnchor\(el\)/);
  assert.match(stageScenes, /M\.items\.get\(`\$\{M\.hero\.type\}:\$\{id\}`\)/, 'hero connectors only anchor rail items that exist');
  assert.doesNotMatch(stageJs, /height \* \(\.22 \+ index \* \.11\)/, 'guessed percentage Y anchors retired');
  assert.doesNotMatch(stageHtml, /hybrid/, 'no .hybrid-worker bubble in the template at all');
  assert.match(stageScenes, /resting && dir === 'return'/, 'completed turns never leave stale return connectors');

  // Focused task highlighted on top + collapsible background tasks:
  assert.match(stageJs, /task-hud-current-pill/);
  assert.match(stageJs, /task-hud-more-toggle/);
  assert.match(stageCss, /\.task-hud-row\.is-current\{/);
  assert.match(stageCss, /body\[data-has-report="true"\]\[data-family="complete"\] \.core-report-ready/);
  assert.match(stageCss, /body\[data-speech-rest="true"\] \.core-copy/);
  assert.doesNotMatch(stageJs, /innerHTML|insertAdjacentHTML|document\.write/);
  assert.doesNotMatch(stageScenes, /innerHTML|insertAdjacentHTML|document\.write/);

  // Internal <studio_proactive_briefing> never flashes on Live Stage:
  const initial = createLiveStageState({
    sessionId: 's1',
    turnId: 't1',
    botName: 'AI_Sunny',
    language: 'zh',
    directorEnabled: false,
    nowMs: 1000,
  });
  const afterInternal = reduceLiveStageMessage(initial, {
    id: 'm-internal',
    type: 'user',
    content: '<studio_proactive_briefing>\n你现在正在主人的 Studio 常驻主会话中主动发起一次汇报</studio_proactive_briefing>',
    timestamp: 1001,
    metadata: { isDelegationInternal: true, origin: 'studio_briefing' },
  });
  assert.equal(afterInternal, initial, 'internal studio_briefing trigger must not mutate Live Stage');
  assert.equal(
    markdownToPlainText('<studio_proactive_briefing>secret</studio_proactive_briefing>Hello world'),
    'Hello world',
  );

  // reportUri + speechRest survive speaking -> complete so "打开汇报" button and headline font stay steady:
  const withReport = reportReadyLiveStage(initial, 'preview-metaapp://localhost/tmp/reports/a.html', 1200);
  const speaking = reduceLiveStageMessage(withReport, {
    id: 'm-ans',
    type: 'assistant',
    content: '第一篇已按正稿上链发布，右侧大屏有收口详情。',
    timestamp: 1300,
  });
  assert.equal(speaking.family, 'speaking');
  assert.equal(speaking.reportUri, 'preview-metaapp://localhost/tmp/reports/a.html');
  const completed = completeLiveStage(speaking, 1400);
  assert.equal(completed.family, 'complete');
  assert.equal(completed.speechRest, true, 'speechRest keeps speaking font metrics on complete');
  assert.equal(completed.reportUri, 'preview-metaapp://localhost/tmp/reports/a.html', 'reportUri survives into complete');
});

test('Issue 3: auto-resolved stale queue item does NOT overwrite the right-hand projector, while genuine presenting item projects AFTER turn', async () => {
  const { dir, sqliteStore, db, saveDb } = await createSqliteHarness();
  try {
    const queue = new StudioDecisionQueueStore(db, saveDb);
    const sessions = new Map([
      ['studio-1', {
        id: 'studio-1',
        title: 'Studio',
        sessionType: 'browser',
        assistantMode: true,
        metabotId: 1,
        status: 'idle',
        updatedAt: 1000,
        messages: [],
      }],
    ]);
    const projected = [];
    let autoResolveInTurn = true;

    const cos = new StudioChiefOfStaffService({
      decisionQueueStore: () => queue,
      coworkStore: () => ({
        getSession: (id) => sessions.get(id) ?? null,
        listSessions: () => [...sessions.values()],
        createSession: () => { throw new Error('unused'); },
        updateSession: () => {},
        addMessage: (id, m) => {
          const msg = { id: `m-${Date.now()}`, timestamp: Date.now(), ...m };
          sessions.get(id).messages.push(msg);
          return msg;
        },
      }),
      coworkRunner: () => ({
        isSessionActive: () => false,
        startSession: async () => {
          const presenting = queue.getPresenting(1);
          if (autoResolveInTurn && presenting) {
            // Simulate Twin recognizing the owner already ruled "暂不动代码" and auto-closing!
            queue.resolve(presenting.id, 'Already ruled by owner earlier');
          }
        },
      }),
      resolveTwinMetabotId: () => 1,
      resolveTwinWorkspace: () => dir,
      getPreferredStudioSessionId: () => 'studio-1',
      projectShowcaseHtml: async (input) => {
        projected.push(input);
      },
      idleDebounceMs: 0,
    });

    // Case 1: Stale re-queued item auto-resolved by Twin -> ZERO right-screen overwrite!
    queue.enqueue({
      dedupeKey: 'stale-1',
      twinMetabotId: 1,
      originStudioSessionId: 'studio-1',
      longtermTaskId: 'ltt_same',
      kind: 'decision',
      title: 'Stale wallet question',
      backgroundSummary: 'bg',
      progressSummary: 'prog',
      question: 'Adopt rec 2?',
      recommendation: 'no',
      nextStep: 'done',
    });
    assert.equal(queue.hasRecentOrOpenForTask(1, 'ltt_same'), true, 'blocks duplicate ltt_wait_owner enqueue');

    const res1 = await cos.runHeartbeatTick();
    assert.equal(res1.presentedItemId, null);
    assert.equal(projected.length, 0, 'must NOT overwrite right-hand projector when Twin auto-resolves stale item');
    assert.equal(queue.hasRecentOrOpenForTask(1, 'ltt_same'), true, 'recently resolved task stays guarded against duplicate auto-enqueue');

    // Case 2: Genuine new decision kept in presenting -> projects clean executive HTML!
    autoResolveInTurn = false;
    queue.enqueue({
      dedupeKey: 'genuine-2',
      twinMetabotId: 1,
      originStudioSessionId: 'studio-1',
      longtermTaskId: 'ltt_new',
      kind: 'acceptance',
      title: 'Drafts Verified · Drafts Verified',
      backgroundSummary: 'Two drafts.',
      progressSummary: 'Progress: 1/1 accepted',
      question: 'Confirm final drafts?',
      recommendation: 'Confirm.',
      nextStep: 'Continue advancing the Managed Task Tree upon your ruling.',
      evidence: [{ kind: 'pin', uri: 'pin://' + 'b'.repeat(64) + 'i0', note: 'Published by AI_Sunny' }],
    });

    const res2 = await cos.runHeartbeatTick();
    assert.ok(res2.presentedItemId);
    assert.equal(projected.length, 1, 'genuine presenting item projects onto showcase');
    const html = fs.readFileSync(projected[0].localPath, 'utf8');
    assert.doesNotMatch(html, /Drafts Verified · Drafts Verified/, 'deduplicates identical Title · Title');
    assert.doesNotMatch(html, /Continue advancing the Managed Task Tree/, 'cleans machine English fallback');
    assert.match(html, /已完成核验子项 1 \/ 1/);
    assert.match(html, new RegExp(`href="pin://${'b'.repeat(64)}i0"`), 'renders clickable verbatim pin:// URI');
  } finally {
    disposeTempStore(sqliteStore, dir);
  }
});

test('Issue 6b & Stamp Receipt: local_worker_delegate auto-coerces ltt_/lts_ passed in taskId/stepId, and stamp receipt shows publisher account + verbatim pin://', async () => {
  const { dir, sqliteStore, db, saveDb } = await createSqliteHarness();
  try {
    const metabots = [
      { id: 1, name: 'AI_Sunny', metabot_type: 'twin', enabled: true, boss_global_metaid: 'idq1owner', globalmetaid: 'idq1sunnytwin', mvc_address: '1SunnyAddr', skills: [] },
      { id: 3, name: 'loop', metabot_type: 'worker', enabled: true, boss_global_metaid: 'idq1owner', skills: [] },
    ];
    const ltStore = new LongTermTaskStore(db, saveDb);
    const orchStore = new OrchestrationStore(db, saveDb);
    const queue = new StudioDecisionQueueStore(db, saveDb);

    const quick = ltStore.createQuickTask({ title: 'Two research drafts', definitionSessionId: 'studio-1' }, 'twin');
    const lttId = quick.value.id;
    const ltsId = quick.value.subtasks[0].id;

    const orchService = new TwinOrchestrationService({
      orchestrationStore: orchStore,
      coworkStore: { getSession: () => ({ id: 'studio-1', sessionType: 'browser', assistantMode: true, metabotId: 1 }) },
      coworkRunner: { insertCrossSessionMessageAndQueue: () => ({ insert: { ok: true, message: {} }, runQueued: true }) },
      longTermTaskStore: () => ltStore,
      isStudioSourceSession: () => true,
      onStudioWorkerTerminalState: () => true,
      directory: {
        getSession: () => ({ metabotId: 1 }),
        listMetabots: () => metabots,
        getOwnerGlobalMetaId: () => 'idq1owner',
      },
      getMetabotById: (id) => metabots.find((b) => b.id === id) ?? null,
      getWorkerWorkspace: () => dir,
      runWorkerTurn: async (params) => {
        await params.onSessionCreated('ws-loop');
        return 'ok\n<worker_handoff>{"state":"ready","summary":"done","deliverables":[],"verificationEvidence":[],"blockers":[],"humanAction":null}</worker_handoff>';
      },
    });

    // Pass ltt_... in taskId and lts_... in stepId (exact mistake from session fbe4ab7b [14]-[17]):
    const delegated = await orchService.delegateLocalWorker('studio-1', {
      workerMetabotId: 3,
      taskId: lttId,
      stepId: ltsId,
      objective: 'Write draft 01',
      idempotencyKey: 'coerce-ltt-1',
    });
    assert.equal(delegated.task.longtermTaskId, lttId, 'coerced ltt_ into longtermTaskId without throwing ORCHESTRATION_TASK_NOT_FOUND');
    assert.equal(delegated.task.longtermSubtaskId, ltsId, 'coerced lts_ into longtermSubtaskId without throwing ORCHESTRATION_STEP_NOT_FOUND');

    for (let i = 0; i < 30 && orchStore.getTask(delegated.task.id)?.status !== 'review'; i += 1) {
      await new Promise((r) => setTimeout(r, 15));
    }

    // Verify Twin Stamp Publish includes Publisher Account + verbatim pin:// ID:
    const articlePath = path.join(dir, '01-final.md');
    fs.writeFileSync(articlePath, '# Studio vs Coding Agent\n\nClean body.', 'utf8');
    const pinId = `${'c'.repeat(64)}i0`;
    const cos = new StudioChiefOfStaffService({
      decisionQueueStore: () => queue,
      coworkStore: () => ({ getSession: () => null, createSession: () => ({ id: 'x' }), updateSession: () => {}, addMessage: () => ({ id: 'm' }) }),
      coworkRunner: () => ({ isSessionActive: () => false, startSession: async () => {} }),
      resolveTwinMetabotId: () => 1,
      resolveTwinWorkspace: () => dir,
      resolvePublisherIdentity: () => ({
        name: 'AI_Sunny',
        role: 'Twin 分身',
        globalMetaId: 'idq1sunnytwin',
        address: '1SunnyAddr',
      }),
      createPin: async () => ({ pinId, totalCost: 8586 }),
    });
    await cos.dispatchTwinStampPublish('studio-1', {
      items: [{ protocol: 'simplenote', sourceFilePath: articlePath }],
      approvalNote: 'Owner approved final article',
    });
    for (let i = 0; i < 30 && queue.listOpen(1).length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 15));
    }
    const receiptItem = queue.listOpen(1)[0];
    assert.match(receiptItem.progressSummary, /AI_Sunny \(Twin 分身\)/);
    assert.match(receiptItem.progressSummary, /idq1sunnytwin/);
    assert.match(receiptItem.progressSummary, new RegExp(`pin://${pinId}`));
    const receiptHtml = fs.readFileSync(receiptItem.reportHtmlPath, 'utf8');
    assert.match(receiptHtml, /AI_Sunny \(Twin 分身\)/);
    assert.match(receiptHtml, new RegExp(`pin://${pinId}`));
  } finally {
    disposeTempStore(sqliteStore, dir);
  }
});
