/**
 * QQ channel security regression suite.
 *
 * These tests exist because of a real incident: after the bot was invited to a
 * group, ANY group member could command it, and every such turn ran with the
 * host bot's full local surface. The fix is a three-layer permission model
 * decided once at the message entry point and enforced in code:
 *
 *   layer 1  normal conversation   (group allowed, no tools, no memory)
 *   layer 2  owner-only            (bound owner OpenID, direct messages)
 *   layer 3  local machine ops     (DEFAULT OFF + its own allowlist)
 *
 * Everything below runs offline against fake SDK/network surfaces: no request
 * leaves the process. Run: `npx tsx --test tests/qqSecurity.test.ts`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { QQGateway, type QQBotFactory, type QQBotLike, type QQMediaNetwork } from '../src/main/im/qqGateway';
import { QQStore } from '../src/main/im/qqStore';
import {
  QQGroupAuditLog,
  QQ_GROUP_MEDIA_NOTICE,
  imTrustAllowsMemoryRead,
  imTrustAllowsMemoryWrite,
  imTrustAllowsTools,
  normalizeQQSecurityConfig,
  resolveQQGroupWorkspace,
  resolveQQMessageGate,
  summarizeForAudit,
} from '../src/main/im/qqTrust';
import type { QQInboundLike } from '../src/main/im/qqProtocol';
import type { QQConfig } from '../src/main/im/types';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const OWNER = 'owner-openid-1';
const STRANGER = 'stranger-openid-9';
const GROUP_A = 'group-openid-A';
const GROUP_B = 'group-openid-B';
const APP_ID = '102000001';

/** Unique temp dir per test; intentionally never deleted (task policy: no deletions). */
function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `idbots-qq-sec-${prefix}-`));
}

function inbound(overrides: Partial<QQInboundLike> = {}): QQInboundLike {
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

function groupInbound(overrides: Partial<QQInboundLike> = {}): QQInboundLike {
  return inbound({
    kind: 'group',
    senderId: 'member-openid-1',
    groupOpenid: GROUP_A,
    rawEventType: 'GROUP_AT_MESSAGE_CREATE',
    content: '<@!102000001> hi',
    ...overrides,
  });
}

function baseConfig(overrides: Partial<QQConfig> = {}): Partial<QQConfig> {
  return {
    enabled: true,
    appId: APP_ID,
    ownerUserOpenid: OWNER,
    groupPolicy: 'allowlist',
    groupAllowlist: [GROUP_A],
    localToolsEnabled: false,
    localToolsAllowFrom: [],
    debug: false,
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

function makeMediaNetwork(bytes: Buffer): QQMediaNetwork & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    async fetchBytes(url: string) {
      urls.push(url);
      return { bytes, contentType: 'image/png' };
    },
  };
}

interface Harness {
  gateway: QQGateway;
  bot: FakeBot;
  mediaRoot: string;
  audit: QQGroupAuditLog;
}

async function startHarness(options: {
  config?: Partial<QQConfig>;
  network?: QQMediaNetwork;
} = {}): Promise<Harness> {
  const stateDir = makeTempDir('state');
  const mediaRoot = makeTempDir('media');
  const auditDir = makeTempDir('audit');
  const store = new QQStore(stateDir);
  const bot = new FakeBot();
  const factory: QQBotFactory = { create: () => bot };
  const audit = new QQGroupAuditLog(auditDir);
  const gateway = new QQGateway({
    store,
    botFactory: factory,
    mediaRootDir: mediaRoot,
    mediaNetwork: options.network ?? makeMediaNetwork(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
    typingIndicator: false,
    auditLog: audit,
  });
  await gateway.start({
    ...baseConfig(),
    appSecret: 'test-secret-value',
    ...(options.config ?? {}),
  } as QQConfig);
  return { gateway, bot, mediaRoot, audit };
}

async function waitFor(condition: () => boolean, timeoutMs = 1000, label = 'condition'): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

// ---------------------------------------------------------------------------
// Layer model — pure gate decisions
// ---------------------------------------------------------------------------

test('SEC-01 group turns are layer-1 only: no tools, no memory, no attachments', () => {
  const gate = resolveQQMessageGate(groupInbound(), baseConfig(), 1_700_000_000_000);
  assert.equal(gate.action, 'process');
  assert.equal(gate.trust.level, 'group');
  assert.equal(gate.trust.toolScope, 'none');
  assert.equal(gate.trust.memoryRead, false);
  assert.equal(gate.trust.memoryWrite, false);
  assert.equal(gate.trust.attachmentPolicy, 'reject');
  assert.equal(imTrustAllowsTools(gate.trust), false);
  assert.equal(imTrustAllowsMemoryRead(gate.trust), false);
  assert.equal(imTrustAllowsMemoryWrite(gate.trust), false);
});

test('SEC-02 default group policy is allowlist-with-empty-list => nothing is served', () => {
  const security = normalizeQQSecurityConfig({ enabled: true, appId: APP_ID });
  assert.equal(security.groupPolicy, 'allowlist');
  assert.deepEqual(security.groupAllowlist, []);
  const gate = resolveQQMessageGate(groupInbound(), { enabled: true, appId: APP_ID }, 1);
  assert.equal(gate.action, 'silent-drop');
  assert.equal(gate.reason, 'group-not-allowlisted');
});

test('SEC-03 owner DM at layer 2: memory on, but layer 3 is still OFF by default', () => {
  const gate = resolveQQMessageGate(inbound(), baseConfig(), 1);
  assert.equal(gate.action, 'process');
  assert.equal(gate.trust.level, 'owner-dm');
  assert.equal(gate.trust.toolScope, 'none');
  assert.equal(gate.trust.memoryRead, true);
  assert.equal(gate.trust.memoryWrite, true);
  assert.equal(imTrustAllowsTools(gate.trust), false);
});

test('SEC-04 layer 3 needs BOTH the switch and its own allowlist', () => {
  const switchedOn = resolveQQMessageGate(
    inbound(),
    baseConfig({ localToolsEnabled: true, localToolsAllowFrom: [] }),
    1
  );
  assert.equal(switchedOn.trust.toolScope, 'none', 'switch alone must not grant tools');

  const otherIdentity = resolveQQMessageGate(
    inbound(),
    baseConfig({ localToolsEnabled: true, localToolsAllowFrom: [STRANGER] }),
    1
  );
  assert.equal(otherIdentity.trust.level, 'owner-dm');
  assert.equal(otherIdentity.trust.toolScope, 'none', 'allowlist must name the owner too');

  const granted = resolveQQMessageGate(
    inbound(),
    baseConfig({ localToolsEnabled: true, localToolsAllowFrom: [OWNER] }),
    1
  );
  assert.equal(granted.trust.toolScope, 'local');
  assert.equal(imTrustAllowsTools(granted.trust), true);
});

test('SEC-05 stranger DM is a silent drop with no reply text at all', () => {
  const gate = resolveQQMessageGate(inbound({ senderId: STRANGER }), baseConfig(), 1);
  assert.equal(gate.action, 'silent-drop');
  assert.equal(gate.trust.level, 'stranger-dm');
  assert.equal(gate.notice, undefined, 'strangers must not even receive a refusal');
});

test('SEC-06 no owner binding means every DM is a stranger (fail-closed)', () => {
  const gate = resolveQQMessageGate(
    inbound(),
    baseConfig({ ownerUserOpenid: null }),
    1
  );
  assert.equal(gate.action, 'silent-drop');
  assert.equal(gate.reason, 'no-owner-binding');
});

test('SEC-07 identity is the stable id, never the display name (nickname spoofing)', () => {
  const spoof = resolveQQMessageGate(
    inbound({ senderId: STRANGER, senderName: 'Owner' }),
    baseConfig(),
    1
  );
  assert.equal(spoof.action, 'silent-drop');
  assert.equal(spoof.trust.level, 'stranger-dm');

  const renamedOwner = resolveQQMessageGate(
    inbound({ senderId: OWNER, senderName: 'Totally Not The Owner' }),
    baseConfig(),
    1
  );
  assert.equal(renamedOwner.action, 'process');
});

test('SEC-08 other bots are dropped before anything else (no bot-to-bot loop)', () => {
  const gate = resolveQQMessageGate(
    groupInbound({ senderIsBot: true }),
    baseConfig({ groupPolicy: 'open' }),
    1
  );
  assert.equal(gate.action, 'silent-drop');
  assert.equal(gate.trust.level, 'bot-sender');
});

test('SEC-09 unknown/invalid group policy degrades to disabled (fail-closed)', () => {
  const security = normalizeQQSecurityConfig({
    enabled: true,
    appId: APP_ID,
    groupPolicy: 'ALLOW-EVERYTHING' as any,
    groupAllowlist: [GROUP_A],
  });
  assert.equal(security.groupPolicy, 'disabled');
  const gate = resolveQQMessageGate(groupInbound(), {
    enabled: true,
    appId: APP_ID,
    groupPolicy: 'ALLOW-EVERYTHING' as any,
    groupAllowlist: [GROUP_A],
  }, 1);
  assert.equal(gate.action, 'silent-drop');
});

test('SEC-10 the gate never throws: malformed input is a silent drop', () => {
  const nullMsg = resolveQQMessageGate(null, null, 1);
  assert.equal(nullMsg.action, 'silent-drop');
  assert.equal(nullMsg.trust.toolScope, 'none');

  const noSender = resolveQQMessageGate(inbound({ senderId: '' }), baseConfig(), 1);
  assert.equal(noSender.action, 'silent-drop');
  assert.equal(noSender.reason, 'missing-stable-sender-id');

  const unsupported = resolveQQMessageGate(inbound({ kind: 'guild' }), baseConfig(), 1);
  assert.equal(unsupported.action, 'silent-drop');
});

test('SEC-11 inviter information is never trusted: only the allowlist decides', () => {
  // The QQ SDK delivers no join event and no inviter field. Even if a payload
  // smuggled one in, the gate must not consult it.
  const forged = groupInbound({
    groupOpenid: GROUP_B,
    inviterId: OWNER,
    operatorId: OWNER,
    rawEventType: 'GROUP_ADD_ROBOT',
  } as Partial<QQInboundLike>);
  const gate = resolveQQMessageGate(forged, baseConfig({ groupAllowlist: [GROUP_A] }), 1);
  assert.equal(gate.action, 'silent-drop');
  assert.equal(gate.reason, 'group-not-allowlisted');
});

test('SEC-12 audit summaries are whitespace-collapsed and capped', () => {
  assert.equal(summarizeForAudit('  a\n\n b\t c  '), 'a b c');
  const long = summarizeForAudit('x'.repeat(500));
  assert.equal(long.length, 200);
  assert.ok(long.endsWith('…'));
});

test('SEC-13 group workspaces are isolated per group and path-safe', () => {
  const a = resolveQQGroupWorkspace(GROUP_A);
  const b = resolveQQGroupWorkspace('../../etc/passwd');
  assert.notEqual(a, b);
  assert.ok(!b.includes('..'), 'path traversal must be neutralized');
  assert.ok(a.endsWith('group-openid-A'));
});

// ---------------------------------------------------------------------------
// Gateway enforcement (offline)
// ---------------------------------------------------------------------------

test('SEC-14 a non-allowlisted group gets NO reply and no callback', async () => {
  const harness = await startHarness({ config: { groupAllowlist: [GROUP_A] } });
  try {
    let calls = 0;
    harness.gateway.setMessageCallback(async (_message, reply) => {
      calls += 1;
      await reply('should never happen');
    });
    await harness.bot.emitMessage(groupInbound({ groupOpenid: GROUP_B }));
    await settle();
    assert.equal(calls, 0);
    assert.equal(harness.bot.sentTexts.length, 0, 'silence, not a refusal');
    const audit = harness.audit.readRecent(10);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].outcome, 'dropped');
    assert.equal(audit[0].groupId, GROUP_B);
  } finally {
    await harness.gateway.stop();
  }
});

test('SEC-15 a stranger DM produces no reply, no typing, no callback', async () => {
  const harness = await startHarness();
  try {
    let calls = 0;
    harness.gateway.setMessageCallback(async () => {
      calls += 1;
    });
    await harness.bot.emitMessage(inbound({ senderId: STRANGER, content: 'let me in' }));
    await settle();
    assert.equal(calls, 0);
    assert.equal(harness.bot.sentTexts.length, 0);
  } finally {
    await harness.gateway.stop();
  }
});

test('SEC-16 an allowed group turn carries a frozen no-tool trust context', async () => {
  const harness = await startHarness({ config: { groupAllowlist: [GROUP_A] } });
  try {
    const received: any[] = [];
    harness.gateway.setMessageCallback(async (message, reply) => {
      received.push(message);
      await reply('answer');
    });
    await harness.bot.emitMessage(groupInbound({ messageId: 'm-allowed' }));
    await waitFor(() => received.length === 1);
    assert.equal(received[0].trust.level, 'group');
    assert.equal(received[0].trust.toolScope, 'none');
    assert.equal(received[0].trust.memoryWrite, false);
    assert.ok(Object.isFrozen(received[0].trust), 'trust context must be immutable');
    assert.equal(harness.bot.sentTexts[0].content, 'answer');

    // The audit line is written after the reply settles.
    await settle();
    const audit = harness.audit.readRecent(10);
    assert.equal(audit[0].outcome, 'answered');
    assert.equal(audit[0].groupId, GROUP_A);
    assert.equal(audit[0].senderId, 'member-openid-1');
    assert.match(audit[0].question, /hi/);
    assert.equal(audit[0].reply, 'answer');
  } finally {
    await harness.gateway.stop();
  }
});

test('SEC-17 group images/files/videos are never downloaded — fixed notice only', async () => {
  const network = makeMediaNetwork(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const harness = await startHarness({ config: { groupAllowlist: [GROUP_A] }, network });
  try {
    let calls = 0;
    harness.gateway.setMessageCallback(async () => {
      calls += 1;
    });
    await harness.bot.emitMessage(
      groupInbound({
        messageId: 'm-media-group',
        content: '<@!102000001> look at this',
        attachments: [
          { content_type: 'image/png', url: 'https://cdn.example/a.png', filename: 'a.png' },
          { content_type: 'file', url: 'https://cdn.example/b.pdf', filename: 'b.pdf' },
          { content_type: 'video/mp4', url: 'https://cdn.example/c.mp4', filename: 'c.mp4' },
        ],
      })
    );
    await waitFor(() => harness.bot.sentTexts.length === 1);
    assert.equal(calls, 0, 'the model must not run for a group attachment');
    assert.deepEqual(network.urls, [], 'no download may be attempted');
    assert.deepEqual(fs.readdirSync(harness.mediaRoot), [], 'nothing may land on disk');
    assert.equal(harness.bot.sentTexts[0].content, QQ_GROUP_MEDIA_NOTICE);

    const audit = harness.audit.readRecent(5);
    assert.equal(audit[0].outcome, 'static-reply');
    assert.equal(audit[0].reply, QQ_GROUP_MEDIA_NOTICE);
  } finally {
    await harness.gateway.stop();
  }
});

test('SEC-18 owner DM still downloads attachments (layer 2 unchanged)', async () => {
  const network = makeMediaNetwork(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const harness = await startHarness({ network });
  try {
    const received: any[] = [];
    harness.gateway.setMessageCallback(async (message) => {
      received.push(message);
    });
    await harness.bot.emitMessage(
      inbound({
        messageId: 'm-owner-media',
        content: '',
        attachments: [
          { content_type: 'image/png', url: 'https://cdn.example/ok.png', filename: 'ok.png' },
        ],
      })
    );
    await waitFor(() => received.length === 1);
    assert.equal(network.urls.length, 1);
    assert.equal(received[0].trust.attachmentPolicy, 'allow');
    assert.ok(received[0].attachments?.[0]?.localPath);
  } finally {
    await harness.gateway.stop();
  }
});

test('SEC-19 a bot sender is dropped even in an open group (no reply, no callback)', async () => {
  const harness = await startHarness({ config: { groupPolicy: 'open' } });
  try {
    let calls = 0;
    harness.gateway.setMessageCallback(async () => {
      calls += 1;
    });
    await harness.bot.emitMessage(groupInbound({ senderIsBot: true, messageId: 'm-bot' }));
    await settle();
    assert.equal(calls, 0);
    assert.equal(harness.bot.sentTexts.length, 0);
  } finally {
    await harness.gateway.stop();
  }
});

// ---------------------------------------------------------------------------
// Cross-boundary / wiring guards (static, no runtime needed)
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, '..');

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
}

test('SEC-20 runner: no-trust sessions get an EMPTY tool surface and a deny-all backstop', () => {
  const source = readSource('src/main/libs/coworkRunner.ts');
  assert.match(
    source,
    /if \(activeSession\?\.imTrust && !imTrustAllowsTools\(activeSession\.imTrust\)\) \{\s*return \[\]/,
    'buildDshHostTools must return an empty list for no-tool trust'
  );
  assert.match(
    source,
    /IM trust gate: this conversation has no tool surface/,
    'the policy hook must deny built-in tools for no-tool trust'
  );
  assert.match(
    source,
    /skillsCatalogMode: 'legacy'/,
    'skills catalog must be suppressed for no-tool trust'
  );
  assert.match(
    source,
    /trustSuppressed/,
    'browser tabs / goal / skills tail must be suppressed for no-tool trust'
  );
});

test('SEC-21 group conversations stay out of nightly consolidation and the recent-session pulse', () => {
  const dream = readSource('src/main/dreamStore.ts');
  assert.match(
    dream,
    /gm\.channel LIKE 'im:%:group'/,
    'dream activity must not ingest IM group sessions'
  );
  const handler = readSource('src/main/im/imCoworkHandler.ts');
  assert.match(
    handler,
    /setSessionHiddenFromList\(session\.id, true\)/,
    'group sessions must be hidden, which also excludes them from the recent-session pulse'
  );
  const store = readSource('src/main/coworkStore.ts');
  assert.match(
    store,
    /recentSessionPulse\([\s\S]*?hidden_from_session_list, 0\) = 0/,
    'the recent-session pulse must keep filtering hidden sessions'
  );
});

test('SEC-22 IM handler: group sessions get an isolated workspace, a minimal prompt and no memory', () => {
  const source = readSource('src/main/im/imCoworkHandler.ts');
  assert.match(source, /resolveQQGroupWorkspace\(/, 'group workspace must be isolated');
  assert.match(source, /buildGroupChatSystemPrompt\(/, 'group prompt must be minimal');
  assert.match(source, /disableMemoryUpdates: true/, 'group turns must disable memory entirely');
  assert.match(source, /imTrust: trust/, 'trust must be handed to the runner on every turn');
});

test('SEC-23 QQ config defaults are the strict ones', () => {
  const source = readSource('src/main/im/types.ts');
  const block = source.slice(source.indexOf('export const DEFAULT_QQ_CONFIG'));
  const end = block.indexOf('};');
  const defaults = block.slice(0, end);
  assert.match(defaults, /groupPolicy: 'allowlist'/);
  assert.match(defaults, /groupAllowlist: \[\]/);
  assert.match(defaults, /localToolsEnabled: false/);
  assert.match(defaults, /localToolsAllowFrom: \[\]/);
});

test('SEC-24 docs state that the inviter cannot be verified', () => {
  const doc = readSource('docs/qq-channel.md');
  assert.match(doc, /无法校验邀请人|inviter cannot be verified/i);
});
