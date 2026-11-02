/**
 * QQ group rate limiting — the flood guard in front of the model.
 *
 * What these tests pin down (all offline, fake SDK, no request leaves the
 * process):
 *
 *   1. per sender per group: 3 / minute, the 4th is silently dropped
 *   2. per group:            10 / minute, the 11th is silently dropped
 *   3. daily budget:         500 by default, configurable, read live
 *   4. duplicate content:    consecutive identical text is answered once
 *   5. group isolation:      one noisy group cannot silence another
 *   6. silence:              NO outbound text of any kind for a drop
 *
 * Plus the invariants the owner insisted on: the owner is NOT exempt, DM is
 * out of scope, reception and the audit trail are NOT blocked, and the
 * per-minute numbers are hard-coded.
 *
 * Run: npx tsx --test tests/qqRateLimit.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { QQGateway, type QQBotFactory, type QQBotLike, type QQMediaNetwork } from '../src/main/im/qqGateway';
import { QQStore } from '../src/main/im/qqStore';
import { QQGroupCandidateStore } from '../src/main/im/qqCandidates';
import { QQGroupAuditLog } from '../src/main/im/qqTrust';
import {
  QQRateLimiter,
  QQ_DAILY_REPLY_LIMIT_DEFAULT,
  QQ_RATE_GROUP_PER_MINUTE,
  QQ_RATE_SENDER_PER_MINUTE,
  QQ_RATE_WINDOW_MS,
  normalizeQQDailyReplyLimit,
  normalizeQQRateContent,
} from '../src/main/im/qqRateLimit';
import { DEFAULT_QQ_CONFIG, type IMMessage, type QQConfig } from '../src/main/im/types';
import type { QQInboundLike } from '../src/main/im/qqProtocol';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const OWNER = 'owner-openid-1';
const GROUP_A = 'group-openid-A';
const GROUP_B = 'group-openid-B';
const APP_ID = '102000001';

/** Unique temp dir per test; intentionally never deleted (task policy: no deletions). */
function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `idbots-qq-rate-${prefix}-`));
}

function baseConfig(overrides: Partial<QQConfig> = {}): Partial<QQConfig> {
  return {
    enabled: true,
    appId: APP_ID,
    ownerUserOpenid: OWNER,
    groupPolicy: 'allowlist',
    groupAllowlist: [GROUP_A, GROUP_B],
    localToolsEnabled: false,
    localToolsAllowFrom: [],
    dailyReplyLimit: QQ_DAILY_REPLY_LIMIT_DEFAULT,
    debug: false,
    ...overrides,
  };
}

function groupInbound(overrides: Partial<QQInboundLike> = {}): QQInboundLike {
  return {
    kind: 'group',
    senderId: 'member-openid-1',
    senderName: 'Member',
    groupOpenid: GROUP_A,
    rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    content: `<@!${APP_ID}> hello`,
    messageId: `msg-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date('2026-11-02T00:00:00Z').toISOString(),
    ...overrides,
  };
}

function directInbound(overrides: Partial<QQInboundLike> = {}): QQInboundLike {
  return {
    kind: 'c2c',
    senderId: OWNER,
    senderName: 'Owner',
    content: 'hello',
    messageId: `msg-${Math.random().toString(36).slice(2)}`,
    timestamp: new Date('2026-11-02T00:00:00Z').toISOString(),
    rawEventType: 'C2C_MESSAGE_CREATE',
    ...overrides,
  };
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
    return { refIdx: 'typing' };
  }

  async emitMessage(message: QQInboundLike): Promise<void> {
    for (const handler of this.handlers.get('message') ?? []) {
      await handler({}, message);
    }
  }
}

function makeMediaNetwork(): QQMediaNetwork {
  return {
    async fetchBytes() {
      return { bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47]), contentType: 'image/png' };
    },
  };
}

interface Harness {
  gateway: QQGateway;
  bot: FakeBot;
  audit: QQGroupAuditLog;
  clock: { value: number };
  /** The object the live config provider returns; tests may mutate it. */
  live: Partial<QQConfig>;
  stats: { turns: number };
  /** Every message event the gateway emitted (reception is not blocked). */
  received: IMMessage[];
}

async function waitFor(condition: () => boolean, timeoutMs = 2000, label = 'condition'): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Let queued async work (audit writes, sends) settle. */
async function settle(ms = 30): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Emit one inbound message and let the gateway finish it before sending the
 * next.
 *
 * Without this, a rapid burst also triggers the PRE-EXISTING "still processing"
 * queue notice, which is an outbound text of its own and would be mistaken for
 * a rate-limit reply. The limiter decision itself is synchronous at the entry
 * point, so serializing here removes only that unrelated notice — it does not
 * change what is being measured.
 */
async function send(harness: Harness, message: QQInboundLike): Promise<void> {
  await harness.bot.emitMessage(message);
  await settle(20);
}

async function startHarness(options: {
  config?: Partial<QQConfig>;
} = {}): Promise<Harness> {
  const stateDir = makeTempDir('state');
  const mediaRoot = makeTempDir('media');
  const auditDir = makeTempDir('audit');
  const store = new QQStore(stateDir);
  const bot = new FakeBot();
  const factory: QQBotFactory = { create: () => bot };
  const audit = new QQGroupAuditLog(auditDir);
  const clock = { value: Date.parse('2026-11-02T10:00:00+08:00') };
  const live: Partial<QQConfig> = baseConfig(options.config);
  const stats = { turns: 0 };
  const received: IMMessage[] = [];

  const gateway = new QQGateway({
    store,
    botFactory: factory,
    now: () => clock.value,
    mediaRootDir: mediaRoot,
    mediaNetwork: makeMediaNetwork(),
    typingIndicator: false,
    auditLog: audit,
    groupCandidates: new QQGroupCandidateStore(makeTempDir('candidates')),
    // Production reads the config live (settings save without a restart).
    configProvider: () => live,
  });

  await gateway.start({
    ...baseConfig(options.config),
    appSecret: 'test-secret-value',
  } as QQConfig);

  gateway.on('message', (message: IMMessage) => received.push(message));
  gateway.setMessageCallback(async (_message, reply) => {
    stats.turns += 1;
    await reply('answer');
  });

  return { gateway, bot, audit, clock, live, stats, received };
}

function reasonsOf(harness: Harness): string[] {
  return harness.audit
    .readRecent(50)
    .filter((entry) => entry.outcome === 'dropped')
    .map((entry) => entry.reason);
}

// ---------------------------------------------------------------------------
// 1. Per sender, per group
// ---------------------------------------------------------------------------

test('RL-01 same sender: 4th message in one minute is silently dropped', async () => {
  const harness = await startHarness();
  try {
    for (let i = 0; i < 4; i += 1) {
      await send(harness, groupInbound({
        senderId: 'member-1',
        messageId: `m-${i}`,
        content: `<@!${APP_ID}> message ${i}`,
      }));
    }
    await waitFor(() => harness.stats.turns === 3);
    await settle();

    assert.equal(harness.stats.turns, 3, 'only three model turns');
    assert.equal(harness.bot.sentTexts.length, 3, 'only three outbound messages');
    assert.deepEqual(harness.bot.sentTexts.map((t) => t.content), ['answer', 'answer', 'answer']);
    assert.equal(harness.received.length, 4, 'reception is not blocked');

    const dropped = harness.audit.readRecent(20).filter((entry) => entry.outcome === 'dropped');
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].reason, 'rate-limited:per-sender');
    assert.equal(dropped[0].senderId, 'member-1');
    assert.equal(dropped[0].groupId, GROUP_A);
    assert.equal(dropped[0].reply, '');
    assert.match(dropped[0].question, /message 3/);
  } finally {
    await harness.gateway.stop();
  }
});

test('RL-02 the per-sender window is rolling: after 60 s the sender is served again', async () => {
  const harness = await startHarness();
  try {
    for (let i = 0; i < 3; i += 1) {
      await send(harness, groupInbound({
        senderId: 'member-1',
        messageId: `m-${i}`,
        content: `<@!${APP_ID}> first ${i}`,
      }));
    }
    await waitFor(() => harness.stats.turns === 3);

    harness.clock.value += QQ_RATE_WINDOW_MS + 1;
    await send(harness, groupInbound({
      senderId: 'member-1',
      messageId: 'm-after-window',
      content: `<@!${APP_ID}> second wind`,
    }));
    await waitFor(() => harness.stats.turns === 4);
    assert.equal(harness.bot.sentTexts.length, 4);
  } finally {
    await harness.gateway.stop();
  }
});

// ---------------------------------------------------------------------------
// 2. Per group
// ---------------------------------------------------------------------------

test('RL-03 single group: 11th message in one minute is silently dropped', async () => {
  const harness = await startHarness();
  try {
    for (let i = 0; i < 12; i += 1) {
      await send(harness, groupInbound({
        senderId: `member-${i}`,
        messageId: `g-${i}`,
        content: `<@!${APP_ID}> group message ${i}`,
      }));
    }
    await waitFor(() => harness.stats.turns === 10);
    await settle();

    assert.equal(harness.stats.turns, 10);
    assert.equal(harness.bot.sentTexts.length, 10);
    const dropped = harness.audit.readRecent(30).filter((entry) => entry.outcome === 'dropped');
    assert.equal(dropped.length, 2);
    assert.deepEqual(
      dropped.map((entry) => entry.reason).sort(),
      ['rate-limited:per-group', 'rate-limited:per-group']
    );
  } finally {
    await harness.gateway.stop();
  }
});

// ---------------------------------------------------------------------------
// 3. Daily budget (configurable, read live)
// ---------------------------------------------------------------------------

test('RL-04 daily budget blocks the 6th group message and is read live', async () => {
  const harness = await startHarness({ config: { dailyReplyLimit: 5 } });
  try {
    for (let i = 0; i < 5; i += 1) {
      await send(harness, groupInbound({
        senderId: `member-${i}`,
        messageId: `d-${i}`,
        content: `<@!${APP_ID}> daily ${i}`,
      }));
    }
    await waitFor(() => harness.stats.turns === 5);

    await send(harness, groupInbound({
      senderId: 'member-5',
      messageId: 'd-5',
      content: `<@!${APP_ID}> daily 5`,
    }));
    await settle();
    assert.equal(harness.stats.turns, 5, 'over the daily cap: no model turn');
    assert.equal(harness.bot.sentTexts.length, 5);
    assert.ok(reasonsOf(harness).includes('rate-limited:daily'));

    // The cap is live config, not a snapshot taken at start().
    harness.live.dailyReplyLimit = 6;
    await send(harness, groupInbound({
      senderId: 'member-6',
      messageId: 'd-6',
      content: `<@!${APP_ID}> daily 6`,
    }));
    await waitFor(() => harness.stats.turns === 6);
    assert.equal(harness.bot.sentTexts.length, 6);
  } finally {
    await harness.gateway.stop();
  }
});

test('RL-05 daily budget resets on the next local day', async () => {
  const harness = await startHarness({ config: { dailyReplyLimit: 2 } });
  try {
    for (let i = 0; i < 2; i += 1) {
      await send(harness, groupInbound({
        senderId: `member-${i}`,
        messageId: `day1-${i}`,
        content: `<@!${APP_ID}> day one ${i}`,
      }));
    }
    await waitFor(() => harness.stats.turns === 2);

    await send(harness, groupInbound({
      senderId: 'member-x',
      messageId: 'day1-x',
      content: `<@!${APP_ID}> day one blocked`,
    }));
    await settle();
    assert.equal(harness.stats.turns, 2);

    harness.clock.value += 24 * 60 * 60 * 1000;
    await send(harness, groupInbound({
      senderId: 'member-y',
      messageId: 'day2-y',
      content: `<@!${APP_ID}> day two`,
    }));
    await waitFor(() => harness.stats.turns === 3);
    assert.equal(harness.bot.sentTexts.length, 3);
  } finally {
    await harness.gateway.stop();
  }
});

// ---------------------------------------------------------------------------
// 4. Duplicate content
// ---------------------------------------------------------------------------

test('RL-06 consecutive identical content is answered once; a different line resets it', async () => {
  const harness = await startHarness();
  try {
    await send(harness, groupInbound({
      senderId: 'member-dup',
      messageId: 'dup-1',
      content: `<@!${APP_ID}> 在吗`,
    }));
    await waitFor(() => harness.stats.turns === 1);

    await send(harness, groupInbound({
      senderId: 'member-dup',
      messageId: 'dup-2',
      content: `<@!${APP_ID}>   在吗  `,
    }));
    await settle();
    assert.equal(harness.stats.turns, 1, 'duplicate gets no model turn');
    assert.equal(harness.bot.sentTexts.length, 1);
    assert.ok(reasonsOf(harness).includes('rate-limited:duplicate'));

    await send(harness, groupInbound({
      senderId: 'member-dup',
      messageId: 'dup-3',
      content: `<@!${APP_ID}> 换个话题`,
    }));
    await waitFor(() => harness.stats.turns === 2);

    await send(harness, groupInbound({
      senderId: 'member-dup',
      messageId: 'dup-4',
      content: `<@!${APP_ID}> 在吗`,
    }));
    await waitFor(() => harness.stats.turns === 3);
    assert.equal(harness.bot.sentTexts.length, 3, 'the repeat is not consecutive any more');
  } finally {
    await harness.gateway.stop();
  }
});

test('RL-07 duplicate suppression is per sender: another member saying the same thing is served', async () => {
  const harness = await startHarness();
  try {
    await send(harness, groupInbound({
      senderId: 'alice',
      messageId: 'who-1',
      content: `<@!${APP_ID}> 有人吗`,
    }));
    await waitFor(() => harness.stats.turns === 1);
    await send(harness, groupInbound({
      senderId: 'bob',
      messageId: 'who-2',
      content: `<@!${APP_ID}> 有人吗`,
    }));
    await waitFor(() => harness.stats.turns === 2);
    assert.equal(harness.bot.sentTexts.length, 2);
  } finally {
    await harness.gateway.stop();
  }
});

// ---------------------------------------------------------------------------
// 5. Group isolation
// ---------------------------------------------------------------------------

test('RL-08 a flooded group does not silence another group', async () => {
  const harness = await startHarness();
  try {
    for (let i = 0; i < 10; i += 1) {
      await send(harness, groupInbound({
        groupOpenid: GROUP_A,
        senderId: `a-member-${i}`,
        messageId: `a-${i}`,
        content: `<@!${APP_ID}> A ${i}`,
      }));
    }
    await waitFor(() => harness.stats.turns === 10);

    await send(harness, groupInbound({
      groupOpenid: GROUP_B,
      senderId: 'b-member-1',
      messageId: 'b-1',
      content: `<@!${APP_ID}> B hello`,
    }));
    await waitFor(() => harness.stats.turns === 11);
    assert.equal(harness.bot.sentTexts.length, 11, 'group B is still served');

    await send(harness, groupInbound({
      groupOpenid: GROUP_A,
      senderId: 'a-member-11',
      messageId: 'a-11',
      content: `<@!${APP_ID}> A 11`,
    }));
    await settle();
    assert.equal(harness.stats.turns, 11, 'group A remains capped');
    assert.ok(reasonsOf(harness).includes('rate-limited:per-group'));
  } finally {
    await harness.gateway.stop();
  }
});

// ---------------------------------------------------------------------------
// 6. No owner exception; DM out of scope
// ---------------------------------------------------------------------------

test('RL-09 the owner is NOT exempt inside a group', async () => {
  const harness = await startHarness();
  try {
    for (let i = 0; i < 4; i += 1) {
      await send(harness, groupInbound({
        senderId: OWNER,
        messageId: `owner-${i}`,
        content: `<@!${APP_ID}> owner ${i}`,
      }));
    }
    await waitFor(() => harness.stats.turns === 3);
    await settle();
    assert.equal(harness.stats.turns, 3);
    assert.equal(harness.bot.sentTexts.length, 3);
    const dropped = harness.audit.readRecent(10).filter((entry) => entry.outcome === 'dropped');
    assert.equal(dropped.length, 1);
    assert.equal(dropped[0].senderId, OWNER);
    assert.equal(dropped[0].reason, 'rate-limited:per-sender');
  } finally {
    await harness.gateway.stop();
  }
});

test('RL-10 direct messages are outside the group rate limits (owner-only channel)', async () => {
  // A daily cap of 1: the first GROUP message uses the whole budget, while
  // DMs keep working — and the next group message is still blocked.
  const harness = await startHarness({ config: { dailyReplyLimit: 1 } });
  try {
    await send(harness, groupInbound({
      senderId: 'member-1',
      messageId: 'grp-0',
      content: `<@!${APP_ID}> group zero`,
    }));
    await waitFor(() => harness.stats.turns === 1);

    for (let i = 0; i < 4; i += 1) {
      await send(harness, directInbound({
        messageId: `dm-${i}`,
        content: `dm ${i}`,
      }));
    }
    await waitFor(() => harness.stats.turns === 5);
    assert.equal(harness.bot.sentTexts.length, 5, 'DMs ignore the exhausted group budget');

    await send(harness, groupInbound({
      senderId: 'member-2',
      messageId: 'grp-1',
      content: `<@!${APP_ID}> group one`,
    }));
    await settle();
    assert.equal(harness.stats.turns, 5, 'the group budget is still exhausted');
    assert.ok(reasonsOf(harness).includes('rate-limited:daily'));
  } finally {
    await harness.gateway.stop();
  }
});

// ---------------------------------------------------------------------------
// 7. Silence (no hint text of any kind)
// ---------------------------------------------------------------------------

test('RL-11 every drop is silent: no "too fast"/"please wait" text ever leaves', async () => {
  const harness = await startHarness({ config: { dailyReplyLimit: 2 } });
  try {
    for (let i = 0; i < 2; i += 1) {
      await send(harness, groupInbound({
        senderId: `member-${i}`,
        messageId: `s-${i}`,
        content: `<@!${APP_ID}> silent ${i}`,
      }));
    }
    await waitFor(() => harness.stats.turns === 2);

    // Daily cap, then the same drop path twice: the second identical line must
    // be caught by duplicate suppression (and still be audited).
    await send(harness, groupInbound({
      senderId: 'member-x',
      messageId: 's-x',
      content: `<@!${APP_ID}> over daily`,
    }));
    await send(harness, groupInbound({
      senderId: 'member-1',
      messageId: 's-over-1',
      content: `<@!${APP_ID}> over daily too`,
    }));
    await send(harness, groupInbound({
      senderId: 'member-1',
      messageId: 's-over-2',
      content: `<@!${APP_ID}> over daily too`,
    }));
    await settle();

    assert.equal(harness.bot.sentTexts.length, 2, 'nothing was sent for the drops');
    for (const sent of harness.bot.sentTexts) {
      assert.doesNotMatch(sent.content, /频繁|稍后|太快|限流|rate|limit|slow/i);
    }
    const dropped = harness.audit.readRecent(20).filter((entry) => entry.outcome === 'dropped');
    assert.equal(dropped.length, 3);
    assert.deepEqual(
      dropped.map((entry) => entry.reason).sort(),
      ['rate-limited:daily', 'rate-limited:daily', 'rate-limited:duplicate']
    );
    assert.equal(dropped.every((entry) => entry.reply === ''), true);
  } finally {
    await harness.gateway.stop();
  }
});

// ---------------------------------------------------------------------------
// 8. Pure limiter: normalization and hard-coded numbers
// ---------------------------------------------------------------------------

test('RL-12 hard-coded per-minute guards are 3 and 10; the default daily cap is 500', () => {
  assert.equal(QQ_RATE_SENDER_PER_MINUTE, 3);
  assert.equal(QQ_RATE_GROUP_PER_MINUTE, 10);
  assert.equal(QQ_RATE_WINDOW_MS, 60_000);
  assert.equal(QQ_DAILY_REPLY_LIMIT_DEFAULT, 500);
  assert.equal(DEFAULT_QQ_CONFIG.dailyReplyLimit, 500);
});

test('RL-13 invalid daily caps degrade to 500, never to unlimited', () => {
  assert.equal(normalizeQQDailyReplyLimit(undefined), 500);
  assert.equal(normalizeQQDailyReplyLimit(null), 500);
  assert.equal(normalizeQQDailyReplyLimit(Number.NaN), 500);
  assert.equal(normalizeQQDailyReplyLimit(Number.POSITIVE_INFINITY), 500);
  assert.equal(normalizeQQDailyReplyLimit(0), 500);
  assert.equal(normalizeQQDailyReplyLimit(-7), 500);
  assert.equal(normalizeQQDailyReplyLimit(100_001), 500);
  assert.equal(normalizeQQDailyReplyLimit('abc'), 500);
  assert.equal(normalizeQQDailyReplyLimit(''), 500);
  assert.equal(normalizeQQDailyReplyLimit(1), 1);
  assert.equal(normalizeQQDailyReplyLimit(7.9), 7);
  assert.equal(normalizeQQDailyReplyLimit('250'), 250);
  assert.equal(normalizeQQDailyReplyLimit(100_000), 100_000);
});

test('RL-14 content normalization ignores mention markers and whitespace runs only', () => {
  assert.equal(normalizeQQRateContent(`<@!${APP_ID}> 在吗`), '在吗');
  assert.equal(normalizeQQRateContent(`<@${APP_ID}>   在吗  `), '在吗');
  assert.equal(normalizeQQRateContent('hello   world'), 'hello world');
  assert.equal(normalizeQQRateContent('Hello'), 'Hello');
  assert.notEqual(normalizeQQRateContent('Hello'), normalizeQQRateContent('hello'));
});

test('RL-15 limiter state is group-scoped and resets cleanly', () => {
  const clock = { value: 1_700_000_000_000 };
  const limiter = new QQRateLimiter({ now: () => clock.value });

  for (let i = 0; i < 3; i += 1) {
    const decision = limiter.checkGroup({
      groupId: 'A',
      senderId: 's1',
      content: `A-${i}`,
      dailyLimit: 500,
    });
    assert.equal(decision.allowed, true);
  }
  assert.equal(
    limiter.checkGroup({ groupId: 'A', senderId: 's1', content: 'A-3', dailyLimit: 500 }).reason,
    'per-sender'
  );
  // Same sender id in another group is a different bucket.
  assert.equal(
    limiter.checkGroup({ groupId: 'B', senderId: 's1', content: 'B-1', dailyLimit: 500 }).allowed,
    true
  );

  limiter.reset();
  assert.equal(
    limiter.checkGroup({ groupId: 'A', senderId: 's1', content: 'A-3', dailyLimit: 500 }).allowed,
    true
  );
});
