// Requires: pnpm run compile:electron (this suite loads the compiled modules).
//
// C3 projection discipline (2026-11-12 owner ruling): a projection is the
// Twin reporting to its boss — only at the END of a round, only when the
// task is done / the owner must decide / a next step is recommended. While
// delegated work is still out, BOTH projection entries refuse with plain
// guidance: bot_browser_preview_local(projection=true) returns the section-5
// text, projection_begin returns the section-6 text and never engages fast
// mode. The gate counts only queued/running attempts — a timed-out attempt
// whose worker session still runs does NOT block (the orchestration service
// marks it completed before notifying the Twin, and it can recover).

import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = Module.createRequire(import.meta.url);

function requireElectronBacked(relativePath) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: (name) => `/tmp/idbots-projection-gate-${name}`,
          getLocale: () => 'en-US',
          getPreferredSystemLanguages: () => ['en-US'],
          getSystemLocale: () => 'en-US',
        },
      };
    }
    return originalLoad.apply(this, arguments);
  };
  try {
    return require(relativePath);
  } finally {
    Module._load = originalLoad;
  }
}

const { listStudioOpenDelegations } = require('../dist-electron/main/services/studioOpenDelegations.js');
const { describeStudioProjectionBlock } = require('../dist-electron/main/services/studioProjectionGate.js');
const { buildBotBrowserAgentTools } = require('../dist-electron/main/libs/botBrowserAgentTools.js');
const appLanguage = requireElectronBacked('../dist-electron/main/libs/appLanguage.js');
const assistantModePrompt = requireElectronBacked('../dist-electron/main/libs/assistantModePrompt.js');
const { CoworkRunner } = requireElectronBacked('../dist-electron/main/libs/coworkRunner.js');

// ---------------------------------------------------------------------------
// Prompt text (sections 1-4 of the authored ruling)
// ---------------------------------------------------------------------------

function withAppLanguage(language, fn) {
  appLanguage.setAppLanguageStoreGetter(() => ({
    get: () => ({ language, language_initialized: true }),
  }));
  try {
    return fn();
  } finally {
    appLanguage.setAppLanguageStoreGetter(() => null);
  }
}

test('projector prompt: zh carries the hard-rule when-to-project and status-tag design', () => {
  const prompt = withAppLanguage('zh', () => assistantModePrompt.buildProjectorModePrompt());
  assert.match(prompt, /\*\*何时投影（硬规则）。\*\*/, 'the zh paragraph is the new hard-rule text');
  assert.match(prompt, /投影就是向老板交代/, 'projection = reporting to the boss');
  assert.match(prompt, /绝不投影过程页/, 'the no-progress-page ban is present');
  assert.match(prompt, /每页最上方先放一个醒目的状态标签——「已完成」「需要你拍板」或「建议下一步」/, 'the status-tag sentence leads the design paragraph');
  assert.ok(!prompt.includes('结论先行，做成一条大标题'), 'the old conclusion-first clause is gone');
  assert.ok(!prompt.includes('当本轮产出了值得看的东西'), 'the old when-to-project paragraph is gone');
});

test('projector prompt: en carries the hard-rule when-to-project and status-tag design', () => {
  const prompt = withAppLanguage('en', () => assistantModePrompt.buildProjectorModePrompt());
  assert.match(prompt, /\*\*When to project \(hard rule\)\.\*\*/, 'the en paragraph is the new hard-rule text');
  assert.match(prompt, /A projection is you reporting to your boss/, 'projection = reporting to the boss');
  assert.match(prompt, /\*\*Never project a progress page:\*\*/, 'the no-progress-page ban is present');
  assert.match(prompt, /open with a prominent status tag — "Done", "Your call" or "Recommended next step" — then the conclusion as one big headline/, 'the status-tag clause leads the design paragraph');
  assert.ok(!prompt.includes('conclusion first as one big headline'), 'the old conclusion-first clause is gone');
  assert.ok(!prompt.includes('something worth seeing'), 'the old when-to-project paragraph is gone');
});

// ---------------------------------------------------------------------------
// Delegation filtering: only queued/running attempts gate a projection
// ---------------------------------------------------------------------------

const GATE_NOW = Date.parse('2026-02-01T12:00:00Z');
const gateIso = (ms) => new Date(ms).toISOString();

function gateDeps() {
  const attempts = [
    { id: 'att-running', stepId: 'step-1', workerMetabotId: 2, workerSessionId: 'ws-1', status: 'running', queuedAt: gateIso(GATE_NOW - 3_600_000), startedAt: gateIso(GATE_NOW - 3_500_000) },
    { id: 'att-queued', stepId: 'step-2', workerMetabotId: 3, workerSessionId: 'ws-2', status: 'queued', queuedAt: gateIso(GATE_NOW - 600_000), startedAt: null },
    // timed_out but the worker session is still running: open for the Live
    // Stage / panel, but NOT a projection blocker.
    { id: 'att-timeout-live', stepId: 'step-3', workerMetabotId: 4, workerSessionId: 'ws-3', status: 'timed_out', queuedAt: gateIso(GATE_NOW - 7_200_000), startedAt: gateIso(GATE_NOW - 7_000_000) },
    { id: 'att-done', stepId: 'step-4', workerMetabotId: 5, workerSessionId: 'ws-4', status: 'completed', queuedAt: gateIso(GATE_NOW - 900_000), startedAt: gateIso(GATE_NOW - 800_000) },
  ];
  return {
    listAttemptsForSourceSessions: (ids) => (ids.includes('src-session') ? attempts : []),
    getStep: (id) => ({ id, title: `Step ${id}` }),
    getTaskForStep: (id) => ({ status: 'running', ownerIntent: `Delegate ${id} to the worker` }),
    getSession: (id) => ({ status: id === 'ws-3' ? 'running' : 'completed' }),
    getMetabotById: (id) => ({ name: `Bot${id}` }),
  };
}

test('activeAttemptsOnly counts queued/running only — timed_out with a live worker does not gate', () => {
  const deps = gateDeps();
  const all = listStudioOpenDelegations(deps, 'src-session', GATE_NOW);
  assert.deepEqual(all.map((entry) => entry.attemptId).sort(), ['att-queued', 'att-running', 'att-timeout-live'],
    'default keeps the timed_out-with-running-worker heuristic (Live Stage / panel unchanged)');

  const blocking = listStudioOpenDelegations(deps, 'src-session', GATE_NOW, { activeAttemptsOnly: true });
  assert.deepEqual(blocking.map((entry) => entry.attemptId).sort(), ['att-queued', 'att-running'],
    'the projection gate sees only attempts whose own status is queued/running');
});

test('describeStudioProjectionBlock formats the section-5/6 texts and passes on empty', () => {
  const delegations = [
    { attemptId: 'a1', workerMetabotId: 2, workerName: 'Builder阿码', title: '核对交付物', startedAt: 1 },
    { attemptId: 'a2', workerMetabotId: 3, workerName: 'Builder阿码', title: '起草文案', startedAt: 2 },
    { attemptId: 'a3', workerMetabotId: 4, title: '查资料', startedAt: 3 },
  ];
  const preview = describeStudioProjectionBlock(delegations, 'preview');
  assert.equal(
    preview,
    'Not projected: Builder阿码, a worker bot is still working on the work you delegated ("核对交付物"). A projection is a report to the owner, so it waits until that work is back and you have verified it. End this turn now with a short chat reply — who is doing what, and that you will check it and report when it is back. The Live Stage already shows the collaboration. Project the result page in the turn where the worker reports back.',
    'worker names dedupe, unnamed workers fall back, first title wins',
  );
  const begin = describeStudioProjectionBlock(delegations, 'begin');
  assert.equal(
    begin,
    'Not now: Builder阿码, a worker bot is still working on the work you delegated ("核对交付物"), so do not write a projection page this turn. End the turn with a short chat reply instead; project the result after the worker reports back and you have verified it.',
  );
  assert.equal(describeStudioProjectionBlock([], 'preview'), null, 'no open delegations → no block');
  assert.equal(describeStudioProjectionBlock([], 'begin'), null);
});

// ---------------------------------------------------------------------------
// bot_browser_preview_local gate
// ---------------------------------------------------------------------------

function previewHarness({ blockedReason, withProjectReport = true } = {}) {
  const calls = { projectReport: [] };
  const control = {
    execute: async () => ({ action: 'open-tab', tabs: [], activeTab: null }),
    ...(blockedReason !== undefined ? { projectionBlockedReason: () => blockedReason } : {}),
    ...(withProjectReport
      ? {
          projectReport: async (input) => {
            calls.projectReport.push(input);
            return { uri: 'preview-metaapp://localhost/x', tabId: 7, announced: true };
          },
        }
      : {}),
  };
  const tools = buildBotBrowserAgentTools({
    tool: (name, description, schema, handler) => ({ name, description, handler }),
    controlBotBrowser: control,
    sessionId: 'session-1',
  });
  return { calls, byName: Object.fromEntries(tools.map((tool) => [tool.name, tool])) };
}

async function withTempHtml(fn) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'projection-gate-'));
  try {
    const filePath = path.join(dir, 'report.html');
    await fs.promises.writeFile(filePath, '<html><body>report</body></html>', 'utf8');
    return await fn(filePath);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

test('bot_browser_preview_local projection is refused with the gate text while work is out', async () => {
  await withTempHtml(async (filePath) => {
    const { calls, byName } = previewHarness({ blockedReason: 'Not projected: Builder阿码 is still working on the work you delegated ("核对").' });
    const result = await byName.bot_browser_preview_local.handler({ path: filePath, projection: true });
    assert.equal(result.isError, true, 'the refusal follows the file convention for refused results');
    assert.equal(result.content[0].text, 'Not projected: Builder阿码 is still working on the work you delegated ("核对").',
      'the gate text reaches the model verbatim — no Failed-to-project prefix, no surface hint');
    assert.equal(calls.projectReport.length, 0, 'projectReport is NOT called while blocked');
  });
});

test('bot_browser_preview_local projection proceeds when the gate returns null or is absent', async () => {
  await withTempHtml(async (filePath) => {
    const open = previewHarness({ blockedReason: null });
    const result = await open.byName.bot_browser_preview_local.handler({ path: filePath, projection: true });
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /Projected .* onto the Bot Internet projector/);
    assert.equal(open.calls.projectReport.length, 1, 'null gate → normal projection path');

    const legacy = previewHarness();
    const legacyResult = await legacy.byName.bot_browser_preview_local.handler({ path: filePath, projection: true });
    assert.equal(legacyResult.isError, undefined, 'hosts without the hook keep the old behavior');
    assert.equal(legacy.calls.projectReport.length, 1);
  });
});

// ---------------------------------------------------------------------------
// projection_begin runner gate
// ---------------------------------------------------------------------------

class ProjectionGateStore {
  constructor() {
    this.messages = [];
  }
  getSession() { return null }
  getConfig() { return {} }
  addMessage(sessionId, message) {
    const stored = { id: `m-${this.messages.length + 1}`, timestamp: Date.now(), ...message };
    this.messages.push({ sessionId, ...stored });
    return stored;
  }
}

function runnerHarness({ blockedReason } = {}) {
  const store = new ProjectionGateStore();
  const runner = new CoworkRunner(store, {
    localTurnStallTimeoutMs: 0,
    projectionBlockedReason: blockedReason,
  });
  runner.isAssistantModeOwnerChatSession = () => true;
  runner.isProjectorModeSession = () => true;
  runner.buildSessionInlineTools = () => [];
  runner.activeSessions.set('s1', {
    sessionId: 's1',
    permissionMode: 'plan',
    assistantOwnerUpdateCount: 0,
    dshTurnAckVisibleTextSeen: false,
    abortController: new AbortController(),
    autoApproveTools: new Set(),
  });
  const fastModeCalls = [];
  runner.dshTurnHub = {
    forceProjectionFastMode: async (sessionId) => {
      fastModeCalls.push(sessionId);
      return { ok: true, effort: 'low' };
    },
  };
  const tools = runner.buildDshHostTools('s1');
  const begin = tools.find((tool) => tool.name === 'projection_begin');
  assert.ok(begin, 'projection_begin mounts on projector sessions');
  return { runner, begin, fastModeCalls };
}

test('projection_begin returns the gate text and never engages fast mode while blocked', async () => {
  const { begin, fastModeCalls } = runnerHarness({ blockedReason: () => 'Not now: Builder阿码 is still working on the work you delegated ("核对"), so do not write a projection page this turn.' });
  const result = await begin.execute({});
  const text = result.content.map((block) => block.text).join('\n');
  assert.equal(text, 'Not now: Builder阿码 is still working on the work you delegated ("核对"), so do not write a projection page this turn.');
  assert.equal(result.isError, undefined, 'the gate result is plain guidance, not a tool error');
  assert.equal(fastModeCalls.length, 0, 'fast mode is NOT engaged while blocked');
});

test('projection_begin engages fast mode when the gate returns null or is absent', async () => {
  const open = runnerHarness({ blockedReason: () => null });
  const result = await open.begin.execute({});
  const text = result.content.map((block) => block.text).join('\n');
  assert.match(text, /Fast mode engaged \(reasoning effort: low\)/);
  assert.deepEqual(open.fastModeCalls, ['s1']);

  const legacy = runnerHarness({});
  const legacyResult = await legacy.begin.execute({});
  assert.match(legacyResult.content[0].text, /Fast mode engaged/);
  assert.deepEqual(legacy.fastModeCalls, ['s1'], 'hosts without the hook keep the old behavior');
});
