import assert from 'node:assert/strict';
import test from 'node:test';
import Module from 'node:module';
import path from 'node:path';

/**
 * REQ-A-25 — quota-exhausted stream error contract.
 *
 * The relay answers HTTP 429 with code free_quota_exhausted (existing) or
 * quota_exhausted (new C4 code for a used-up purchased pool). These tests pin
 * the detection helpers and the CoworkRunner stream-error metadata: the
 * `cowork:stream:error` event must carry metadata.errorCode
 * 'LLM_QUOTA_EXHAUSTED' for both upstream codes and stay metadata-free for
 * every other failure.
 */

const require = Module.createRequire(import.meta.url);

function loadCompiledModule(modulePath) {
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: () => path.join(process.cwd(), '.cowork-temp', 'quota-exhausted-test-user-data'),
        },
        session: { defaultSession: { resolveProxy: async () => 'DIRECT' } },
      };
    }
    return originalLoad.apply(this, arguments);
  };

  try {
    return require(modulePath);
  } finally {
    Module._load = originalLoad;
  }
}

const { CoworkRunner } = loadCompiledModule('../dist-electron/main/libs/coworkRunner.js');
const {
  extractRelayQuotaExhaustedCode,
  isQuotaDshTurnError,
  relayQuotaErrorMetadata,
  LLM_QUOTA_EXHAUSTED_ERROR_CODE,
  buildFreeRelayQuotaNotice,
} = loadCompiledModule('../dist-electron/main/libs/coworkAssistantReply.js');

assert.equal(LLM_QUOTA_EXHAUSTED_ERROR_CODE, 'LLM_QUOTA_EXHAUSTED');

class FakeCoworkStore {
  constructor() {
    this.sessions = new Map();
    this.messageSeq = 0;
  }

  createSession(id) {
    this.sessions.set(id, { id, status: 'idle', messages: [] });
    return this.sessions.get(id);
  }

  getSession(id) {
    return this.sessions.get(id) ?? null;
  }

  addMessage(id, message) {
    const session = this.getSession(id);
    if (!session) throw new Error(`Session ${id} not found`);
    const stored = {
      id: `msg-${++this.messageSeq}`,
      type: message.type,
      content: message.content,
      timestamp: Date.now(),
      ...(message.metadata ? { metadata: message.metadata } : {}),
    };
    session.messages.push(stored);
    return stored;
  }

  updateSession(id, patch) {
    const session = this.getSession(id);
    if (!session) throw new Error(`Session ${id} not found`);
    Object.assign(session, patch);
  }
}

function makeRunner() {
  const store = new FakeCoworkStore();
  store.createSession('s1');
  const runner = new CoworkRunner(store, {
    loadClaudeSdk: async () => {
      throw new Error('Claude Agent SDK local kernel retired; local cowork is DSH-only');
    },
  });
  const errors = [];
  runner.on('error', (sessionId, error, metadata) => {
    errors.push({ sessionId, error, metadata });
  });
  return { runner, store, errors };
}

// The proxy annotates the upstream OpenAI-style 429 body into the surfaced
// message, preserving the machine code (coworkOpenAICompatProxy.ts).
function relayMessage(code) {
  return `429: {"error":{"message":"quota pool empty","code":"${code}"}}`;
}

test('extractRelayQuotaExhaustedCode matches both relay codes and nothing else', () => {
  assert.equal(extractRelayQuotaExhaustedCode(relayMessage('free_quota_exhausted')), 'free_quota_exhausted');
  assert.equal(extractRelayQuotaExhaustedCode(relayMessage('quota_exhausted')), 'quota_exhausted');
  // Substring shape: the more specific free_* code wins even though
  // quota_exhausted is a substring of it.
  assert.equal(
    extractRelayQuotaExhaustedCode('prefix free_quota_exhausted suffix'),
    'free_quota_exhausted',
  );
  assert.equal(extractRelayQuotaExhaustedCode('LLM request failed: 429 rate limited'), null);
  assert.equal(extractRelayQuotaExhaustedCode(null), null);
  assert.equal(extractRelayQuotaExhaustedCode('QUOTA'), null);
});

test('both relay codes classify as quota turn errors through the kernel QUOTA code', () => {
  for (const code of ['free_quota_exhausted', 'quota_exhausted']) {
    const outcome = { kind: 'error', error: { message: relayMessage(code), code: 'QUOTA' } };
    assert.equal(isQuotaDshTurnError(outcome), true, `${code} must read as a quota death`);
    assert.deepEqual(relayQuotaErrorMetadata(outcome.error.message), { errorCode: 'LLM_QUOTA_EXHAUSTED' });
  }
  assert.deepEqual(
    relayQuotaErrorMetadata('429 {"error":{"code":"INSUFFICIENT_ME"}}'),
    { errorCode: 'INSUFFICIENT_ME' },
    'ME-authoritative admission keeps its native machine code',
  );
  assert.equal(
    relayQuotaErrorMetadata('LLM request failed: 502 bad gateway'),
    undefined,
    'non-quota failures must not stamp quota metadata',
  );
});

test('cowork stream error carries metadata.errorCode LLM_QUOTA_EXHAUSTED for both upstream codes', () => {
  for (const code of ['free_quota_exhausted', 'quota_exhausted']) {
    const { runner, store, errors } = makeRunner();
    const message = relayMessage(code);
    runner.handleError('s1', `DSH turn failed: ${message}`, relayQuotaErrorMetadata(message));
    assert.equal(errors.length, 1);
    assert.equal(errors[0].sessionId, 's1');
    assert.deepEqual(errors[0].metadata, { errorCode: 'LLM_QUOTA_EXHAUSTED' });
    // The system transcript message records the same annotated text.
    const session = store.getSession('s1');
    assert.equal(session.messages.length, 1);
    assert.ok(session.messages[0].content.includes(code));
  }
});

test('cowork stream error stays metadata-free for non-quota failures', () => {
  const { runner, errors } = makeRunner();
  runner.handleError('s1', 'DSH turn failed: LLM request failed: 502 bad gateway');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].metadata, undefined);
});

test('quota notice points at recharge in server mode and Settings > Models on desktop', () => {
  const zh = (z, _e) => z;
  const en = (_z, e) => e;
  for (const code of ['free_quota_exhausted', 'quota_exhausted']) {
    for (const t of [zh, en]) {
      const desktop = buildFreeRelayQuotaNotice(code, false, t);
      const server = buildFreeRelayQuotaNotice(code, true, t);
      // The upstream code is interpolated verbatim in both modes (the
      // renderer's quota banner keys off it).
      assert.ok(desktop.includes(code));
      assert.ok(server.includes(code));
      // Desktop wording is unchanged; server mode never points at the
      // nonexistent-on-mobile Settings > Models page.
      assert.ok(desktop.includes('Settings > Models') || desktop.includes('设置 > 模型'));
      assert.ok(!server.includes('Settings > Models') && !server.includes('设置 > 模型'));
      assert.ok(server.includes('Subscribe') || server.includes('充值') || server.includes('套餐'));
    }
  }
});

test('server quota notice does not claim a positive ME balance is exhausted', () => {
  const zh = (z, _e) => z;
  const en = (_z, e) => e;
  for (const t of [zh, en]) {
    const mismatch = buildFreeRelayQuotaNotice('free_quota_exhausted', true, t, { spendableMilli: 864429 });
    assert.ok(mismatch.includes('ME_ADMISSION_MISMATCH'));
    assert.ok(!mismatch.includes('免费体验额度已用完'));
    assert.ok(!mismatch.includes('starter allowance is used up'));
    const empty = buildFreeRelayQuotaNotice('free_quota_exhausted', true, t, {
      weeklyGrant: { remainingMilli: 0 },
      persistent: { topupMilli: 0, earnedMilli: 0, bonusMilli: 0 },
    });
    assert.ok(empty.includes('free_quota_exhausted'));
    assert.ok(!empty.includes('ME_ADMISSION_MISMATCH'));
  }
  const { meBalanceSpendableMilli } = loadCompiledModule('../dist-electron/main/libs/coworkAssistantReply.js');
  assert.equal(meBalanceSpendableMilli({
    weeklyGrant: { remainingMilli: 0 },
    autoDeductFromPersistent: false,
    persistent: { topupMilli: 864429, earnedMilli: 0, bonusMilli: 0 },
  }), 0, 'a disabled persistent-deduction switch is not spendable balance');
  assert.equal(meBalanceSpendableMilli({
    weeklyGrant: { remainingMilli: 0 },
    autoDeductFromPersistent: true,
    persistent: { topupMilli: 864429, earnedMilli: 0, bonusMilli: 0 },
  }), 864429);
});
