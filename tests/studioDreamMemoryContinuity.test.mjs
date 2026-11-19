import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';

import { createCoworkStore, createSqliteStore } from './memoryTestUtils.mjs';

const require = Module.createRequire(import.meta.url);

function withMockedElectron(fn) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, ...rest) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => process.cwd(),
        },
      };
    }
    return originalLoad.call(this, request, ...rest);
  };
  try {
    return fn();
  } finally {
    Module._load = originalLoad;
  }
}

const { DreamStore } = require('../dist-electron/main/dreamStore.js');
const { buildDreamPrompt, parseDreamOutput } = require('../dist-electron/main/libs/dreamPrompt.js');
const { extractImplicitSignals } = require('../dist-electron/main/libs/implicitSignals.js');
const { countNegativeSignalsForDay } = require('../dist-electron/main/libs/promptLayerRollback.js');
const {
  extractNegativeDecisionPoints,
  buildCounterfactualReplayPrompt,
  parseCounterfactualReplayOutput,
  pickCounterfactualWorkflowUpgrade,
} = require('../dist-electron/main/libs/counterfactualReplayPrompt.js');
const {
  buildExperiencePromptBlocksXml,
  GUIDANCE_MAX_CHARS,
} = require('../dist-electron/main/libs/experiencePromptBlocks.js');
const { buildOwnerTurnInputPrompt } = require('../dist-electron/main/libs/coworkPromptStrategy.js');
const { StudioDecisionQueueStore } = require('../dist-electron/main/studioDecisionQueueStore.js');
const { StudioChiefOfStaffService } = require('../dist-electron/main/services/studioChiefOfStaffService.js');
const { DreamService } = withMockedElectron(() => require('../dist-electron/main/services/dreamService.js'));

const LONG_IDENTITY = `我是 AI_Sunny，主人的常驻首席幕僚分身。${'我坚持一手证据核验、并行调度清晰收口，绝不拿过时流程打扰主人。'.repeat(10)}`;

const insertRawMsg = (db, { id, sessionId, type, content, metadata = {}, createdAt, sequence }) => {
  db.run(
    'INSERT INTO cowork_messages (id, session_id, type, content, metadata, created_at, sequence) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, sessionId, type, content, JSON.stringify(metadata), createdAt, sequence],
  );
};

test('DreamStore noise hygiene: strips isThinking/reassurance/turnAck, compacts <studio_proactive_briefing>, and excludes Exam/Surf/Practice sessions', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    const dreamStore = new DreamStore(db, () => {});
    const dayStart = new Date(2026, 10, 16, 0, 0, 0).getTime();
    const dayEnd = new Date(2026, 10, 17, 0, 0, 0).getTime();

    const studio = coworkStore.createSession('NFT与MRC721功能梳理', '/tmp/studio', '', 'local', [], 1, 'browser');
    db.run('UPDATE cowork_sessions SET assistant_mode = 1 WHERE id = ?', [studio.id]);
    coworkStore.archiveSession?.(studio.id);

    insertRawMsg(db, {
      id: 'm1',
      sessionId: studio.id,
      type: 'user',
      content: '先帮我盘点一下 NFT 现有能力和转换缺口',
      createdAt: dayStart + 1_000,
      sequence: 1,
    });
    insertRawMsg(db, {
      id: 'm2-ack',
      sessionId: studio.id,
      type: 'assistant',
      content: '我先去梳理代码，稍等。',
      metadata: { turnAckReply: true, isFinal: true },
      createdAt: dayStart + 1_500,
      sequence: 2,
    });
    insertRawMsg(db, {
      id: 'm3-think',
      sessionId: studio.id,
      type: 'assistant',
      content: 'Let me grep 200 files...'.repeat(400),
      metadata: { isThinking: true },
      createdAt: dayStart + 2_000,
      sequence: 3,
    });
    insertRawMsg(db, {
      id: 'm4-empty',
      sessionId: studio.id,
      type: 'assistant',
      content: '   ',
      createdAt: dayStart + 2_500,
      sequence: 4,
    });
    insertRawMsg(db, {
      id: 'm5-wait',
      sessionId: studio.id,
      type: 'assistant',
      content: '⏳ 阿码仍在后台处理当前任务（已持续约 5 分钟）',
      metadata: { waitingReassurance: true },
      createdAt: dayStart + 3_000,
      sequence: 5,
    });
    insertRawMsg(db, {
      id: 'm6-reply',
      sessionId: studio.id,
      type: 'assistant',
      content: '盘点完成：创建、转移、交易已落地，M1 转换引擎还差首枚实测。',
      createdAt: dayStart + 4_000,
      sequence: 6,
    });
    insertRawMsg(db, {
      id: 'm7-briefing',
      sessionId: studio.id,
      type: 'user',
      content: [
        '<studio_proactive_briefing>',
        '队列项 ID: sdq_1 | 类型: acceptance | 队列剩余待拍板数: 0',
        '标题: S6 转换引擎已验收（44/44）：现在开跑真实转换吗？',
        '执行规则：严禁二次追问...'.repeat(80),
        '</studio_proactive_briefing>',
      ].join('\n'),
      metadata: { isDelegationInternal: true, origin: 'studio_briefing' },
      createdAt: dayStart + 5_000,
      sequence: 7,
    });
    insertRawMsg(db, {
      id: 'm8-briefing-reply',
      sessionId: studio.id,
      type: 'assistant',
      content: '阿码交回了引擎且 44/44 全绿，现在开跑真实转换吗？',
      createdAt: dayStart + 6_000,
      sequence: 8,
    });

    // Excluded self-automation sessions (Exam, Surf, Practice) vs kept [督办] supervision session.
    const examSess = coworkStore.createSession('[编排任务] Exam 2026-11-15', '/tmp/e', '', 'local', [], 1, 'standard');
    coworkStore.setSessionAutoOrigin(examSess.id, 'orchestration');
    insertRawMsg(db, { id: 'ex1', sessionId: examSess.id, type: 'user', content: 'Frozen exam Q1', createdAt: dayStart + 7_000, sequence: 1 });

    const surfSess = coworkStore.createSession('[编排任务] MetaWeb Surf 2026-11-15', '/tmp/s', '', 'local', [], 1, 'standard');
    coworkStore.setSessionAutoOrigin(surfSess.id, 'orchestration');
    insertRawMsg(db, { id: 'sf1', sessionId: surfSess.id, type: 'assistant', content: 'Surf raw transcript', createdAt: dayStart + 8_000, sequence: 1 });

    const pracSess = coworkStore.createSession('[定时] [Practice] 更正件写作压力测试', '/tmp/p', '', 'local', [], 1, 'standard');
    coworkStore.setSessionAutoOrigin(pracSess.id, 'schedule');
    insertRawMsg(db, { id: 'pr1', sessionId: pracSess.id, type: 'assistant', content: 'Practice raw transcript', createdAt: dayStart + 9_000, sequence: 1 });

    const supSess = coworkStore.createSession('[督办] S6 转换引擎开发', '/tmp/sup', '', 'local', [], 1, 'standard');
    coworkStore.setSessionAutoOrigin(supSess.id, 'orchestration');
    insertRawMsg(db, {
      id: 'sp1',
      sessionId: supSess.id,
      type: 'user',
      content: '<studio_back_office_supervision>\n- taskIntent: S6 引擎开发\n- worker: Builder阿码 (workerSession: IDBots://w1)\n- attemptId: a1 | stepId: s1 | outcome: completed\n</studio_back_office_supervision>',
      metadata: { isDelegationInternal: true, origin: 'studio_supervision' },
      createdAt: dayStart + 10_000,
      sequence: 1,
    });
    insertRawMsg(db, {
      id: 'sp2',
      sessionId: supSess.id,
      type: 'assistant',
      content: '已逐项核验 44/44 单测通过并入队待主人拍板。',
      createdAt: dayStart + 11_000,
      sequence: 2,
    });

    const activity = dreamStore.getActivityForDate(1, dayStart, dayEnd);
    const titles = activity.sessions.map((s) => s.title);
    assert.deepEqual(titles, ['NFT与MRC721功能梳理', '[督办] S6 转换引擎开发']);

    const studioAct = activity.sessions[0];
    assert.equal(studioAct.isStudioOwner, true, 'archived Clear-Screen Studio chapter still counts as Studio owner session');
    assert.equal(studioAct.messages.length, 4, 'thinking, empty, waitingReassurance, and turnAck are all stripped');
    assert.equal(studioAct.messages[2].isSystemBriefing, true);
    assert.ok(studioAct.messages[2].content.includes('S6 转换引擎已验收'));
    assert.ok(studioAct.messages[2].content.length < 180, '3KB briefing boilerplate collapsed to a 1-line marker');

    const supAct = activity.sessions[1];
    assert.equal(supAct.autoOrigin, 'orchestration');
    assert.equal(supAct.messages[0].isSystemBriefing, true);
  } finally {
    cleanup();
  }
});

test('Multi-day persistent Studio session: incremental cursor avoids duplicate messages and attaches cross-midnight priorContextMessages', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    const dreamStore = new DreamStore(db, () => {});

    const day1 = '2026-11-16';
    const day2 = '2026-11-17';
    const day1Start = new Date(2026, 10, 16, 0, 0, 0).getTime();
    const day1End = new Date(2026, 10, 17, 0, 0, 0).getTime();
    const day2Start = day1End;
    const day2End = new Date(2026, 10, 18, 0, 0, 0).getTime();

    const studio = coworkStore.createSession('常驻 Studio 主会话', '/tmp/st', '', 'local', [], 1, 'browser');
    db.run('UPDATE cowork_sessions SET assistant_mode = 1 WHERE id = ?', [studio.id]);

    // Day 1 late night (23:14 - 23:20)
    insertRawMsg(db, {
      id: 'd1-u1',
      sessionId: studio.id,
      type: 'user',
      content: '法币环节放到最后，先用方案 A 把 #2671 转进金库跑真实转换。',
      createdAt: day1End - 45 * 60_000,
      sequence: 1,
    });
    insertRawMsg(db, {
      id: 'd1-a1',
      sessionId: studio.id,
      type: 'assistant',
      content: '#2671 已广播进金库，巡检驼峰字段热修已派给阿码，核验后向你汇报。',
      createdAt: day1End - 40 * 60_000,
      sequence: 2,
    });

    // Day 2 after midnight (00:50 - 00:54)
    insertRawMsg(db, {
      id: 'd2-u1',
      sessionId: studio.id,
      type: 'user',
      content: '你确认还没好吗',
      createdAt: day2Start + 50 * 60_000,
      sequence: 3,
    });
    insertRawMsg(db, {
      id: 'd2-a1',
      sessionId: studio.id,
      type: 'assistant',
      content: '确认好了——#2671 整段转换已完成并发货回你的钱包。',
      createdAt: day2Start + 54 * 60_000,
      sequence: 4,
    });

    // Night 1 dream slice
    const actDay1 = dreamStore.getActivityForDate(1, day1Start, day1End, undefined, { dreamDate: day1 });
    assert.equal(actDay1.sessions.length, 1);
    assert.deepEqual(actDay1.sessions[0].messages.map((m) => m.messageId), ['d1-u1', 'd1-a1']);
    assert.equal(actDay1.sessions[0].priorContextMessages, undefined);
    dreamStore.advanceSessionCursorsForDate(1, day1, actDay1.sessions);

    const cursor1 = dreamStore.getSessionCursor(1, studio.id);
    assert.equal(cursor1.lastDreamedDate, day1);
    assert.equal(cursor1.lastMessageId, 'd1-a1');

    // Night 2 dream slice: only Day 2 messages in `.messages`, plus Day 1 tail in `.priorContextMessages`!
    const actDay2 = dreamStore.getActivityForDate(1, day2Start, day2End, undefined, { dreamDate: day2 });
    assert.equal(actDay2.sessions.length, 1);
    assert.deepEqual(actDay2.sessions[0].messages.map((m) => m.messageId), ['d2-u1', 'd2-a1']);
    assert.deepEqual(
      actDay2.sessions[0].priorContextMessages.map((m) => m.messageId),
      ['d1-u1', 'd1-a1'],
      'cross-midnight Studio continuation carries preceding context anchor without re-dreaming yesterday',
    );

    const promptDay2 = buildDreamPrompt({
      botName: 'AI_Sunny',
      date: day2,
      activity: actDay2,
    });
    assert.ok(promptDay2.user.includes('跨日前情锚点'));
    assert.ok(promptDay2.user.includes('法币环节放到最后'));
    assert.ok(promptDay2.user.includes('你确认还没好吗'));
    assert.ok(promptDay2.user.includes('## Studio 常驻主对话'));

    // Simulate a boundary overlap cursor (e.g. a partial shift that already covered d2-u1 on an earlier date):
    dreamStore.advanceSessionCursorsForDate(1, day1, [{
      sessionId: studio.id,
      messages: [actDay2.sessions[0].messages[0]],
      lastMessageId: 'd2-u1',
      lastMessageCreatedAt: day2Start + 50 * 60_000,
    }]);
    const dedupedDay2 = dreamStore.getActivityForDate(1, day2Start, day2End, undefined, { dreamDate: day2 });
    assert.deepEqual(dedupedDay2.sessions[0].messages.map((m) => m.messageId), ['d2-a1'], 'already-dreamed boundary message is never reviewed twice');

    // Re-running day2 after advancing cursor to day2 remains idempotent (covers whole day2):
    dreamStore.advanceSessionCursorsForDate(1, day2, actDay2.sessions);
    const rerunDay2 = dreamStore.getActivityForDate(1, day2Start, day2End, undefined, { dreamDate: day2 });
    assert.deepEqual(rerunDay2.sessions[0].messages.map((m) => m.messageId), ['d2-u1', 'd2-a1']);
  } finally {
    cleanup();
  }
});

test('Studio priority budgeting, Continuity Crystal persistence, next-morning injection, singleton self_identity, and God-mode replay', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    const dreamStore = new DreamStore(db, () => {});
    const queueStore = new StudioDecisionQueueStore(db, () => {});

    const day = '2026-11-16';
    const dayStart = new Date(2026, 10, 16, 0, 0, 0).getTime();

    // Seed 3 pre-existing duplicate `created` self_identity rows to verify singleton cleanup.
    for (let i = 0; i < 3; i += 1) {
      coworkStore.createUserMemory({
        metabotId: 1,
        text: `旧身份副本 ${i} ${'旧内容'.repeat(80)}`,
        scopeKind: 'owner',
        scopeKey: 'owner:self',
        usageClass: 'self_identity',
        origin: 'dream',
        isExplicit: true,
        forceNew: true,
        source: { sourceType: 'dream', sourceChannel: 'dream', dreamDate: `2026-11-1${i}` },
      });
    }
    assert.equal(
      coworkStore.listUserMemories({ metabotId: 1, usageClass: 'self_identity', status: 'created', limit: 10 }).length,
      3,
    );

    // Create 1 Studio Owner Session + 12 noisy background scheduled sessions.
    const studio = coworkStore.createSession('多签技能与徽章并行推进', '/tmp/st2', '', 'local', [], 1, 'browser');
    db.run('UPDATE cowork_sessions SET assistant_mode = 1 WHERE id = ?', [studio.id]);
    const studioBodyMarker = '关键指令锚点_多签必须先从链上ZIP安装冒烟再验收';
    insertRawMsg(db, {
      id: 'st-u1',
      sessionId: studio.id,
      type: 'user',
      content: '让阿码发布 metabot-multisign 技能并写一篇上手教程。',
      createdAt: dayStart + 10 * 60_000,
      sequence: 1,
    });
    insertRawMsg(db, {
      id: 'st-a1',
      sessionId: studio.id,
      type: 'assistant',
      content: '阿码已发布技能钉与教程钉，请点击验收卡闭账。',
      createdAt: dayStart + 20 * 60_000,
      sequence: 2,
    });
    insertRawMsg(db, {
      id: 'st-u2',
      sessionId: studio.id,
      type: 'user',
      content: `先冒烟再验收，而且验收前要把链接摆出来（${studioBodyMarker}）`,
      createdAt: dayStart + 50 * 60_000,
      sequence: 3,
    });
    insertRawMsg(db, {
      id: 'st-a2',
      sessionId: studio.id,
      type: 'assistant',
      content: '明白，已派阿码从链上 ZIP 真实安装冒烟，通过后再附上完整 PinID 请你验收。',
      createdAt: dayStart + 52 * 60_000,
      sequence: 4,
    });

    for (let idx = 0; idx < 12; idx += 1) {
      const cron = coworkStore.createSession(`[定时] 后台巡检任务 #${idx}`, `/tmp/c${idx}`, '', 'local', [], 1, 'standard');
      coworkStore.setSessionAutoOrigin(cron.id, 'schedule');
      insertRawMsg(db, {
        id: `cron-u-${idx}`,
        sessionId: cron.id,
        type: 'user',
        content: '定时巡检指令'.repeat(120),
        createdAt: dayStart + 60_000 * (idx + 1),
        sequence: 1,
      });
      insertRawMsg(db, {
        id: `cron-a-${idx}`,
        sessionId: cron.id,
        type: 'assistant',
        content: '巡检长篇输出报告'.repeat(200),
        createdAt: dayStart + 60_000 * (idx + 1) + 5_000,
        sequence: 2,
      });
    }

    // Enqueue + resolve a Studio decision item inside the day window.
    const enq = queueStore.enqueue({
      dedupeKey: 'multisig-smoke',
      twinMetabotId: 1,
      originStudioSessionId: studio.id,
      kind: 'acceptance',
      title: '多签技能已上链请验收',
      backgroundSummary: '阿码已上链',
      progressSummary: '两枚钉已发',
      question: '是否验收通过？',
      options: [{ id: 'a', label: '通过' }, { id: 'b', label: '先冒烟' }],
      recommendation: '先冒烟',
      nextStep: '闭账',
      nowIso: new Date(dayStart + 25 * 60_000).toISOString(),
    });
    queueStore.resolve(enq.item.id, '主人要求先从链上 ZIP 安装冒烟再验收', new Date(dayStart + 51 * 60_000).toISOString());

    // Verify Studio priority budgeting keeps the full Studio marker even under a tight 1,200-token budget!
    const dayActivity = dreamStore.getActivityForDate(1, dayStart, dayStart + 86_400_000, undefined, { dreamDate: day });
    const tightPrompt = buildDreamPrompt({
      botName: 'AI_Sunny',
      date: day,
      activity: dayActivity,
      activityTokenBudget: 1200,
    });
    assert.ok(tightPrompt.user.includes(studioBodyMarker), 'Studio owner conversation gets priority token budget over 12 cron sessions');
    assert.ok(tightPrompt.user.includes('## 后台督办与自主任务会话'), 'autoOrigin sessions are separated from human conversations');
    assert.ok(tightPrompt.user.includes('## Studio 幕僚派工与拍板台账'), 'Studio decision queue ledger rides the dream prompt');

    // Verify autoOrigin cron sessions + studio_briefing do NOT trigger false negative signals / rollbacks.
    const signals = extractImplicitSignals(dayActivity);
    assert.equal(countNegativeSignalsForDay({ ...dayActivity, implicitSignals: signals }), 0, 'zero false rollback signals from cron/briefing messages');

    // Verify God's-Eye Studio Coaching point is extracted even with 0 thumbs-down clicks!
    const replayPoints = extractNegativeDecisionPoints({ ...dayActivity, implicitSignals: signals });
    assert.ok(replayPoints.some((p) => p.kind === 'studio_coaching'), 'Studio multi-turn steering produces a God-mode coaching replay point');

    const llmCalls = [];
    const dreamService = new DreamService({
      coworkStore,
      metabotStore: {
        listMetabots: () => [{ id: 1, name: 'AI_Sunny', role: '首席幕僚', soul: '严谨实证', llm_id: 'deepseek-flash', enabled: true }],
      },
      dreamStore,
      llmTimeoutMs: 5000,
      now: () => new Date(2026, 10, 17, 2, 0, 0),
      performChat: async (system, user) => {
        llmCalls.push({ system, user });
        if (system.includes('反事实重放')) {
          const ids = [...user.matchAll(/### 决策点 (\S+?)\(/g)].map((m) => m[1]);
          return JSON.stringify({
            results: ids.map((id) => ({
              id,
              original_score: 0.45,
              alternatives: [
                { action: '先让 Worker 用链上 ZIP 完成真实安装冒烟并摆齐两枚完整 PinID，再发起一次最终验收', score: 0.9 },
              ],
              lesson: '技能包刚上链尚未经过链上地址真实安装冒烟、或回复里尚未摆齐可点击产物链接前，不要提前弹最终验收卡打扰主人',
              workflow_upgrade: {
                title: 'Studio 链上技能发布双步核验流',
                description: 'Worker 发布技能钉后，幕僚后台自动追加一次从链上 metafile ZIP 真实安装的冒烟核验，核验通过并附上发布账号与完整 PinID 后再向主人呈报最终验收。',
              },
            })),
          });
        }
        return JSON.stringify({
          daily_summary: '今天在 Studio 主会话与主人并行推进了多签技能发布与安全审查，沉淀了先冒烟再验收的纪律。',
          sections: {
            studio: '并行推进多签技能发布与冒烟验收，确立先摆证先冒烟再请示验收的默契',
            tasks: '后台巡检 12 次均正常',
          },
          work_reviews: [
            { subject: '多签技能发布与冒烟验收', counterparty: 'Boss', evaluation: 'warming', note: '主人指出先冒烟再验收后我立即补齐字节闭环核验' },
          ],
          important_memories: [
            { text: '链上技能交付验收前必须先跑通链上 ZIP 真实安装冒烟', source: '主人明确指示「先冒烟再验收」' },
          ],
          value_lessons: [
            { rule: '要求主人验收任何视觉或链上产物前，必须先把可点击预览或完整链上标识摆在眼前，不能空口请示验收', source: '主人要求验收前先摆出链接并跑通冒烟' },
          ],
          studio_continuity: {
            active_workstreams: [
              'BTC 多签安全审查（Builder阿码 后台排查广播确认闸中，待核验汇报）',
              '多签教程配图三版（Eleven 本地生成中，待摆出三张预览供主人挑选）',
            ],
            standing_rulings: [
              '法币收款环节一律后置到 S7 首笔真实成交阶段',
              '链上技能发布必须先完成链上 ZIP 真实安装冒烟再提请最终验收',
              '请示验收设计稿或文件前必须逐项附上可点击预览链接',
            ],
            collaboration_playbook: [
              'Worker 后台执行期间主人顺手插话问其他专题时，直接干脆作答且不覆盖右侧投影屏',
              '后台巡检或实验严禁逐版打开浏览器预览抢夺前台焦点',
            ],
          },
          self_identity: LONG_IDENTITY,
          capability_learnings: [],
        });
      },
    });

    await dreamService.runNow(1, day);

    // 1) Singleton self_identity enforced: 3 duplicate `created` rows collapsed into 1!
    const liveIdentities = coworkStore.listUserMemories({
      metabotId: 1,
      usageClass: 'self_identity',
      status: 'created',
      limit: 10,
    });
    assert.equal(liveIdentities.length, 1, 'stale duplicate self_identity rows are cleaned up to a strict singleton');
    assert.equal(liveIdentities[0].text, LONG_IDENTITY);

    // 2) Nightly Studio Continuity Crystal persisted AND injected next morning!
    const continuity = dreamStore.getStudioContinuity(1);
    assert.ok(continuity);
    assert.equal(continuity.dreamDate, day);
    assert.equal(continuity.activeWorkstreams.length, 2);
    assert.equal(continuity.standingRulings.length, 3);
    assert.equal(continuity.collaborationPlaybook.length, 2);

    const chiefService = new StudioChiefOfStaffService({
      decisionQueueStore: () => queueStore,
      coworkStore: () => coworkStore,
      coworkRunner: () => ({ isSessionActive: () => false, startSession: async () => {} }),
      resolveTwinMetabotId: () => 1,
      resolveTwinWorkspace: () => '/tmp/st2',
      getStudioContinuity: (twinId) => dreamStore.getStudioContinuity(twinId),
    });
    const morningContext = chiefService.buildVolatileTurnContext(studio.id);
    assert.ok(morningContext.includes(`<studio_continuity_brief dreamDate="${day}">`));
    assert.ok(morningContext.includes('法币收款环节一律后置到 S7 首笔真实成交阶段'));
    assert.ok(morningContext.includes('BTC 多签安全审查'));
    assert.ok(morningContext.includes('严禁逐版打开浏览器预览抢夺前台焦点'));

    // 3) God's-Eye Studio Replay ran (`studio_coaching`), wrote a validated boundary lesson AND a workflow capability draft!
    assert.ok(llmCalls.some((c) => c.system.includes('首席幕僚上帝模式')), 'Studio replay used Chief-of-Staff God-mode framing');
    const boundaries = coworkStore.listUserMemories({ metabotId: 1, usageClass: 'value_boundary', status: 'created', limit: 20 });
    assert.ok(boundaries.some((b) => b.text.includes('反事实重放') && b.text.includes('提前弹最终验收卡')));
    const drafts = coworkStore.listCapabilityDrafts(1);
    assert.ok(drafts.some((d) => d.title === 'Studio 链上技能发布双步核验流'), 'God-mode replay workflow upgrade feeds capability_drafts');
  } finally {
    cleanup();
  }
});

test('Guidance ladder unstarves <proven_techniques> for realistic mature-bot memory sizes under GUIDANCE_MAX_CHARS', () => {
  // Real production profile from AI_Sunny: 5 boundaries (~135 chars each),
  // 5 work reviews (~165 chars each), 5 proven techniques (~260 chars each).
  // Previously the ladder jumped [5,5,3] -> [5,3,0] and dropped proven_techniques
  // on 100% of turns (totalInjections = 0 across 91 validated drafts).
  const xml = buildExperiencePromptBlocksXml({
    summaries: [],
    valueBoundaries: Array.from({ length: 5 }, (_, i) => ({
      text: `边界规则${i}:${'不可逆操作前必须先核对一手证据并取得明确授权'.repeat(5)}`,
    })),
    workReviews: Array.from({ length: 5 }, (_, i) => ({
      text: `工作:Studio主线项目${i};对象:Boss;评价:升温;依据:${'先摆出预览链接再请示拍板效果很好'.repeat(6)}`,
    })),
    provenTechniques: Array.from({ length: 5 }, (_, i) => ({
      title: `Studio并行督办技巧${i}`,
      description: `${'后台Worker执行期间先在只读督办会话完成测试与哈希核验再入队汇报'.repeat(7)}`,
    })),
  });
  assert.ok(xml.includes('<value_boundaries>'));
  assert.ok(xml.includes('<work_reviews>'));
  assert.ok(xml.includes('<proven_techniques>'), 'proven_techniques is no longer starved out of mature bots');
  assert.ok(xml.length <= GUIDANCE_MAX_CHARS, `fits GUIDANCE_MAX_CHARS (${xml.length} <= ${GUIDANCE_MAX_CHARS})`);
});

test('Long-Studio anti-degradation static & unit checks: compaction clears volatileDedup, <owner_message> unwraps terse rulings, and internal turns skip memory extraction', () => {
  const runnerSrc = fs.readFileSync(
    path.resolve(process.cwd(), 'src/main/libs/coworkRunner.ts'),
    'utf8',
  );
  // 1) Compaction invalidates volatileDedupBySessionId on manual, DSH auto-compaction, and SDK compact_boundary.
  const dedupDeletes = runnerSrc.match(/this\.volatileDedupBySessionId\.delete\(sessionId\)/g) ?? [];
  assert.ok(dedupDeletes.length >= 3, `expected >=3 compaction volatileDedup resets, found ${dedupDeletes.length}`);

  // 2) Turn memory extraction skips autoOrigin sessions and synthetic internal user messages.
  assert.ok(runnerSrc.includes('if (session.autoOrigin)'));
  assert.ok(runnerSrc.includes('if (this.isSyntheticInternalUserMessage(message))'));

  // 3) Unwrapping buildOwnerTurnInputPrompt recovers exact terse rulings ("A，gogo", "继续").
  const wrapped = buildOwnerTurnInputPrompt('A，gogo');
  assert.ok(wrapped.length > 200, 'envelope itself exceeds 24 chars');
  const openIdx = wrapped.indexOf('<owner_message>');
  const closeIdx = wrapped.lastIndexOf('</owner_message>');
  const inner = wrapped.slice(openIdx + '<owner_message>'.length, closeIdx).trim();
  const blankSplit = inner.split(/\r?\n\r?\n/);
  const unwrapped = blankSplit.length >= 2 ? blankSplit.slice(1).join('\n\n').trim() : inner;
  assert.equal(unwrapped, 'A，gogo');

  // 4) Counterfactual workflow upgrade helper honors score + margin gate.
  const parsed = parseCounterfactualReplayOutput(
    JSON.stringify({
      results: [{
        id: 'studio:s1:2',
        original_score: 0.4,
        alternatives: [{ action: '摆出三张预览图再请主人选', score: 0.88 }],
        lesson: '未展示候选预览前不要让主人盲选验收',
        workflow_upgrade: { title: '视觉产物并排预览呈报流', description: '收到设计类交付后先逐张自检，再附上三张 preview-file 链接供主人挑选。' },
      }],
    }),
    new Set(['studio:s1:2']),
  );
  assert.equal(parsed.ok, true);
  assert.equal(pickCounterfactualWorkflowUpgrade(parsed.results[0])?.title, '视觉产物并排预览呈报流');
  const replayPrompt = buildCounterfactualReplayPrompt({
    botName: 'AI_Sunny',
    date: '2026-11-17',
    points: [{
      id: 'studio:s1:2',
      kind: 'studio_coaching',
      situation: 'Studio 主对话「配图」',
      botAction: '请验收',
      outcome: '主人追问图在哪',
    }],
  });
  assert.ok(replayPrompt.system.includes('首席幕僚上帝模式'));
});

test('Dream brief reconciliation: tasks resolved after the dream snapshot ride an authoritative block right after the brief; nothing resolved injects nothing', async () => {
  const { db, cleanup } = await createSqliteStore();
  try {
    const coworkStore = createCoworkStore(db);
    const queueStore = new StudioDecisionQueueStore(db, () => {});

    const studio = coworkStore.createSession('常驻 Studio 主会话', '/tmp/st3', '', 'local', [], 1, 'browser');
    db.run('UPDATE cowork_sessions SET assistant_mode = 1 WHERE id = ?', [studio.id]);

    // The 2026-11-19 incident shape: the brief still asks the owner to
    // green-light the fix while the task store already closed it hours ago.
    const continuity = {
      metabotId: 1,
      dreamDate: '2026-11-18',
      activeWorkstreams: ['丢图修复：根因已查清，等主人回「修」即派 Builder阿码执行四步修复'],
      standingRulings: [],
      collaborationPlaybook: [],
      summaryMarkdown: '',
      llmId: null,
      updatedAt: Date.now(),
    };

    const resolvedSinceCalls = [];
    const chiefService = new StudioChiefOfStaffService({
      decisionQueueStore: () => queueStore,
      coworkStore: () => coworkStore,
      coworkRunner: () => ({ isSessionActive: () => false, startSession: async () => {} }),
      resolveTwinMetabotId: () => 1,
      resolveTwinWorkspace: () => '/tmp/st3',
      getStudioContinuity: () => continuity,
      listTasksResolvedSince: (sinceMs) => {
        resolvedSinceCalls.push(sinceMs);
        return [
          { id: 'ltt_a414d6a1', title: '实施兑换引擎图片保留修复（根因报告 §4.2 四步）：①金库行映射器接回 imgUrl', stage: 'done', resolvedAtIso: '2026-11-18T18:47:11.310Z' },
          { id: 'ltt_dc585303', title: '把「图片转换」做成兑换流水线的正式环节', stage: 'done', resolvedAtIso: '2026-11-18T18:47:29.980Z' },
        ];
      },
    });

    const context = chiefService.buildVolatileTurnContext(studio.id);
    assert.ok(context.includes('<studio_continuity_brief dreamDate="2026-11-18">'));
    const briefIdx = context.indexOf('<studio_continuity_brief');
    const reconIdx = context.indexOf('<dream_brief_task_reconciliation dreamDate="2026-11-18">');
    assert.ok(briefIdx >= 0 && reconIdx > briefIdx, 'the reconciliation block rides right after the brief');
    assert.ok(context.includes('[done] "实施兑换引擎图片保留修复'), 'resolved tasks carry a stage badge');
    assert.ok(context.includes('taskId=ltt_a414d6a1'));
    assert.ok(context.includes('resolvedAt=2026-11-18T18:47:11.310Z'));
    assert.ok(context.includes('task_search'), 'the verify-before-presenting rule is carried');
    // The watermark is the dreamDate LABEL at local midnight (not the row's
    // updatedAt — a later dream touch must not shrink the reconciliation).
    assert.equal(resolvedSinceCalls[0], new Date('2026-11-18T00:00:00').getTime());

    // Nothing resolved since the dream → no reconciliation block, no tokens.
    const quietService = new StudioChiefOfStaffService({
      decisionQueueStore: () => queueStore,
      coworkStore: () => coworkStore,
      coworkRunner: () => ({ isSessionActive: () => false, startSession: async () => {} }),
      resolveTwinMetabotId: () => 1,
      resolveTwinWorkspace: () => '/tmp/st3',
      getStudioContinuity: () => continuity,
      listTasksResolvedSince: () => [],
    });
    const quietContext = quietService.buildVolatileTurnContext(studio.id);
    assert.ok(quietContext.includes('<studio_continuity_brief dreamDate="2026-11-18">'));
    assert.ok(!quietContext.includes('<dream_brief_task_reconciliation'), 'no block when nothing resolved since the dream');

    // Static wiring pins: main feeds the block from the live task store, and
    // the store query targets terminal stages after the watermark.
    const mainSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/main/main.ts'), 'utf8');
    assert.ok(
      mainSrc.includes('listTasksResolvedSince: (sinceMs) => getLongTermTaskStore().listTasksResolvedSince(sinceMs, 8)'),
      'main wires the reconciliation feed from the live task store',
    );
    const storeSrc = fs.readFileSync(path.resolve(process.cwd(), 'src/main/longTermTaskStore.ts'), 'utf8');
    assert.ok(
      storeSrc.includes("WHERE stage IN ('done', 'cancelled') AND COALESCE(done_at, updated_at) > ?"),
      'the store resolves tasks by terminal stage after the watermark',
    );
  } finally {
    cleanup();
  }
});
