#!/usr/bin/env node
/**
 * AC-E-2 gateway-backed e2e harness.
 *
 * Proves the mobile app runs against the REAL C2 gateway path (REQ-E-2/3
 * wiring, not the mock): a standalone gateway fixture is built from the
 * compiled dist-electron/main/gateway/server.js with in-memory invoke
 * handlers that echo the mock bridge's cowork protocol (session start →
 * streamed assistant reply over cowork:stream:* events). The dev server runs
 * WITHOUT VITE_MOBILE_MOCK on port 5197; its /ws proxy (REQ-E-9) forwards to
 * the fixture with the secret header the browser WebSocket cannot carry.
 *
 * Steps:
 *   (a) build the electron main bundle if dist-electron is missing/stale
 *   (b) start the gateway fixture on 127.0.0.1:8790 with a generated secret
 *   (c) spawn dev:mobile:real on 5197 with IDBOTS_GATEWAY_SECRET set
 *   (d) run `playwright test --grep @gateway`
 *
 * For a human-driven run instead: start the desktop dev gateway with
 * IDBOTS_GATEWAY_DEV=1 (it prints the generated secret once), then
 * `IDBOTS_GATEWAY_SECRET=<secret> pnpm run dev:mobile:real` and open
 * http://localhost:5176/app/.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMockArtifactImage, createMockArtifactPdf } from '../src/mobile/bridge/mockArtifacts.ts';
import { applyLongTermStage, createLongTermFixture, longTermBoard } from '../src/mobile/bridge/backgroundFixtures.ts';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATEWAY_PORT = Number(process.env.IDBOTS_GATEWAY_PORT || 8790);
const APP_PORT = process.env.E2E_PORT || '5197';
const BASE_URL = `http://localhost:${APP_PORT}`;
const SECRET = process.env.IDBOTS_GATEWAY_SECRET || crypto.randomBytes(32).toString('base64url');
const TENANT = 't_e2egateway0000000001';

// ---------------------------------------------------------------------------
// (a) compiled gateway server
// ---------------------------------------------------------------------------

const serverJs = path.join(repoRoot, 'dist-electron', 'main', 'gateway', 'server.js');
if (!fs.existsSync(serverJs)) {
  console.log('[gateway-e2e] dist-electron/main/gateway/server.js missing — running compile:electron…');
  const compiled = spawnSync('pnpm', ['run', 'compile:electron'], { cwd: repoRoot, stdio: 'inherit' });
  if (compiled.status !== 0 || !fs.existsSync(serverJs)) {
    console.error('[gateway-e2e] compile:electron did not produce the gateway server bundle.');
    process.exit(1);
  }
}
const server = require(serverJs);
const fileSignCore = require(path.join(repoRoot, 'dist-electron', 'main', 'gateway', 'fileSign.js'));

// ---------------------------------------------------------------------------
// (b) in-memory cowork fixture echoing the mock bridge's protocol
// ---------------------------------------------------------------------------

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-gateway-e2e-')));
const paths = {
  dataRoot: path.join(base, 'data'),
  workspaceRoot: path.join(base, 'data', 'workspace'),
  uploadsRoot: path.join(base, 'data', 'workspace', 'uploads'),
};
fs.mkdirSync(paths.uploadsRoot, { recursive: true });

/**
 * F-11 file delivery is enabled by default so the complete gateway matrix
 * cannot be skipped accidentally. Set GW_FIXTURE_FILE=0 only for a deliberate
 * no-file debugging run. The fixture seeds a deterministic document and
 * appends file:// links to the canned reply — exactly the shape a tenant bot
 * produces after generating a docx/pdf. The e2e spec then proves the mobile UI
 * renders a clickable same-origin /files/{token} download link instead of the
 * dead container path.
 */
const GW_FILE_E2E = process.env.GW_FIXTURE_FILE !== '0';
const FIXTURE_FILE_NAME = 'gateway-e2e-report.docx';
/** Mirror of the payload asserted in e2e/mobile/gateway.spec.ts. */
const FIXTURE_FILE_BYTES = Buffer.from('PK\x03\x04 gateway fixture docx payload 0123456789abcdef');
const GATEWAY_ARTIFACTS = [
  { name: 'gateway-e2e-image.png', bytes: createMockArtifactImage() },
  { name: 'gateway-e2e-preview.pdf', bytes: createMockArtifactPdf() },
  { name: 'gateway-e2e-notes.md', bytes: Buffer.from('# Gateway notes\n\nThis Markdown was served by the tenant.\n') },
  { name: 'gateway-e2e-refresh.md', bytes: Buffer.from('# Refresh\n\nThe tenant link rotated without closing this preview.\n') },
];

if (GW_FILE_E2E) {
  fs.writeFileSync(path.join(paths.workspaceRoot, FIXTURE_FILE_NAME), FIXTURE_FILE_BYTES);
  for (const artifact of GATEWAY_ARTIFACTS) {
    fs.writeFileSync(path.join(paths.workspaceRoot, artifact.name), artifact.bytes);
  }
}
const GATEWAY_ARTIFACT_LINKS = GATEWAY_ARTIFACTS
  .map((artifact) => `[${artifact.name}](file://${path.join(paths.workspaceRoot, artifact.name)})`)
  .join(' · ');

/** Canned reply streamed by the fixture turn (not UI copy). */
const FIXTURE_REPLY =
  '**Gateway fixture online.**\n\nThis reply streamed over a real C2 gateway socket.' +
  (GW_FILE_E2E
    ? `\n\n文件已生成：[${FIXTURE_FILE_NAME}](file://${path.join(paths.workspaceRoot, FIXTURE_FILE_NAME)})\n\nArtifacts: ${GATEWAY_ARTIFACT_LINKS}\n\n[工作目录](${paths.workspaceRoot})`
    : '');

const metabots = [
  {
    id: 1,
    wallet_id: 1,
    name: 'Gateway Twin',
    avatar: null,
    enabled: true,
    globalmetaid: 'gmid-gateway-twin',
    metabot_type: 'twin',
    role: 'chief of staff',
    soul: 'Synthetic gateway twin',
    goal: null,
    bio: 'Twin fixture for real C2 mobile tests',
    background: null,
    boss_id: null,
    boss_global_metaid: null,
    llm_id: 'deepseek-flash',
    llm_provider: 'idbots',
    llm_effort: null,
    mvc_address: 'gw-mvc-bot',
    metabot_info_pinid: 'gw-info-bot',
    chain_sync_state: 'synced',
    chain_sync_pending_steps: [],
    subsidy_state: 'claimed',
    tools: [],
    skills: ['web-search'],
    allow_chat_skills: ['web-search'],
    created_at: 1,
    updated_at: 1,
  },
  {
    id: 2,
    wallet_id: 2,
    name: 'Gateway Worker',
    avatar: null,
    enabled: true,
    globalmetaid: 'gmid-gateway-worker',
    metabot_type: 'worker',
    role: 'research worker',
    soul: 'Synthetic gateway worker',
    goal: null,
    bio: 'Worker fixture for real C2 mobile tests',
    background: null,
    boss_id: null,
    boss_global_metaid: null,
    llm_id: 'deepseek-flash',
    llm_provider: 'idbots',
    llm_effort: null,
    mvc_address: 'gw-mvc-bot',
    metabot_info_pinid: 'gw-info-bot',
    chain_sync_state: 'synced',
    chain_sync_pending_steps: [],
    subsidy_state: 'claimed',
    tools: [],
    skills: [],
    allow_chat_skills: ['web-search'],
    created_at: 1,
    updated_at: 1,
  },
];
let metabotSeq = 2;
const skillFixtures = [
  {
    id: 'web-search',
    name: 'web-search',
    description: 'Searches the web',
    enabled: true,
    isOfficial: true,
    isBuiltIn: false,
    updatedAt: 1,
    prompt: '',
    skillPath: '/data/appdata/SKILLs/web-search',
  },
  {
    id: 'memory',
    name: 'memory',
    description: 'Long-term memory',
    enabled: true,
    isOfficial: true,
    isBuiltIn: true,
    updatedAt: 1,
    prompt: '',
    skillPath: '/data/appdata/SKILLs/memory',
  },
];

const sessions = new Map();
const liveMessages = new Map(); // `${sessionId}${messageId}` -> message
const sessionTimers = new Map(); // sessionId -> timer handles
const F17A_REAL_ASK_TOOL_INPUT = {
  questions: [{
    id: 'confirm_create',
    header: '确认入职',
    question: '这张卡可以照着建吗？',
    multi_select: false,
    detail: '建完他会是一个独立的本地 Worker Bot：有自己的钱包和链上身份（globalMetaId）。',
    options: [
      { label: '就这个（推荐）', description: '按现在的名字、人格、火箭头像创建。' },
      { label: '名字换一个', description: '保留人格和头像，我再出 3 个名字备选。' },
      { label: '头像换一个', description: '保留名字和人格，从其它图里再挑。' },
    ],
  }],
};
const pendingPermissions = [];

let sessionSeq = 0;
let messageSeq = 0;
let broadcast = null;

function nextScheduledAt(schedule, fromMs) {
  if (schedule.type === 'interval') return fromMs + schedule.intervalMs;
  if (schedule.type === 'at') {
    const timestamp = Date.parse(schedule.datetime);
    return Number.isFinite(timestamp) && timestamp > fromMs ? timestamp : null;
  }
  const parts = schedule.expression.trim().split(/\s+/);
  const minute = Number(parts[0]);
  const hour = Number(parts[1]);
  if (parts.length !== 5 || !Number.isInteger(minute) || !Number.isInteger(hour)) return null;
  const next = new Date(fromMs);
  next.setSeconds(0, 0);
  for (let day = 0; day < 8; day += 1) {
    next.setHours(hour, minute, 0, 0);
    const weekdayMatches = parts[4] === '*' || Number(parts[4]) % 7 === next.getDay();
    if (next.getTime() > fromMs && weekdayMatches) return next.getTime();
    next.setDate(next.getDate() + 1);
  }
  return null;
}

function fixtureTask(id, name, enabled, schedule) {
  const timestamp = Date.now();
  return {
    id,
    name,
    description: 'Gateway background-work fixture',
    enabled,
    schedule,
    prompt: `Complete ${name}`,
    workingDirectory: paths.workspaceRoot,
    systemPrompt: 'Preserve this scheduled-task context',
    executionMode: 'auto',
    metabotId: 1,
    coworkSessionId: null,
    targetSessionId: null,
    memoryAccess: 'none',
    expiresAt: null,
    notifyPlatforms: [],
    origin: 'human',
    originSessionId: null,
    originContext: 'ui',
    exitCondition: null,
    maxFires: null,
    fireCount: 0,
    state: {
      nextRunAtMs: enabled ? nextScheduledAt(schedule, timestamp) : null,
      lastRunAtMs: null,
      lastStatus: null,
      lastError: null,
      lastDurationMs: null,
      runningAtMs: null,
      consecutiveErrors: 0,
    },
    createdAt: new Date(timestamp).toISOString(),
    updatedAt: new Date(timestamp).toISOString(),
  };
}

const scheduledTasks = [
  fixtureTask('gw-task-1', 'Gateway daily job', true, {
    type: 'interval', intervalMs: 86_400_000, unit: 'days', value: 1,
  }),
  {
    ...fixtureTask('gw-task-2', 'Gateway weekly job', false, { type: 'cron', expression: '0 9 * * 1' }),
    memoryAccess: 'read-write',
    coworkSessionId: 'gw-preserved-cowork',
    targetSessionId: 'gw-preserved-target',
  },
];
const scheduledRuns = new Map();
const activeRuns = new Map();
let taskSeq = 2;
let runSeq = 0;

function storeScheduledRun(run) {
  const runs = scheduledRuns.get(run.taskId) ?? [];
  const index = runs.findIndex((candidate) => candidate.id === run.id);
  if (index < 0) runs.unshift(run);
  else runs[index] = run;
  scheduledRuns.set(run.taskId, runs);
}

function startScheduledRun(task, trigger) {
  const startedMs = Date.now();
  const session = {
    id: `gw-scheduled-session-${++sessionSeq}`,
    title: `Scheduled run: ${task.name}`,
    claudeSessionId: `claude-scheduled-${sessionSeq}`,
    status: 'running',
    pinned: false,
    cwd: paths.workspaceRoot,
    systemPrompt: task.systemPrompt,
    executionMode: task.executionMode,
    activeSkillIds: [],
    messages: [],
    createdAt: startedMs,
    updatedAt: startedMs,
    metabotId: task.metabotId,
    sessionType: 'standard',
    autoOrigin: 'schedule',
  };
  sessions.set(session.id, session);
  const run = {
    id: `gw-run-${++runSeq}`,
    taskId: task.id,
    sessionId: session.id,
    status: 'running',
    startedAt: new Date(startedMs).toISOString(),
    finishedAt: null,
    durationMs: null,
    error: null,
    trigger,
    skipReason: null,
  };
  storeScheduledRun(run);
  task.state = { ...task.state, lastStatus: 'running', runningAtMs: startedMs };
  task.updatedAt = new Date(startedMs).toISOString();
  broadcast?.('scheduledTask:statusUpdate', [{ taskId: task.id, state: { ...task.state } }]);
  broadcast?.('scheduledTask:runUpdate', [{ run: { ...run } }]);
  const delay = trigger === 'manual' ? Number(process.env.GW_FIXTURE_MANUAL_RUN_DELAY_MS ?? 2500) : 500;
  const timer = setTimeout(() => {
    if (!activeRuns.delete(run.id)) return;
    const finishedMs = Date.now();
    run.status = 'success';
    run.finishedAt = new Date(finishedMs).toISOString();
    run.durationMs = finishedMs - startedMs;
    session.messages.push(
      { id: `gw-msg-${++messageSeq}`, type: 'user', content: task.prompt, timestamp: startedMs },
      {
        id: `gw-msg-${++messageSeq}`,
        type: 'assistant',
        content: `**Gateway scheduled result.**\n\n${FIXTURE_REPLY}`,
        timestamp: finishedMs,
        metadata: { isFinal: true },
      },
    );
    session.status = 'completed';
    session.updatedAt = finishedMs;
    task.fireCount += 1;
    task.state = {
      ...task.state,
      nextRunAtMs: task.enabled ? nextScheduledAt(task.schedule, finishedMs) : null,
      lastRunAtMs: finishedMs,
      lastStatus: 'success',
      lastError: null,
      lastDurationMs: run.durationMs,
      runningAtMs: null,
      consecutiveErrors: 0,
    };
    task.updatedAt = new Date(finishedMs).toISOString();
    storeScheduledRun(run);
    broadcast?.('scheduledTask:runUpdate', [{ run: { ...run } }]);
    broadcast?.('scheduledTask:statusUpdate', [{ taskId: task.id, state: { ...task.state } }]);
  }, delay);
  activeRuns.set(run.id, { taskId: task.id, timer });
  return run;
}

function stopScheduledRuns(taskId) {
  let stopped = false;
  for (const [runId, active] of [...activeRuns]) {
    if (active.taskId !== taskId) continue;
    clearTimeout(active.timer);
    activeRuns.delete(runId);
    const run = (scheduledRuns.get(taskId) ?? []).find((candidate) => candidate.id === runId);
    if (!run || run.status !== 'running') continue;
    stopped = true;
    const finishedMs = Date.now();
    run.status = 'error';
    run.error = 'Stopped by user';
    run.finishedAt = new Date(finishedMs).toISOString();
    run.durationMs = finishedMs - Date.parse(run.startedAt);
    const session = sessions.get(run.sessionId);
    if (session) session.status = 'idle';
    const task = scheduledTasks.find((candidate) => candidate.id === taskId);
    if (task) {
      task.state = {
        ...task.state,
        lastRunAtMs: finishedMs,
        lastStatus: 'error',
        lastError: run.error,
        runningAtMs: null,
      };
      task.updatedAt = new Date(finishedMs).toISOString();
      broadcast?.('scheduledTask:statusUpdate', [{ taskId, state: { ...task.state } }]);
    }
    storeScheduledRun(run);
    broadcast?.('scheduledTask:runUpdate', [{ run: { ...run } }]);
  }
  return stopped;
}

const longTermSessionId = 'gw-longterm-session-1';
const longTermTimestamp = Date.now();
sessions.set(longTermSessionId, {
  id: longTermSessionId,
  title: 'Gateway long-term result',
  claudeSessionId: 'claude-gw-longterm-1',
  status: 'completed',
  pinned: false,
  cwd: paths.workspaceRoot,
  systemPrompt: '',
  executionMode: 'auto',
  activeSkillIds: [],
  messages: [
    { id: `gw-msg-${++messageSeq}`, type: 'user', content: 'Produce the long-term document', timestamp: longTermTimestamp - 1000 },
    {
      id: `gw-msg-${++messageSeq}`,
      type: 'assistant',
      content: `**Gateway long-term result.**\n\n${FIXTURE_REPLY}`,
      timestamp: longTermTimestamp,
      metadata: { isFinal: true },
    },
  ],
  createdAt: longTermTimestamp - 1000,
  updatedAt: longTermTimestamp,
  metabotId: 1,
  sessionType: 'longterm',
  autoOrigin: null,
});
let longTermDetail = createLongTermFixture(longTermSessionId);
longTermDetail.participants = [{ id: 1, name: 'Gateway Twin', avatar: null }];
let longTermSeq = 0;

const summaryOf = (session) => ({
  id: session.id,
  title: session.title,
  status: session.status,
  pinned: false,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  metabotId: session.metabotId,
  sessionType: session.sessionType,
  autoOrigin: session.autoOrigin,
});

function clearTurnTimers(sessionId) {
  for (const timer of sessionTimers.get(sessionId) ?? []) clearTimeout(timer);
  sessionTimers.delete(sessionId);
}

/** Streams the canned reply through the same cowork:stream:* events the mock emits. */
function startFixtureTurn(session, userText) {
  const message = {
    id: `gw-msg-${++messageSeq}`,
    type: 'assistant',
    content: '',
    timestamp: Date.now(),
  };
  session.messages.push(message);
  session.status = 'running';
  liveMessages.set(`${session.id}${message.id}`, message);
  if (process.env.GW_FIXTURE_DEBUG) {
    console.log(`[fixture] stream:message ${session.id}/${message.id} (text=${JSON.stringify(userText)})`);
  }
  broadcast('cowork:stream:message', [{ sessionId: session.id, message: { ...message } }]);

  const chunks = [];
  for (let i = 0; i < FIXTURE_REPLY.length; i += 8) chunks.push(FIXTURE_REPLY.slice(i, i + 8));
  // Tests can slow the stream to exercise reload/reconnect recovery without
  // changing the default 40 ms cadence used by the acceptance matrix.
  const streamTokenIntervalMs = Number(process.env.GW_FIXTURE_STREAM_INTERVAL_MS ?? 40);
  const timers = [];
  let accumulated = '';
  chunks.forEach((chunk, index) => {
    timers.push(
      setTimeout(() => {
        if (session.status !== 'running') return;
        accumulated += chunk;
        message.content = accumulated;
        if (index === 0) {
          broadcast('cowork:stream:messageUpdate', [
            { sessionId: session.id, messageId: message.id, content: chunk },
          ]);
        } else {
          broadcast('cowork:stream:messageUpdate', [
            { sessionId: session.id, messageId: message.id, delta: chunk, baseLength: accumulated.length - chunk.length },
          ]);
        }
      }, streamTokenIntervalMs * (index + 1)),
    );
  });
  timers.push(
    setTimeout(() => {
      if (session.status !== 'running') return;
      session.status = 'completed';
      broadcast('cowork:stream:complete', [{ sessionId: session.id, claudeSessionId: session.claudeSessionId }]);
    }, streamTokenIntervalMs * (chunks.length + 1)),
  );
  sessionTimers.set(session.id, timers);
}

const appConfigStore = {
  app_config: {
    language: 'en',
    theme: 'system',
    providers: {
      'idbots': {
        enabled: true,
        apiKey: 'gateway-fixture-relay-key',
        baseUrl: 'https://gateway.fixture/relay',
        apiFormat: 'openai',
        name: 'ID.Bots',
        models: [
          { id: 'deepseek-flash', name: 'DeepSeek Flash', contextWindow: 1000000, maxOutputTokens: 100000 },
          { id: 'glm-flash', name: 'GLM Flash', contextWindow: 128000, maxOutputTokens: 32768 },
        ],
      },
    },
    model: { defaultProvider: 'idbots', defaultModel: 'deepseek-flash' },
    bootstrap: { workspace: paths.workspaceRoot, languageInitialized: true },
    memoryEnabled: true,
  },
};

const coworkConfig = {
  workingDirectory: paths.workspaceRoot,
  systemPrompt: '',
  executionMode: 'local',
  memoryEnabled: true,
  memoryImplicitUpdateEnabled: true,
  memoryLlmJudgeEnabled: false,
  memoryGuardLevel: 'standard',
  memoryUserMemoriesMaxItems: 100,
  memoryPromptMaxChars: 4000,
  lastWorkspaceSelection: null,
};

const bundlePlans = [
  {
    planId: 'bundle_basic_cny',
    name: 'Basic',
    nameEn: 'Basic',
    payCurrency: 'CNY',
    payAmount: '129.00',
    trafficBytes: 10 * 1024 * 1024 * 1024,
    llmQuota: 50_000_000,
    llmQuotaUnit: 'tokens',
    status: 1,
    sort: 10,
    remark: '',
  },
];
const bundleOrders = new Map();
const bundleMeters = {
  traffic: {
    accountId: 'gateway-traffic-account',
    identityAddress: 'gateway-identity',
    balanceBytes: 500 * 1024 * 1024,
    reservedBytes: 0,
    grantedBytesTotal: 1024 * 1024 * 1024,
    spentBytesTotal: 500 * 1024 * 1024,
    status: 1,
  },
  llm: {
    quotaTotal: 2_000_000,
    quotaUsed: 350_000,
    quotaRemaining: 1_650_000,
    quotaFree: 2_000_000,
    quotaPurchased: 0,
    unit: 'tokens',
  },
};
let bundleOrderSeq = 0;

const mePlans = [
  { planId: 'me_free', tier: 'free', name: 'Free', priceCny: 0, desktopPriceCny: 0, periodDays: 30, weeklyAmountMilli: 2_000_000, saleStatus: 1 },
  { planId: 'me_standard', tier: 'standard', name: 'ID.Pupil', priceCny: 99, desktopPriceCny: 49, periodDays: 30, weeklyAmountMilli: 10_000_000, saleStatus: 1 },
  { planId: 'me_pro', tier: 'pro', name: 'ID.Student', priceCny: 199, desktopPriceCny: 149, periodDays: 30, weeklyAmountMilli: 35_000_000, saleStatus: 1 },
];
const meTopupPackages = [
  { packageId: 'me_topup_a', name: 'Top-up Pack A', meMilli: 30_000_000, priceCny: 90, saleStatus: 1 },
];
const meSubscriptionOrders = new Map();
const meTopupOrders = new Map();
const meState = {
  subscribed: false,
  activePlanId: 'me_free',
  weeklyAmountMilli: 2_000_000,
  weeklyRemainingMilli: 1_480_000,
  topupMilli: 0,
  bonusMilli: 0,
  earnedMilli: 0,
};
let meSubscriptionSeq = 0;
let meTopupSeq = 0;

function meBalance() {
  return {
    identityAddress: 'gateway-identity',
    weeklyGrant: {
      amountMilli: meState.weeklyAmountMilli,
      remainingMilli: meState.weeklyRemainingMilli,
      cycleStart: Math.floor(Date.now() / 1000) - 86_400,
      cycleEnd: Math.floor(Date.now() / 1000) + 4 * 86_400,
      isResidual: false,
      nextResetAt: Date.now() + 86_400_000,
    },
    persistent: {
      topupMilli: meState.topupMilli,
      earnedMilli: meState.earnedMilli,
      bonusMilli: meState.bonusMilli,
    },
    frozenMilli: 0,
    totalAvailable: meState.weeklyRemainingMilli + meState.topupMilli + meState.bonusMilli + meState.earnedMilli,
  };
}

async function invokeHandler(channel, clientId, args) {
  if (process.env.GW_FIXTURE_DEBUG) {
    console.log(`[fixture] invoke ${channel} ${JSON.stringify(args)?.slice(0, 120)}`);
  }
  switch (channel) {
    case 'cowork:session:createGreeting': {
      const options = args[0] ?? {};
      const now = Date.now();
      const session = {
        id: `gw-session-${++sessionSeq}`,
        title: options.title || 'Welcome',
        claudeSessionId: `claude-${sessionSeq}`,
        status: 'completed',
        pinned: false,
        cwd: paths.workspaceRoot,
        systemPrompt: options.systemPrompt || '',
        executionMode: 'auto',
        activeSkillIds: [],
        messages: [{
          id: `gw-msg-${++messageSeq}`,
          type: 'assistant',
          content: options.fallbackGreeting,
          timestamp: now,
          metadata: { isFinal: true },
        }],
        createdAt: now,
        updatedAt: now,
        metabotId: options.metabotId ?? null,
        model: options.model ?? metabots.find((bot) => bot.id === options.metabotId)?.llm_id ?? null,
        modelProvider: options.modelProvider ?? metabots.find((bot) => bot.id === options.metabotId)?.llm_provider ?? null,
        sessionType: 'standard',
        autoOrigin: null,
      };
      sessions.set(session.id, session);
      return { success: true, session: { ...session, messages: [...session.messages] } };
    }
    case 'cowork:session:start': {
      const options = args[0] ?? {};
      const now = Date.now();
      const session = {
        id: `gw-session-${++sessionSeq}`,
        title: options.title || 'Gateway chat',
        claudeSessionId: `claude-${sessionSeq}`,
        status: 'idle',
        pinned: false,
        cwd: paths.workspaceRoot,
        systemPrompt: '',
        executionMode: 'auto',
        activeSkillIds: [],
        messages: [],
        createdAt: now,
        updatedAt: now,
        metabotId: options.metabotId ?? null,
        model: options.model ?? metabots.find((bot) => bot.id === options.metabotId)?.llm_id ?? null,
        modelProvider: options.modelProvider ?? metabots.find((bot) => bot.id === options.metabotId)?.llm_provider ?? null,
        sessionType: 'standard',
        autoOrigin: null,
      };
      sessions.set(session.id, session);
      const text = options.prompt || '';
      if (text) {
        session.messages.push({ id: `gw-msg-${++messageSeq}`, type: 'user', content: text, timestamp: now });
      }
      // F-17a fixture: raise a REAL ask_user_question permission event over
      // the gateway event fan-out with the exact 阿燃 incident payload shape —
      // regression gate for the IPC sanitize depth crush that made the mobile
      // permission panel render the unanswerable "Request unavailable" card.
      if (text.includes('__f17a_emit_ask__')) {
        pendingPermissions.push({
          sessionId: session.id,
          request: {
            sessionId: session.id,
            requestId: 'gw-ask-f17a',
            toolName: 'AskUserQuestion',
            toolInput: F17A_REAL_ASK_TOOL_INPUT,
            perQuestionTimeoutMs: null,
          },
        });
        setTimeout(() => {
          const bound = broadcast;
          if (!bound || !pendingPermissions.length) return;
          const pending = pendingPermissions.at(-1);
          bound('cowork:stream:permission', [{ sessionId: pending.sessionId, request: pending.request }]);
        }, 60);
        return { success: true, session: { ...session, messages: [...session.messages] } };
      }
      startFixtureTurn(session, text);
      return { success: true, session: { ...session, messages: [...session.messages] } };
    }
    case 'cowork:session:submitInput': {
      const input = args[0] ?? {};
      const session = sessions.get(input.sessionId);
      if (!session) return { success: false, code: 'session_not_found', error: 'session not found' };
      const message = {
        id: `gw-msg-${++messageSeq}`,
        type: 'user',
        content: input.text || '',
        timestamp: Date.now(),
        metadata: { submissionId: input.submissionId },
      };
      session.messages.push(message);
      startFixtureTurn(session, input.text || '');
      return { success: true, mode: 'steer', message };
    }
    case 'cowork:session:get': {
      const session = sessions.get(args[0]);
      if (!session) return { success: false, error: 'session not found' };
      const limit = args[1]?.messageLimit ?? 200;
      return { success: true, session: { ...session, messages: session.messages.slice(-limit) } };
    }
    case 'cowork:session:list':
      return { success: true, sessions: [...sessions.values()].map(summaryOf) };
    case 'cowork:session:stop': {
      const session = sessions.get(args[0]);
      if (session) session.status = 'idle';
      return { success: true };
    }
    case 'cowork:stream:liveContent': {
      const key = `${args[0]?.sessionId}${args[0]?.messageId}`;
      return { success: true, content: liveMessages.get(key)?.content ?? '' };
    }
    case 'gateway:file:sign': {
      // Real signing against the compiled pure core (mirrors
      // src/main/gateway/fileSignChannel.ts) so the spec exercises the same
      // url/disposition semantics production mobile clients get.
      const input = args[0] ?? {};
      const result = fileSignCore.signFileDownload(
        { secret: SECRET, tenantId: TENANT, paths, realpathSync: fs.realpathSync },
        {
          path: typeof input.path === 'string' ? input.path : '',
          disposition: input.disposition === 'inline' ? 'inline' : 'attachment',
        },
      );
      if (fileSignCore.isSignedFileDownload(result)) {
        return {
          ...result,
          expiresAt: input.path.endsWith('gateway-e2e-refresh.md') ? Date.now() + 61_500 : result.expiresAt,
        };
      }
      return { success: false, error: result.message, code: result.code };
    }
    case 'cowork:permission:respond': {
      const input = args[0] ?? {};
      const index = pendingPermissions.findIndex((entry) => entry.request.requestId === input.requestId);
      if (index === -1) return { success: false, error: 'no pending permission in the fixture' };
      const [removed] = pendingPermissions.splice(index, 1);
      const resolution = input.result?.behavior === 'allow'
        ? { resolved: true, behavior: 'allow' }
        : { resolved: true, behavior: 'deny' };
      const parent = sessions.get(removed.sessionId);
      if (parent) {
        parent.messages.push({
          id: `gw-msg-${++messageSeq}`,
          type: 'tool_use',
          content: `Permission ${resolution.behavior}: ${input.requestId}`,
          timestamp: Date.now(),
          metadata: { submissionId: input.requestId },
        });
      }
      broadcast?.('cowork:stream:permissionResolved', [{ sessionId: removed.sessionId, requestId: input.requestId }]);
      broadcast?.('cowork:stream:message', [{ sessionId: removed.sessionId, message: { id: `gw-msg-${messageSeq}`, type: 'tool_use', content: `Permission ${resolution.behavior}: ${input.requestId}`, timestamp: Date.now(), metadata: { submissionId: input.requestId } } }]);
      return { success: true, resolution };
    }
    case 'mobile:permission:listPending':
      return [...pendingPermissions];
    case 'mobile:bootstrap:status':
      return {
        identity: 'done',
        llmProvider: 'done',
        twinMetabot: 'done',
        workspace: 'done',
        trafficAccount: 'done',
        redeemCode: 'skipped',
        globalMetaId: null,
        twinMetabotId: null,
      };
    case 'store:get':
    case 'store:getStrict':
      return appConfigStore[args[0]] ?? null;
    case 'store:set':
      appConfigStore[args[0]] = { ...appConfigStore[args[0]], ...args[1] };
      return { success: true };
    case 'app:getVersion':
      return '0.0.0-gateway-e2e';
    case 'app:getSystemLocale':
      return 'en-US';
    case 'scheduledTask:list':
      return { success: true, tasks: structuredClone(scheduledTasks) };
    case 'scheduledTask:get': {
      const task = scheduledTasks.find((candidate) => candidate.id === args[0]);
      return task ? { success: true, task: structuredClone(task) } : { success: false, error: 'task not found' };
    }
    case 'scheduledTask:create': {
      const input = args[0] ?? {};
      if (typeof input.name !== 'string' || !input.name.trim() || typeof input.prompt !== 'string' || !input.prompt.trim()) {
        return { success: false, error: 'name and prompt are required' };
      }
      if (!input.schedule || (input.schedule.type === 'interval' && !(input.schedule.intervalMs > 0))) {
        return { success: false, error: 'invalid schedule' };
      }
      const task = fixtureTask(`gw-task-${++taskSeq}`, input.name.trim(), input.enabled !== false, input.schedule);
      task.description = typeof input.description === 'string' ? input.description : '';
      task.prompt = input.prompt;
      task.workingDirectory = typeof input.workingDirectory === 'string' && input.workingDirectory.trim()
        ? input.workingDirectory
        : paths.workspaceRoot;
      task.systemPrompt = typeof input.systemPrompt === 'string' ? input.systemPrompt : '';
      task.executionMode = input.executionMode === 'local' ? 'local' : 'auto';
      task.metabotId = Number.isInteger(input.metabotId) && input.metabotId > 0 ? input.metabotId : null;
      task.targetSessionId = typeof input.targetSessionId === 'string' ? input.targetSessionId : null;
      task.memoryAccess = ['none', 'read-only', 'read-write'].includes(input.memoryAccess) ? input.memoryAccess : 'none';
      task.expiresAt = typeof input.expiresAt === 'string' ? input.expiresAt : null;
      task.notifyPlatforms = Array.isArray(input.notifyPlatforms) ? [...input.notifyPlatforms] : [];
      task.exitCondition = typeof input.exitCondition === 'string' ? input.exitCondition : null;
      task.maxFires = typeof input.maxFires === 'number' ? input.maxFires : null;
      scheduledTasks.push(task);
      broadcast?.('scheduledTask:statusUpdate', [{ taskId: task.id, state: { ...task.state } }]);
      return { success: true, task: structuredClone(task) };
    }
    case 'scheduledTask:update': {
      const task = scheduledTasks.find((candidate) => candidate.id === args[0]);
      if (!task) return { success: false, error: `Task not found: ${args[0]}` };
      const changes = args[1] && typeof args[1] === 'object' ? args[1] : {};
      const previousMetabotId = task.metabotId;
      const updated = { ...task };
      const editable = [
        'name', 'description', 'schedule', 'prompt', 'workingDirectory', 'systemPrompt',
        'executionMode', 'metabotId', 'targetSessionId', 'memoryAccess', 'expiresAt',
        'notifyPlatforms', 'enabled', 'exitCondition', 'maxFires',
      ];
      for (const key of editable) {
        if (Object.hasOwn(changes, key) && changes[key] !== undefined) updated[key] = changes[key];
      }
      if (typeof updated.name !== 'string' || !updated.name.trim() || typeof updated.prompt !== 'string' || !updated.prompt.trim()) {
        return { success: false, error: 'name and prompt are required' };
      }
      Object.assign(task, updated, {
        name: updated.name.trim(),
        updatedAt: new Date().toISOString(),
        state: {
          ...task.state,
          nextRunAtMs: updated.enabled ? nextScheduledAt(updated.schedule, Date.now()) : null,
        },
      });
      if (Object.hasOwn(changes, 'metabotId') && updated.metabotId !== previousMetabotId) {
        task.coworkSessionId = null;
        task.targetSessionId = null;
      }
      broadcast?.('scheduledTask:statusUpdate', [{ taskId: task.id, state: { ...task.state } }]);
      return { success: true, task: structuredClone(task) };
    }
    case 'scheduledTask:toggle': {
      const task = scheduledTasks.find((candidate) => candidate.id === args[0]);
      if (!task) return { success: false, error: 'task not found' };
      task.enabled = Boolean(args[1]);
      task.state = {
        ...task.state,
        nextRunAtMs: task.enabled ? nextScheduledAt(task.schedule, Date.now()) : null,
      };
      task.updatedAt = new Date().toISOString();
      broadcast?.('scheduledTask:statusUpdate', [{ taskId: task.id, state: { ...task.state } }]);
      return { success: true, task: structuredClone(task) };
    }
    case 'scheduledTask:runManually': {
      const task = scheduledTasks.find((candidate) => candidate.id === args[0]);
      if (!task) return { success: false, error: 'task not found' };
      startScheduledRun(task, 'manual');
      return { success: true };
    }
    case 'scheduledTask:stop':
      return { success: true, result: stopScheduledRuns(args[0]) };
    case 'scheduledTask:delete': {
      const id = args[0];
      stopScheduledRuns(id);
      const index = scheduledTasks.findIndex((candidate) => candidate.id === id);
      if (index < 0) return { success: true, result: false };
      scheduledTasks.splice(index, 1);
      scheduledRuns.delete(id);
      return { success: true, result: true };
    }
    case 'scheduledTask:listRuns': {
      const runs = scheduledRuns.get(args[0]) ?? [];
      const offset = args[2] ?? 0;
      const limit = args[1] ?? 50;
      return { success: true, runs: structuredClone(runs.slice(offset, offset + limit)) };
    }
    case 'scheduledTask:countRuns':
      return { success: true, count: (scheduledRuns.get(args[0]) ?? []).length };
    case 'scheduledTask:listAllRuns': {
      const runs = [...scheduledRuns.values()].flat().sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
      const limit = args[0] ?? 50;
      const offset = args[1] ?? 0;
      return { success: true, runs: structuredClone(runs.slice(offset, offset + limit)) };
    }
    case 'longtermTask:board':
      return { success: true, board: longTermBoard(structuredClone(longTermDetail)) };
    case 'longtermTask:get': {
      if (args[0]?.taskId !== longTermDetail.id) return { success: false, error: 'Task not found' };
      return { success: true, detail: structuredClone(longTermDetail) };
    }
    case 'longtermTask:setStage': {
      const input = args[0] ?? {};
      if (input.taskId !== longTermDetail.id) return { ok: false, code: 'NOT_FOUND', error: 'Task not found' };
      const validTransition = input.action === 'pause'
        ? longTermDetail.stage === 'active'
        : input.action === 'resume'
          ? longTermDetail.stage === 'paused' || longTermDetail.stage === 'defining'
          : input.action === 'cancel' && longTermDetail.stage !== 'done' && longTermDetail.stage !== 'cancelled';
      if (!validTransition) return { ok: false, code: 'VALIDATION', error: 'Invalid task stage transition' };
      longTermDetail = applyLongTermStage(longTermDetail, input.action, new Date().toISOString());
      longTermSeq += 1;
      broadcast?.('longtermTask:update', [{ seq: longTermSeq, taskIds: [longTermDetail.id], reason: `stage_${input.action}` }]);
      return { ok: true, value: input.action === 'cancel' ? null : structuredClone(longTermDetail) };
    }
    case 'metabot:list':
      return { success: true, list: metabots.map((bot) => ({ ...bot })) };
    case 'metabot:get': {
      const bot = metabots.find((entry) => entry.id === args[0]);
      return bot ? { success: true, metabot: { ...bot } } : { success: false, error: 'metabot not found' };
    }
    case 'metabot:update': {
      const bot = metabots.find((entry) => entry.id === args[0]);
      if (!bot) return { success: false, error: 'metabot not found' };
      const input = args[1] ?? {};
      for (const key of ['name', 'role', 'soul', 'bio', 'goal', 'llm_id', 'llm_provider', 'llm_effort', 'allow_chat_skills', 'enabled']) {
        if (Object.hasOwn(input, key) && input[key] !== undefined) bot[key] = input[key];
      }
      bot.metabot_info_pinid = bot.metabot_info_pinid ?? `gw-info-${bot.id}`;
      bot.chain_sync_state = 'synced';
      bot.chain_sync_pending_steps = [];
      bot.updated_at = Date.now();
      return { success: true, metabot: { ...bot }, sync: { skipped: false, success: true, syncedSteps: ['persona', 'llm', 'chatSkills'] } };
    }
    case 'metabot:setEnabled': {
      const bot = metabots.find((entry) => entry.id === args[0]);
      if (!bot) return { success: false, error: 'metabot not found' };
      bot.enabled = Boolean(args[1]);
      bot.updated_at = Date.now();
      return { success: true, metabot: { ...bot } };
    }
    case 'idbots:createMetaBotOnChain': {
      const input = args[0] ?? {};
      if (typeof input.name !== 'string' || !input.name.trim()) return { success: false, error: 'name is required' };
      if (!input.llm_id) return { success: false, error: 'LLM Brain is required when creating a MetaBot' };
      const timestamp = Date.now();
      const bot = {
        id: ++metabotSeq,
        wallet_id: metabotSeq,
        name: input.name.trim(),
        avatar: input.avatar ?? null,
        enabled: true,
        globalmetaid: `gmid-gateway-${metabotSeq}`,
        metabot_type: input.metabot_type === 'twin' ? 'twin' : 'worker',
        role: input.role ?? '',
        soul: input.soul ?? '',
        goal: input.goal ?? null,
        bio: input.bio ?? null,
        background: input.background ?? null,
        boss_id: null,
        boss_global_metaid: input.boss_global_metaid ?? null,
        llm_id: input.llm_id,
        llm_provider: input.llm_provider ?? null,
        llm_effort: input.llm_effort ?? null,
        mvc_address: `gw-mvc-${metabotSeq}`,
        metabot_info_pinid: `gw-info-${metabotSeq}`,
        chain_sync_state: 'synced',
        chain_sync_pending_steps: [],
        subsidy_state: 'claimed',
        tools: [],
        skills: [],
        allow_chat_skills: [...(input.allow_chat_skills ?? [])],
        created_at: timestamp,
        updated_at: timestamp,
      };
      metabots.push(bot);
      return { success: true, metabot: { ...bot }, subsidy: { success: true } };
    }
    case 'idbots:resumeMetabotSetup': {
      const input = args[0] ?? {};
      const bot = metabots.find((entry) => entry.id === input.metabotId);
      if (!bot) return { success: false, mode: input.mode, error: 'metabot not found' };
      bot.metabot_info_pinid = bot.metabot_info_pinid ?? `gw-info-${bot.id}`;
      bot.chain_sync_state = 'synced';
      bot.chain_sync_pending_steps = [];
      bot.subsidy_state = 'claimed';
      return { success: true, mode: input.mode, metabot: { ...bot }, subsidy: { success: true }, chain: { success: true } };
    }
    case 'idbots:syncMetaBot': {
      const bot = metabots.find((entry) => entry.id === args[0]);
      if (!bot) return { success: false, error: 'metabot not found' };
      bot.metabot_info_pinid = bot.metabot_info_pinid ?? `gw-info-${bot.id}`;
      bot.chain_sync_state = 'synced';
      bot.chain_sync_pending_steps = [];
      return { success: true, metabotInfoPinId: bot.metabot_info_pinid, txids: [`gw-sync-${bot.id}`] };
    }
    case 'idbots:getAddressBalance':
      return { success: true, balance: { mvc: { value: args[0]?.metabotId ? 0.0002 : 0.001, unit: 'MVC' } } };
    case 'skills:list':
      return { success: true, skills: skillFixtures.map((skill) => ({ ...skill })) };
    case 'cowork:config:get':
      return { success: true, config: { ...coworkConfig } };
    case 'cowork:config:set': {
      Object.assign(coworkConfig, args[0] ?? {});
      return { success: true };
    }
    case 'bundle:getPlans':
      return { success: true, plans: bundlePlans.map((plan) => ({ ...plan })) };
    case 'bundle:createOrder': {
      const plan = bundlePlans.find((entry) => entry.planId === args[0]?.planId && entry.status === 1);
      if (!plan) return { success: false, error: 'plan not found or off sale' };
      const orderId = `gw-bundle-${++bundleOrderSeq}`;
      const order = {
        orderId,
        planId: plan.planId,
        status: 1,
        payAmount: plan.payAmount,
        payCurrency: plan.payCurrency,
        trafficBytes: plan.trafficBytes,
        llmQuota: plan.llmQuota,
        gatewayParams: { qrCode: `https://qr.alipay.com/gateway-${orderId}` },
        expiresAt: Math.floor(Date.now() / 1000) + 900,
        paidAt: undefined,
        creditedAt: undefined,
      };
      bundleOrders.set(orderId, order);
      setTimeout(() => {
        if (order.status === 3) return;
        order.status = 3;
        order.paidAt = Math.floor(Date.now() / 1000);
        order.creditedAt = order.paidAt;
        bundleMeters.traffic.balanceBytes += order.trafficBytes;
        bundleMeters.traffic.grantedBytesTotal += order.trafficBytes;
        bundleMeters.llm.quotaTotal += order.llmQuota;
        bundleMeters.llm.quotaPurchased += order.llmQuota;
        bundleMeters.llm.quotaRemaining = bundleMeters.llm.quotaTotal - bundleMeters.llm.quotaUsed;
      }, 8000);
      const { status: _status, paidAt: _paidAt, creditedAt: _creditedAt, ...created } = order;
      return { success: true, order: created };
    }
    case 'bundle:getOrder': {
      const order = bundleOrders.get(args[0]?.orderId);
      if (!order) return { success: false, error: 'order not found' };
      const { gatewayParams: _gatewayParams, expiresAt: _expiresAt, ...status } = order;
      return { success: true, order: status };
    }
    case 'bundle:getMeters':
      return {
        success: true,
        meters: {
          traffic: { ...bundleMeters.traffic },
          llm: { ...bundleMeters.llm },
        },
      };
    case 'me:getPlans':
      return { success: true, plans: mePlans.map((plan) => ({ ...plan })) };
    case 'me:getRates':
      return { success: true, rates: [
        { key: 'deepseek-chat', multiplier: 1 },
        { key: 'cerebellum', multiplier: 1 },
        { key: 'mvc-traffic', multiplier: 1 },
      ] };
    case 'me:getTopupPackages':
      return { success: true, topupPackages: meTopupPackages.map((pkg) => ({ ...pkg })) };
    case 'me:getBalance':
      return { success: true, balance: meBalance() };
    case 'me:getSubscription':
      return {
        success: true,
        subscription: {
          statusText: meState.subscribed ? 'active' : 'free',
          raw: { planId: meState.activePlanId },
        },
      };
    case 'me:getHistory':
      return { success: true, history: { entries: [], nextCursor: '' } };
    case 'me:subscriptionOrder': {
      const input = args[0] ?? {};
      if (input.orderId) {
        const order = meSubscriptionOrders.get(input.orderId);
        return order
          ? { success: true, subscriptionOrder: { ...order } }
          : { success: false, error: 'order not found', errorCode: 'ORDER_NOT_FOUND' };
      }
      const plan = mePlans.find((entry) => entry.planId === input.planId && entry.tier !== 'free');
      if (!plan) return { success: false, error: 'plan not found' };
      const existing = input.idempotencyKey
        ? [...meSubscriptionOrders.values()].find((order) => order.idempotencyKey === input.idempotencyKey)
        : null;
      if (existing) return { success: true, subscriptionOrder: { ...existing } };
      const orderId = `gw-me-subscription-${++meSubscriptionSeq}`;
      const multiplier = input.period === 'year' ? 9.6 : input.period === 'quarter' ? 2.7 : 1;
      const payAmount = Math.round(plan.priceCny * multiplier * 100) / 100;
      const order = {
        orderId,
        planId: plan.planId,
        period: input.period ?? 'month',
        channel: 'mobile',
        status: 'submitted',
        amountCny: payAmount,
        payAmount,
        payCurrency: 'CNY',
        gatewayParams: {
          approvalUrl: `https://pay.gateway.fixture/${orderId}`,
          qrCode: `https://pay.gateway.fixture/${orderId}`,
          expiresAt: Date.now() + 15 * 60_000,
        },
        createdAt: Math.floor(Date.now() / 1000),
        idempotencyKey: input.idempotencyKey,
      };
      meSubscriptionOrders.set(orderId, order);
      setTimeout(() => {
        if (order.status === 'confirmed') return;
        order.status = 'confirmed';
        order.confirmedAt = Math.floor(Date.now() / 1000);
        meState.subscribed = true;
        meState.activePlanId = plan.planId;
        meState.weeklyAmountMilli = plan.weeklyAmountMilli;
        meState.weeklyRemainingMilli = Math.round(plan.weeklyAmountMilli * 0.624);
      }, 8000);
      return { success: true, subscriptionOrder: { ...order } };
    }
    case 'me:getSubscriptionOrders':
      return { success: true, orders: [...meSubscriptionOrders.values()].map((order) => ({ ...order })) };
    case 'me:submitTopupOrder': {
      if (!meState.subscribed) {
        return { success: false, error: 'an active paid plan is required before top-up', errorCode: 'SUBSCRIPTION_REQUIRED' };
      }
      const input = args[0] ?? {};
      const pkg = meTopupPackages.find((entry) => entry.packageId === input.packageId);
      if (!pkg) return { success: false, error: 'package not found' };
      const existing = input.idempotencyKey
        ? [...meTopupOrders.values()].find((order) => order.idempotencyKey === input.idempotencyKey)
        : null;
      if (existing) return { success: true, submission: { order: { ...existing }, applied: false } };
      const orderId = `gw-me-topup-${++meTopupSeq}`;
      const order = {
        orderId,
        packageId: pkg.packageId,
        status: 'submitted',
        createdAt: Math.floor(Date.now() / 1000),
        meMilli: pkg.meMilli,
        priceCny: pkg.priceCny,
        payAmount: pkg.priceCny,
        payCurrency: 'CNY',
        gatewayParams: { qrCode: `https://pay.gateway.fixture/${orderId}` },
        idempotencyKey: input.idempotencyKey,
      };
      meTopupOrders.set(orderId, order);
      setTimeout(() => {
        if (order.status === 'confirmed') return;
        order.status = 'confirmed';
        order.confirmedAt = Math.floor(Date.now() / 1000);
        meState.topupMilli += pkg.meMilli;
      }, 8000);
      return { success: true, submission: { order: { ...order }, applied: false } };
    }
    case 'me:getTopupOrders':
      return { success: true, orders: [...meTopupOrders.values()].map((order) => ({ ...order })) };
    case 'me:getPaymentInfo':
      return { success: true, payment: { qrContent: 'https://pay.gateway.fixture/account', payeeHint: 'Gateway fixture payee' } };
    case 'startup:rendererInitialized':
      return { success: true, elapsedMs: 0, startedAt: Date.now() };
    default:
      return { ok: true, channel, clientId };
  }
}

async function startFixture() {
  const handle = await server.startGateway({
    host: '127.0.0.1',
    port: Number(GATEWAY_PORT),
    secret: SECRET,
    tenantId: TENANT,
    tier: 'P1',
    contractVersion: '1.0.0',
    appVersion: '0.0.0-gateway-e2e',
    commit: 'e2e',
    paths,
    readiness: () => ({
      phase: 'ready',
      version: '0.0.0-gateway-e2e',
      commit: 'e2e',
      contractVersion: '1.0.0',
      onboarding: {
        identity: 'done',
        llmProvider: 'done',
        twinMetabot: 'done',
        workspace: 'done',
        trafficAccount: 'done',
        redeemCode: 'skipped',
        globalMetaId: null,
        twinMetabotId: null,
      },
      error: null,
    }),
    invokeHandler,
    hasHandler: () => true,
    addBroadcastListener: (listener) => {
      broadcast = listener;
      return () => {
        broadcast = null;
      };
    },
    storeGet: (key) => appConfigStore[key],
    revealMnemonic: async () => 'word1 word2 word3',
    logger: () => {},
  });
  return handle;
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

const viteBin = path.join(repoRoot, 'node_modules', '.bin', 'vite');
const playwrightCli = path.join(repoRoot, 'node_modules', '@playwright', 'test', 'cli.js');

function waitForServer(url, timeoutMs = 45_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(`${url}/app/`, { cache: 'no-store' });
        if (res.ok) {
          resolve();
          return;
        }
      } catch {
        // not up yet
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`timed out waiting for ${url}/app/`));
        return;
      }
      setTimeout(tick, 300);
    };
    tick();
  });
}

const children = [];
function cleanup() {
  for (const child of children.splice(0)) {
    try {
      child.kill('SIGTERM');
    } catch {
      // already gone
    }
  }
}
process.on('SIGINT', () => {
  cleanup();
  process.exit(130);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(143);
});

async function main() {
  const forwardedArgs = process.argv.slice(2);
  const hasProject = forwardedArgs.some((arg) => arg === '--project' || arg.startsWith('--project='));
  if (!hasProject) {
    for (const project of ['iphone14', 'pixel7']) {
      console.log(`[gateway-e2e] starting an isolated ${project} fixture`);
      const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--project', project, ...forwardedArgs], {
        cwd: repoRoot,
        env: process.env,
        stdio: 'inherit',
      });
      if (run.error) throw run.error;
      if (run.status !== 0) process.exit(run.status ?? 1);
    }
    process.exit(0);
  }

  let fixture;
  try {
    fixture = await startFixture();
  } catch (error) {
    console.error(
      `[gateway-e2e] could not start the fixture gateway on 127.0.0.1:${GATEWAY_PORT}: ${error.message}\n` +
        '[gateway-e2e] free the port (another gateway running?) and retry.',
    );
    process.exit(1);
  }
  console.log(`[gateway-e2e] fixture gateway up on 127.0.0.1:${GATEWAY_PORT} (tenant ${TENANT})`);

  const vite = spawn(viteBin, ['--config', 'vite.mobile.config.ts', '--port', APP_PORT, '--strictPort'], {
    cwd: repoRoot,
    env: { ...process.env, IDBOTS_GATEWAY_SECRET: SECRET, MOBILE_FORCE_COLOR: '0' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  children.push(vite);
  vite.stderr.on('data', (chunk) => process.stderr.write(`[vite] ${chunk}`));

  let exitCode = 1;
  try {
    await waitForServer(BASE_URL);
    console.log(`[gateway-e2e] dev:mobile:real up at ${BASE_URL} (real bridge, no mock)`);

    const run = spawn(
      process.execPath,
      [playwrightCli, 'test', '--grep', '@gateway', '--workers=1', ...process.argv.slice(2)],
      {
        cwd: repoRoot,
        env: { ...process.env, E2E_BASE_URL: BASE_URL, E2E_GATEWAY: '1' },
        stdio: 'inherit',
      },
    );
    children.push(run);
    exitCode = await new Promise((resolve) => {
      run.on('exit', (code) => resolve(code ?? 1));
      run.on('error', () => resolve(1));
    });
  } finally {
    cleanup();
    for (const sessionId of [...sessionTimers.keys()]) clearTurnTimers(sessionId);
    for (const { timer } of activeRuns.values()) clearTimeout(timer);
    activeRuns.clear();
    await fixture.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
  process.exit(exitCode);
}

main().catch((error) => {
  console.error('[gateway-e2e]', error);
  cleanup();
  process.exit(1);
});
