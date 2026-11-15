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
const { OrchestrationStore } = require('../dist-electron/main/orchestrationStore.js');
const { TwinOrchestrationService } = require('../dist-electron/main/services/twinOrchestrationService.js');
const { StudioDecisionQueueStore } = require('../dist-electron/main/studioDecisionQueueStore.js');
const {
  deriveStudioPresenceState,
  StudioPresenceTracker,
} = require('../dist-electron/main/services/studioPresenceState.js');
const { evaluateStudioTwinToolGuard } = require('../dist-electron/main/libs/studioToolGuard.js');
const { StudioChiefOfStaffService } = require('../dist-electron/main/services/studioChiefOfStaffService.js');
Module._load = originalLoad;

function disposeTempStore(sqliteStore, dir) {
  try {
    sqliteStore?.close?.();
  } catch {
    // Ignore close errors.
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Tolerant Windows CI cleanup (AGENTS.md §Test Discipline).
  }
}

async function createSqliteHarness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-studio-cos-p1-'));
  const sqliteStore = await SqliteStore.create(dir);
  return { dir, sqliteStore, db: sqliteStore.getDatabase(), saveDb: sqliteStore.getSaveFunction() };
}

test('StudioDecisionQueueStore enforces dedup, serial single-presenting lock, owner preemption defer, and resolution', async () => {
  const { dir, sqliteStore, db, saveDb } = await createSqliteHarness();
  try {
    const queue = new StudioDecisionQueueStore(db, saveDb);

    const first = queue.enqueue({
      dedupeKey: 'task-a:ruling-1',
      twinMetabotId: 1,
      originStudioSessionId: 'studio-1',
      kind: 'decision',
      title: 'iOS copy ruling',
      backgroundSummary: 'Tutorial 07 is drafted.',
      progressSummary: '6/6 articles verified.',
      question: 'How should we state iOS App Store status?',
      options: [
        { label: 'Not yet listed', description: 'Holds across stages', recommended: true },
        { label: 'In review', description: 'Stage-dependent' },
      ],
      recommendation: 'Not yet listed — stays accurate permanently on-chain.',
      nextStep: 'Finalize 07 and stamp-publish all 6 notes.',
    });
    assert.equal(first.reused, false);
    assert.equal(first.item.status, 'queued');

    // Duplicate enqueue with same dedupeKey updates in place without adding a second row.
    const dup = queue.enqueue({
      dedupeKey: 'task-a:ruling-1',
      twinMetabotId: 1,
      originStudioSessionId: 'studio-1',
      kind: 'decision',
      title: 'iOS copy ruling (updated)',
      backgroundSummary: 'Tutorial 07 is drafted.',
      progressSummary: '6/6 articles verified.',
      question: 'How should we state iOS App Store status?',
      recommendation: 'Not yet listed.',
      nextStep: 'Stamp publish.',
    });
    assert.equal(dup.reused, true);
    assert.equal(dup.item.id, first.item.id);
    assert.equal(dup.item.title, 'iOS copy ruling (updated)');

    // Enqueue a second independent item.
    const second = queue.enqueue({
      dedupeKey: 'task-b:acceptance',
      twinMetabotId: 1,
      originStudioSessionId: 'studio-1',
      kind: 'acceptance',
      title: 'Accept MetaApp v2',
      backgroundSummary: 'Requested MetaApp.',
      progressSummary: 'Built and smoke-tested.',
      question: 'Approve final MetaApp?',
      recommendation: 'Approve.',
      nextStep: 'Publish MetaApp.',
    });
    assert.equal(queue.listOpen(1).length, 2);

    // Serial lock: claiming pops #1 and refuses claiming #2 while #1 is presenting.
    const claimed1 = queue.claimNextForPresentation(1, 'studio-1');
    assert.equal(claimed1?.id, first.item.id);
    assert.equal(claimed1?.status, 'presenting');
    assert.equal(queue.claimNextForPresentation(1, 'studio-1'), null, 'must not present two items simultaneously');

    // Owner preemption: deferring returns #1 to the front of the queue (priority <= 0).
    const deferred = queue.deferPresenting(1);
    assert.equal(deferred?.id, first.item.id);
    assert.equal(deferred?.status, 'queued');
    assert.ok(deferred.priority <= 0);

    // Next claim brings #1 back before #2; resolving #1 then unblocks #2.
    const reclaimed = queue.claimNextForPresentation(1, 'studio-1');
    assert.equal(reclaimed?.id, first.item.id);
    const resolved = queue.resolve(first.item.id, 'Use conservative wording');
    assert.equal(resolved?.status, 'resolved');

    const claimed2 = queue.claimNextForPresentation(1, 'studio-1');
    assert.equal(claimed2?.id, second.item.id);
  } finally {
    disposeTempStore(sqliteStore, dir);
  }
});

test('deriveStudioPresenceState strictly gates shaping vs briefing vs idle', () => {
  const tracker = new StudioPresenceTracker();
  tracker.markShapingHold('studio-1', 'clarifying target audience', 1_000, 60_000);

  const shaping = deriveStudioPresenceState({
    activeStudioSessionId: 'studio-1',
    studioTurnRunning: false,
    briefingTurnRunning: false,
    hasDefiningDraftInStudio: false,
    explicitShapingHoldReason: tracker.getActiveShapingHoldReason('studio-1', 2_000),
    lastNonBriefingTurnEndedAtMs: null,
    presentingItem: null,
    queuedCount: 3,
    nowMs: 2_000,
  });
  assert.equal(shaping.mode, 'shaping', 'explicit shaping hold blocks queued briefings');

  tracker.clearShapingHold('studio-1');
  tracker.recordNonBriefingTurnEnd('studio-1', 10_000);

  const debouncing = deriveStudioPresenceState({
    activeStudioSessionId: 'studio-1',
    studioTurnRunning: false,
    briefingTurnRunning: false,
    hasDefiningDraftInStudio: false,
    explicitShapingHoldReason: null,
    lastNonBriefingTurnEndedAtMs: tracker.getLastNonBriefingTurnEndedAtMs('studio-1'),
    presentingItem: null,
    queuedCount: 3,
    nowMs: 12_000,
    idleDebounceMs: 8_000,
  });
  assert.equal(debouncing.mode, 'shaping', 'debounce window prevents immediate post-turn collision');

  const idle = deriveStudioPresenceState({
    activeStudioSessionId: 'studio-1',
    studioTurnRunning: false,
    briefingTurnRunning: false,
    hasDefiningDraftInStudio: false,
    explicitShapingHoldReason: null,
    lastNonBriefingTurnEndedAtMs: tracker.getLastNonBriefingTurnEndedAtMs('studio-1'),
    presentingItem: null,
    queuedCount: 3,
    nowMs: 20_000,
    idleDebounceMs: 8_000,
  });
  assert.equal(idle.mode, 'idle');
});

test('evaluateStudioTwinToolGuard blocks direct code/article authoring in Studio chat while whitelisting projector reports/*.html', () => {
  const workspace = path.join(os.tmpdir(), 'bot-1-workspace');

  const blockedArticle = evaluateStudioTwinToolGuard({
    isStudioTwinFrontOffice: true,
    toolName: 'write',
    toolInput: { file_path: path.join(workspace, 'idbots-tutorial', '02-article.md') },
    workspaceRoot: workspace,
  });
  assert.equal(blockedArticle.action, 'deny');
  assert.match(blockedArticle.reason, /local_worker_delegate/);

  const blockedRepoEdit = evaluateStudioTwinToolGuard({
    isStudioTwinFrontOffice: true,
    toolName: 'edit',
    toolInput: { file_path: path.join(workspace, 'src', 'index.ts') },
    workspaceRoot: workspace,
  });
  assert.equal(blockedRepoEdit.action, 'deny');

  const allowedProjectorPage = evaluateStudioTwinToolGuard({
    isStudioTwinFrontOffice: true,
    toolName: 'write',
    toolInput: { file_path: path.join(workspace, 'reports', '2026-11-15-plan.html') },
    workspaceRoot: workspace,
  });
  assert.equal(allowedProjectorPage.action, 'allow');

  const allowedRead = evaluateStudioTwinToolGuard({
    isStudioTwinFrontOffice: true,
    toolName: 'read',
    toolInput: { file_path: path.join(workspace, 'src', 'index.ts') },
    workspaceRoot: workspace,
  });
  assert.equal(allowedRead.action, 'allow');

  const allowedWorkerSession = evaluateStudioTwinToolGuard({
    isStudioTwinFrontOffice: false,
    toolName: 'write',
    toolInput: { file_path: path.join(workspace, '02-article.md') },
    workspaceRoot: workspace,
  });
  assert.equal(allowedWorkerSession.action, 'allow');
});

test('Studio delegation completion suppresses [ORCH-NOTIFY] in Studio chat, runs silent back-office supervision, and pushes queued briefing + projector report only when idle', async () => {
  const { dir, sqliteStore, db, saveDb } = await createSqliteHarness();
  try {
    const orchestrationStore = new OrchestrationStore(db, saveDb);
    const decisionQueueStore = new StudioDecisionQueueStore(db, saveDb);

    const sessions = new Map();
    sessions.set('studio-main', {
      id: 'studio-main',
      title: 'Persistent Twin Chat',
      sessionType: 'browser',
      assistantMode: true,
      metabotId: 1,
      status: 'idle',
      updatedAt: 1_000,
      messages: [],
    });

    const crossSessionInsertedIntoStudio = [];
    const runnerCalls = [];
    const projectedPages = [];
    let studioBusy = false;

    const fakeCoworkStore = {
      getSession: (id) => sessions.get(id) ?? null,
      listSessions: () => [...sessions.values()],
      createSession: (title, cwd, systemPrompt, executionMode, activeSkillIds, metabotId, sessionType) => {
        const id = `sup-${sessions.size + 1}`;
        const created = {
          id,
          title,
          cwd,
          systemPrompt: systemPrompt ?? '',
          executionMode: executionMode ?? 'local',
          activeSkillIds: activeSkillIds ?? [],
          metabotId,
          sessionType: sessionType ?? 'standard',
          status: 'idle',
          updatedAt: 2_000,
          messages: [],
        };
        sessions.set(id, created);
        return created;
      },
      setSessionAutoOrigin: (id, origin) => {
        const s = sessions.get(id);
        if (s) s.autoOrigin = origin;
      },
      updateSession: (id, updates) => {
        const s = sessions.get(id);
        if (s) Object.assign(s, updates);
      },
      addMessage: (id, message) => {
        const msg = { id: `m-${Math.random().toString(36).slice(2)}`, timestamp: Date.now(), ...message };
        const s = sessions.get(id);
        if (s) s.messages.push(msg);
        return msg;
      },
    };

    const reportPath = path.join(dir, 'reports', 'briefing-1.html');
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, '<!DOCTYPE html><html><body>Briefing</body></html>', 'utf8');

    const fakeRunner = {
      isSessionActive: (sid) => sid === 'studio-main' && studioBusy,
      startSession: async (sid, prompt, options) => {
        runnerCalls.push({ sid, prompt, options });
        if (sid.startsWith('sup-')) {
          // Simulate back-office Twin verifying the Worker output and enqueuing an owner decision!
          decisionQueueStore.enqueue({
            dedupeKey: 'tutorial-ruling',
            twinMetabotId: 1,
            originStudioSessionId: 'studio-main',
            kind: 'decision',
            title: 'Tutorial Series Final Ruling',
            backgroundSummary: 'All 6 articles verified.',
            progressSummary: 'Lucy, Aming, Xiaoxin delivered 6/6.',
            question: 'Confirm iOS status wording before Twin stamp publish?',
            recommendation: 'Use "Not yet listed".',
            nextStep: 'Stamp publish all 6 notes.',
            reportHtmlPath: reportPath,
          });
        }
      },
    };

    const kvMap = new Map();
    const kv = {
      get: (k) => kvMap.get(k),
      set: (k, v) => kvMap.set(k, v),
      delete: (k) => kvMap.delete(k),
    };

    const cosService = new StudioChiefOfStaffService({
      decisionQueueStore: () => decisionQueueStore,
      coworkStore: () => fakeCoworkStore,
      coworkRunner: () => fakeRunner,
      resolveTwinMetabotId: () => 1,
      resolveTwinWorkspace: () => dir,
      getPreferredStudioSessionId: () => 'studio-main',
      projectShowcaseHtml: async (input) => {
        projectedPages.push(input);
      },
      kv,
      supervisionCoalesceMs: 0,
      idleDebounceMs: 0,
    });

    const metabots = [
      { id: 1, name: 'Sunny', metabot_type: 'twin', enabled: true, boss_global_metaid: 'idq1owner', skills: [] },
      { id: 2, name: 'Xiaoxin', metabot_type: 'worker', enabled: true, boss_global_metaid: 'idq1owner', skills: [] },
    ];

    const orchService = new TwinOrchestrationService({
      orchestrationStore,
      coworkStore: fakeCoworkStore,
      coworkRunner: fakeRunner,
      directory: {
        getSession: (id) => sessions.get(id) ?? null,
        listMetabots: () => metabots,
        getOwnerGlobalMetaId: () => 'idq1owner',
      },
      getMetabotById: (id) => metabots.find((b) => b.id === id) ?? null,
      getWorkerWorkspace: () => dir,
      runWorkerTurn: async (params) => {
        await params.onSessionCreated('worker-session-99');
        return 'Draft finished.\n<worker_handoff>{"state":"ready","summary":"Wrote 04 and 07","deliverables":["07.md"],"verificationEvidence":["line check"],"blockers":[],"humanAction":"Confirm iOS App Store wording"}</worker_handoff>';
      },
      insertCrossSessionUserMessage: (input) => {
        crossSessionInsertedIntoStudio.push(input);
        return { ok: true, sourceSessionId: input.sourceSessionId, targetSessionId: input.targetSessionId, message: { id: 'x', type: 'user', content: input.message, timestamp: 1, metadata: null } };
      },
      onStudioWorkerTerminalState: (event) => cosService.onStudioWorkerTerminalState(event),
      kv,
    });

    // Owner is currently busy shaping a second task in Studio!
    studioBusy = true;
    const delegated = await orchService.delegateLocalWorker('studio-main', {
      workerMetabotId: 2,
      objective: 'Write 04 and 07 tutorials',
      idempotencyKey: 'studio-cos-test-1',
    });

    // Wait for async worker settlement + back-office supervision turn to complete.
    for (let i = 0; i < 40 && decisionQueueStore.listOpen(1).length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }

    assert.equal(orchestrationStore.getTask(delegated.task.id).status, 'review');
    assert.equal(
      crossSessionInsertedIntoStudio.length,
      0,
      'ZERO [ORCH-NOTIFY] messages may ever be injected into the Studio front-office session',
    );
    assert.equal(sessions.get('studio-main').messages.length, 0, 'Studio transcript stays completely clean');
    assert.equal(runnerCalls.length, 1, 'silent back-office supervision session ran instead');
    assert.match(runnerCalls[0].sid, /^sup-/);
    assert.equal(decisionQueueStore.listOpen(1).length, 1, 'supervision enqueued 1 owner decision');

    // While owner is still busy shaping Task #2 in Studio, heartbeat MUST hold silent!
    const whileBusy = await cosService.runHeartbeatTick();
    assert.equal(whileBusy.presentedItemId, null);
    assert.equal(whileBusy.presence.mode, 'shaping');
    assert.equal(projectedPages.length, 0);

    // Owner finishes talking -> Studio becomes idle -> next heartbeat proactively presents & projects!
    studioBusy = false;
    const whenIdle = await cosService.runHeartbeatTick();
    assert.ok(whenIdle.presentedItemId, 'queued item popped and presented once Studio became idle');
    assert.equal(projectedPages.length, 1, 'HTML briefing projected to right-hand showcase screen');
    assert.equal(projectedPages[0].localPath, reportPath);
    assert.equal(sessions.get('studio-main').messages.length, 1);
    assert.equal(sessions.get('studio-main').messages[0].metadata.isDelegationInternal, true, 'trigger prompt hidden from chat UI');

    // Test Twin Stamp Publish ("总裁办盖章上链"):
    const articleFile = path.join(dir, '07-final.md');
    fs.writeFileSync(articleFile, '# Mobile Same Bot\n\nVerified body text.', 'utf8');
    const publishedPins = [];
    const cosWithChain = new StudioChiefOfStaffService({
      decisionQueueStore: () => decisionQueueStore,
      coworkStore: () => fakeCoworkStore,
      coworkRunner: () => fakeRunner,
      resolveTwinMetabotId: () => 1,
      resolveTwinWorkspace: () => dir,
      createPin: async (metabotId, payload) => {
        publishedPins.push({ metabotId, payload });
        return { pinId: `${'a'.repeat(64)}i0`, totalCost: 5000 };
      },
      supervisionCoalesceMs: 0,
      idleDebounceMs: 0,
    });
    const stampRes = await cosWithChain.dispatchTwinStampPublish('studio-main', {
      items: [{ protocol: 'simplenote', sourceFilePath: articleFile }],
      approvalNote: 'Owner approved publishing 07',
      decisionQueueId: whenIdle.presentedItemId,
    });
    assert.equal(stampRes.ok, true);
    for (let i = 0; i < 40 && publishedPins.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(publishedPins.length, 1);
    assert.equal(publishedPins[0].metabotId, 1, 'signed under Twin identity');
    assert.equal(decisionQueueStore.getById(whenIdle.presentedItemId).status, 'resolved');
  } finally {
    disposeTempStore(sqliteStore, dir);
  }
});
