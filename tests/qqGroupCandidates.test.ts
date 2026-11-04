/**
 * QQ group authorisation WITHOUT the 32-hex group OpenID.
 *
 * The bug these tests pin down: the allowlist could only be filled with the
 * platform's group OpenID (e.g. `D5C5A8FEDB9C07ED3962FC31238BE4EE`), a string
 * that exists only inside an inbound message payload. An owner knows their
 * 8-digit 群号, which the platform does not accept, so the list could never be
 * filled — and because unauthorized messages were dropped without being
 * remembered, the id was thrown away too. Deadlock.
 *
 * The fix under test: record the id silently, let the owner allow it with one
 * click. What must NOT change is folded into these cases as well:
 *   - recording is not authorisation (the group is still refused next message),
 *   - recording answers nothing, calls no model, runs no tool, writes no memory,
 *   - an explicit `disabled` policy collects nothing at all,
 *   - the group name is never invented when the platform refuses to supply one.
 *
 * Everything runs offline: no request leaves the process. Run with
 * `npx tsx --test tests/qqGroupCandidates.test.ts`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { QQGateway, type QQBotFactory, type QQBotLike, type QQMediaNetwork } from '../src/main/im/qqGateway';
import { QQStore } from '../src/main/im/qqStore';
import {
  QQGroupCandidateStore,
  QQ_GROUP_CANDIDATE_LIMIT,
  normalizeQQGroupId,
} from '../src/main/im/qqCandidates';
import {
  QQ_GROUP_INFO_FORBIDDEN_CODE,
  createQQGroupInfoLookup,
} from '../src/main/im/qqGroupInfo';
import type { QQGroupInfoLookup } from '../src/main/im/qqGroupInfo';
import { QQGroupAuditLog } from '../src/main/im/qqTrust';
import type { QQInboundLike } from '../src/main/im/qqProtocol';
import type { QQConfig } from '../src/main/im/types';
import type { IMMessage } from '../src/main/im/types';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const APP_ID = '102000001';
/** A real-shaped group OpenID: 32 uppercase hex. Case must survive round-trip. */
const PENDING_GROUP = 'D5C5A8FEDB9C07ED3962FC31238BE4EE';
const ALLOWED_GROUP = 'AAAABBBBCCCCDDDDEEEEFFFF00001111';

/** Unique temp dir per test; intentionally never deleted (task policy: no deletions). */
function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `idbots-qq-cand-${prefix}-`));
}

function inbound(overrides: Partial<QQInboundLike> = {}): QQInboundLike {
  return {
    kind: 'group',
    senderId: 'member-openid-1',
    senderName: 'Member',
    groupOpenid: PENDING_GROUP,
    content: '<@!102000001> 这个群能回答问题吗',
    messageId: `msg-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date('2026-11-02T00:00:00Z').toISOString(),
    rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    ...overrides,
  };
}

function baseConfig(overrides: Partial<QQConfig> = {}): QQConfig {
  return {
    enabled: true,
    appId: APP_ID,
    appSecret: 'test-secret-value',
    ownerUserOpenid: 'owner-openid-1',
    groupPolicy: 'allowlist',
    groupAllowlist: [ALLOWED_GROUP],
    localToolsEnabled: false,
    localToolsAllowFrom: [],
    debug: false,
    ...overrides,
  } as QQConfig;
}

class FakeBot implements QQBotLike {
  private handlers = new Map<string, Array<(...args: any[]) => any>>();
  readonly sentTexts: Array<{ target: any; content: string }> = [];
  private resolveStart: (() => void) | null = null;

  on(event: string, handler: (...args: any[]) => any): QQBotLike {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  start(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.resolveStart = resolve;
    });
  }

  stop(): void {
    this.resolveStart?.();
  }

  async sendText(target: any, content: string): Promise<unknown> {
    this.sentTexts.push({ target, content });
    return { id: `out-${this.sentTexts.length}` };
  }

  async sendTyping(): Promise<unknown> {
    return { refId: 'typing' };
  }

  async emitMessage(message: QQInboundLike): Promise<void> {
    for (const handler of this.handlers.get('message') ?? []) {
      await handler({}, message);
    }
  }
}

const noMediaNetwork: QQMediaNetwork = {
  async fetchBytes() {
    throw new Error('groups must never download media');
  },
};

interface Harness {
  gateway: QQGateway;
  bot: FakeBot;
  candidates: QQGroupCandidateStore;
  audit: QQGroupAuditLog;
  /** Messages handed to the cowork handler; empty proves "no model turn". */
  delivered: IMMessage[];
  /** Mutable config the live provider reads (simulates the settings page). */
  live: QQConfig;
}

/** Offline stand-in for the platform call: the suite must never hit the network. */
const okNameLookup: QQGroupInfoLookup = async () => ({
  status: 'ok',
  name: '读书分享会',
  detail: null,
});

async function startHarness(options: {
  config?: Partial<QQConfig>;
  onMessage?: (message: IMMessage) => Promise<void>;
  nameLookup?: QQGroupInfoLookup;
} = {}): Promise<Harness> {
  const stateDir = makeTempDir('state');
  const mediaRoot = makeTempDir('media');
  const auditDir = makeTempDir('audit');
  const candidateDir = makeTempDir('candidates');
  const store = new QQStore(stateDir);
  const bot = new FakeBot();
  const factory: QQBotFactory = { create: () => bot };
  const audit = new QQGroupAuditLog(auditDir);
  const candidates = new QQGroupCandidateStore(candidateDir);
  const live = baseConfig(options.config);

  const gateway = new QQGateway({
    store,
    botFactory: factory,
    mediaRootDir: mediaRoot,
    mediaNetwork: noMediaNetwork,
    typingIndicator: false,
    auditLog: audit,
    groupCandidates: candidates,
    groupInfoLookup: options.nameLookup ?? okNameLookup,
    // LIVE config, like the real manager: the settings page can flip the
    // allowlist while the gateway is running.
    configProvider: () => live,
  });

  const delivered: IMMessage[] = [];
  gateway.setMessageCallback(async (message, replyFn) => {
    delivered.push(message);
    if (options.onMessage) {
      await options.onMessage(message);
      return;
    }
    await replyFn('好的');
  });

  await gateway.start(live);
  return { gateway, bot, candidates, audit, delivered, live };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

// ---------------------------------------------------------------------------
// Silent recording
// ---------------------------------------------------------------------------

test('CAND-01 an unauthorized group is recorded and answered with nothing at all', async () => {
  const h = await startHarness();
  try {
    await h.bot.emitMessage(inbound());
    await settle();

    // Nothing went out and no turn was created.
    assert.deepEqual(h.bot.sentTexts, [], 'an unauthorized group must receive no reply');
    assert.equal(h.delivered.length, 0, 'no model turn may be created');

    // But the id is remembered, verbatim (uppercase preserved).
    const pending = h.gateway.getGroupCandidates().pending;
    assert.equal(pending.length, 1);
    assert.equal(pending[0].groupId, PENDING_GROUP);
    assert.equal(pending[0].messageCount, 1);
    assert.equal(pending[0].allowed, false);
  } finally {
    await h.gateway.stop();
  }
});

test('CAND-02 recording is not authorisation: the next message is refused again', async () => {
  const h = await startHarness();
  try {
    await h.bot.emitMessage(inbound());
    await settle();
    await h.bot.emitMessage(inbound({ messageId: 'msg-second' }));
    await settle();

    assert.deepEqual(h.bot.sentTexts, [], 'still no reply after being recorded');
    assert.equal(h.delivered.length, 0, 'still no model turn after being recorded');
    assert.equal(h.gateway.getGroupCandidates().pending[0].messageCount, 2);
    assert.equal(h.gateway.getGroupCandidates().pending[0].allowed, false);
  } finally {
    await h.gateway.stop();
  }
});

test('CAND-03 no conversation content is stored — only the id and a counter', async () => {
  const h = await startHarness();
  try {
    const secretQuestion = '这句问题不应该被存下来-42f1';
    await h.bot.emitMessage(inbound({ content: `<@!${APP_ID}> ${secretQuestion}` }));
    await settle();

    const raw = fs.readFileSync(h.candidates.filePath(), 'utf8');
    assert.ok(raw.includes(PENDING_GROUP), 'the group id must be stored');
    assert.ok(!raw.includes(secretQuestion), 'message content must never be stored');
    assert.ok(!raw.includes('member-openid-1'), 'sender identity must never be stored');
  } finally {
    await h.gateway.stop();
  }
});

test('CAND-04 an explicit "disabled" policy collects nothing (opt-out is honoured)', async () => {
  const h = await startHarness({ config: { groupPolicy: 'disabled' } });
  try {
    await h.bot.emitMessage(inbound());
    await settle();

    assert.deepEqual(h.bot.sentTexts, []);
    assert.deepEqual(h.gateway.getGroupCandidates().pending, []);
    assert.deepEqual(h.candidates.list(), [], 'a disabled policy must not build a candidate list');
  } finally {
    await h.gateway.stop();
  }
});

test('CAND-05 other bots are not recorded (no bot-to-bot list pollution)', async () => {
  const h = await startHarness();
  try {
    await h.bot.emitMessage(inbound({ senderIsBot: true }));
    await settle();

    assert.deepEqual(h.gateway.getGroupCandidates().pending, []);
    assert.deepEqual(h.bot.sentTexts, []);
  } finally {
    await h.gateway.stop();
  }
});

test('CAND-06 the audit trail records the drop as "dropped", not as an answer', async () => {
  const h = await startHarness();
  try {
    await h.bot.emitMessage(inbound());
    await settle();

    const [entry] = h.audit.readRecent(5);
    assert.ok(entry, 'the drop must be audited');
    assert.equal(entry.outcome, 'dropped');
    assert.equal(entry.reason, 'group-not-allowlisted');
    assert.equal(entry.reply, '');
    assert.equal(entry.groupId, PENDING_GROUP);
  } finally {
    await h.gateway.stop();
  }
});

// ---------------------------------------------------------------------------
// Allow / ignore
// ---------------------------------------------------------------------------

test('CAND-07 after "allow" the group is answered, still layer-1 only', async () => {
  const h = await startHarness();
  try {
    await h.bot.emitMessage(inbound());
    await settle();
    assert.deepEqual(h.bot.sentTexts, []);

    // The settings page writes the id into the allowlist (one click, no typing).
    h.live.groupAllowlist = [ALLOWED_GROUP, PENDING_GROUP];
    assert.deepEqual(h.gateway.getGroupCandidates().pending, [], 'an allowed group leaves the pending list');

    await h.bot.emitMessage(inbound({ messageId: 'msg-after-allow' }));
    await settle();

    assert.equal(h.bot.sentTexts.length, 1, 'an allowed group gets exactly one reply');
    assert.equal(h.delivered.length, 1);

    // Layer 1 invariants survive the new path.
    const trust = h.delivered[0].trust;
    assert.ok(trust);
    assert.equal(trust?.level, 'group');
    assert.equal(trust?.toolScope, 'none');
    assert.equal(trust?.memoryRead, false);
    assert.equal(trust?.memoryWrite, false);
    assert.equal(trust?.attachmentPolicy, 'reject');
  } finally {
    await h.gateway.stop();
  }
});

test('CAND-08 after "ignore" the group leaves the list and is still never answered', async () => {
  const h = await startHarness();
  try {
    await h.bot.emitMessage(inbound());
    await settle();
    assert.equal(h.gateway.getGroupCandidates().pending.length, 1);

    const report = h.gateway.dismissGroupCandidate(PENDING_GROUP);
    assert.deepEqual(report.pending, [], 'an ignored group leaves the pending list');
    assert.equal(report.all.length, 1, 'the record survives so it can be restored');
    assert.equal(report.all[0].ignored, true);

    await h.bot.emitMessage(inbound({ messageId: 'msg-after-ignore' }));
    await settle();
    assert.deepEqual(h.bot.sentTexts, [], 'ignoring must not authorise anything');
    assert.equal(h.delivered.length, 0);
    assert.deepEqual(h.gateway.getGroupCandidates().pending, []);
  } finally {
    await h.gateway.stop();
  }
});

test('CAND-09 restoring an ignored group brings the row back, still unauthorized', async () => {
  const h = await startHarness();
  try {
    await h.bot.emitMessage(inbound());
    await settle();
    h.gateway.dismissGroupCandidate(PENDING_GROUP);
    const report = h.gateway.restoreGroupCandidate(PENDING_GROUP);

    assert.equal(report.pending.length, 1);
    assert.equal(report.pending[0].allowed, false);
    assert.deepEqual(h.bot.sentTexts, []);
  } finally {
    await h.gateway.stop();
  }
});

test('CAND-10 removing a group from the allowlist makes it pending again', async () => {
  const h = await startHarness({ config: { groupAllowlist: [PENDING_GROUP] } });
  try {
    // Already allowed: it is answered and never recorded.
    await h.bot.emitMessage(inbound());
    await settle();
    assert.equal(h.bot.sentTexts.length, 1);
    assert.deepEqual(h.gateway.getGroupCandidates().pending, []);

    // The owner removes it from the allowlist.
    h.live.groupAllowlist = [];
    await h.bot.emitMessage(inbound({ messageId: 'msg-after-removal' }));
    await settle();

    assert.equal(h.bot.sentTexts.length, 1, 'a removed group is not answered');
    const pending = h.gateway.getGroupCandidates().pending;
    assert.equal(pending.length, 1);
    assert.equal(pending[0].groupId, PENDING_GROUP);
  } finally {
    await h.gateway.stop();
  }
});

// ---------------------------------------------------------------------------
// Group name — honest degradation
// ---------------------------------------------------------------------------

test('CAND-11 a name is shown only when the platform actually returns one', async () => {
  const h = await startHarness();
  try {
    await h.bot.emitMessage(inbound());
    await settle();

    const view = await h.gateway.refreshGroupCandidateName(PENDING_GROUP);
    assert.ok(view);
    assert.equal(view?.name, '读书分享会');
    assert.equal(view?.nameStatus, 'ok');
    assert.equal(view?.groupId, PENDING_GROUP, 'the id is still reported alongside the name');
  } finally {
    await h.gateway.stop();
  }
});

test('CAND-12 a whitelist refusal (11253) yields NO name and no fabrication', async () => {
  const stateDir = makeTempDir('cand-11253');
  const candidates = new QQGroupCandidateStore(stateDir);
  candidates.record(PENDING_GROUP, 1_700_000_000_000);

  const lookup = createQQGroupInfoLookup({
    getCredentials: () => ({ appId: APP_ID, appSecret: 'test-secret-value' }),
    fetch: async (request) => {
      if (request.url.includes('/app/getAppAccessToken')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'token', expires_in: 7200 }),
        };
      }
      return {
        ok: false,
        status: 403,
        json: async () => ({
          code: QQ_GROUP_INFO_FORBIDDEN_CODE,
          message: '应用无接口访问权限',
        }),
      };
    },
  });

  const result = await lookup(PENDING_GROUP);
  assert.equal(result.status, 'forbidden');
  assert.equal(result.name, null, 'a refused lookup must never invent a name');
  assert.ok(result.detail && result.detail.length > 0, 'the UI needs a reason to show');

  const stored = candidates.setName(PENDING_GROUP, result, 1_700_000_100_000);
  assert.ok(stored);
  assert.equal(stored?.name, null);
  assert.equal(stored?.nameStatus, 'forbidden');
});

test('CAND-13 no credentials means no network call and an "unavailable" answer', async () => {
  let called = false;
  const lookup = createQQGroupInfoLookup({
    getCredentials: () => null,
    fetch: async () => {
      called = true;
      throw new Error('must not be called');
    },
  });

  const result = await lookup(PENDING_GROUP);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.name, null);
  assert.equal(called, false, 'no credentials must mean zero requests');
});

test('CAND-14 a failed re-check clears a previously known name (no stale label)', async () => {
  const dir = makeTempDir('cand-stale');
  const candidates = new QQGroupCandidateStore(dir);
  candidates.record(PENDING_GROUP, 1_000);
  candidates.setName(PENDING_GROUP, { name: '读书分享会', status: 'ok' }, 1_100);
  assert.equal(candidates.list()[0].name, '读书分享会');

  const after = candidates.setName(PENDING_GROUP, { name: null, status: 'forbidden' }, 1_200);
  assert.equal(after?.name, null, 'a stale name must not survive a later refusal');
  assert.equal(after?.nameStatus, 'forbidden');
});

// ---------------------------------------------------------------------------
// Store robustness
// ---------------------------------------------------------------------------

test('CAND-15 the store survives a torn file and still records', () => {
  const dir = makeTempDir('cand-torn');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'group-candidates.json'), '{not json', 'utf8');

  const candidates = new QQGroupCandidateStore(dir);
  assert.deepEqual(candidates.list(), [], 'a torn file reads as empty, never as a grant');

  const recorded = candidates.record(PENDING_GROUP, 1_700_000_000_000);
  assert.ok(recorded);
  assert.equal(candidates.list().length, 1);
});

test('CAND-16 garbage group ids are rejected instead of being stored', () => {
  assert.equal(normalizeQQGroupId(''), '');
  assert.equal(normalizeQQGroupId('   '), '');
  assert.equal(normalizeQQGroupId(123 as unknown), '');
  assert.equal(normalizeQQGroupId('a'.repeat(200)), '');
  assert.equal(normalizeQQGroupId('bad\u0000id'), '');
  assert.equal(normalizeQQGroupId(` ${PENDING_GROUP} `), PENDING_GROUP);

  const dir = makeTempDir('cand-garbage');
  const candidates = new QQGroupCandidateStore(dir);
  assert.equal(candidates.record('', 1), null);
  assert.equal(candidates.record('bad\u0001id', 1), null);
  assert.deepEqual(candidates.list(), []);
});

test('CAND-17 the remembered list is bounded (an invite storm cannot grow it forever)', () => {
  const dir = makeTempDir('cand-cap');
  const candidates = new QQGroupCandidateStore(dir);
  const total = QQ_GROUP_CANDIDATE_LIMIT + 12;
  for (let i = 0; i < total; i += 1) {
    candidates.record(`GROUP${String(i).padStart(4, '0')}`, 1_700_000_000_000 + i);
  }

  const list = candidates.list();
  assert.equal(list.length, QQ_GROUP_CANDIDATE_LIMIT);
  // Newest activity survives, oldest is evicted.
  assert.equal(list[0].groupId, `GROUP${String(total - 1).padStart(4, '0')}`);
  assert.equal(list.some((entry) => entry.groupId === 'GROUP0000'), false);
});

test('CAND-18 pending() excludes allowed ids so the UI never asks twice', () => {
  const dir = makeTempDir('cand-pending');
  const candidates = new QQGroupCandidateStore(dir);
  candidates.record(PENDING_GROUP, 1);
  candidates.record(ALLOWED_GROUP, 2);

  const pending = candidates.pending([ALLOWED_GROUP]);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].groupId, PENDING_GROUP);
});

// ---------------------------------------------------------------------------
// Documentation contract
// ---------------------------------------------------------------------------

test('CAND-19 the channel docs state the group-name limit and the no-typing rule', () => {
  const docPath = path.join(process.cwd(), 'docs', 'qq-channel.md');
  const doc = fs.readFileSync(docPath, 'utf8');

  assert.match(doc, /11253/, 'the doc must name the whitelist error code');
  assert.match(doc, /group_name/, 'the doc must name the field the platform returns');
  assert.match(doc, /待授权|pending/i, 'the doc must describe the pending-group flow');
  assert.match(doc, /不需要.*输入|without typing|no typing/i, 'the doc must state that nothing is typed');
});
