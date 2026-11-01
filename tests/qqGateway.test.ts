/**
 * QQ gateway unit tests.
 *
 * Everything here runs against fake SDK / connector / network surfaces: no
 * request ever leaves the process, so the suite is safe offline and in CI.
 *
 * Run: npx tsx --test tests/qqGateway.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  QQGateway,
  qqAccountSlot,
  type QQBotFactory,
  type QQBotLike,
  type QQConnectHandlers,
  type QQConnectStarter,
  type QQMediaNetwork,
  type QQProbeFetch,
} from '../src/main/im/qqGateway';
import { QQStore, normalizeQQAccountId } from '../src/main/im/qqStore';
import {
  QQ_INBOUND_MAX_BYTES,
  QQ_MEDIA_LIMITS_BYTES,
  QQ_PASSIVE_REPLY_TTL_MS,
  QQ_TEXT_CHUNK_LIMIT,
  classifyQQInbound,
  classifyQQOutbound,
  qqConversationId,
  qqMentionDecision,
  readQQMediaRefs,
  splitQQText,
  stripQQMentionMarkers,
  toQQIMMessage,
  type QQInboundLike,
} from '../src/main/im/qqProtocol';
import {
  assertQQMediaUrl,
  checkQQOutboundFile,
  resolveInsideQQMediaDir,
  sanitizeQQFileName,
  sniffQQMediaMime,
} from '../src/main/im/qqMedia';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Unique temp dir per test; intentionally never deleted (task policy: no deletions). */
function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `idbots-qq-test-${prefix}-`));
}

async function waitFor(condition: () => boolean, timeoutMs = 2000, label = 'condition'): Promise<void> {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function inbound(overrides: Partial<QQInboundLike> = {}): QQInboundLike {
  return {
    kind: 'c2c',
    senderId: 'user-openid-1',
    senderName: 'Tester',
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
  readonly sentMedia: Array<{ kind: string; target: any; localPath: string; content?: string }> = [];
  typingCalls = 0;
  stopped = false;
  private resolveStart: (() => void) | null = null;
  private readonly rejectStart: Error | null;

  constructor(options: { rejectStart?: Error } = {}) {
    this.rejectStart = options.rejectStart ?? null;
  }

  on(event: string, handler: (...args: any[]) => any): QQBotLike {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return this;
  }

  start(): Promise<void> {
    if (this.rejectStart) return Promise.reject(this.rejectStart);
    return new Promise<void>((resolve) => {
      this.resolveStart = resolve;
    });
  }

  stop(): void {
    this.stopped = true;
    this.resolveStart?.();
  }

  async sendText(target: any, content: string): Promise<unknown> {
    this.sentTexts.push({ target, content });
    return { id: `out-${this.sentTexts.length}` };
  }

  async sendTyping(): Promise<unknown> {
    this.typingCalls += 1;
    return { refIdx: 'typing' };
  }

  async sendImage(target: any, source: { localPath: string }, opts?: { content?: string }): Promise<unknown> {
    this.sentMedia.push({ kind: 'image', target, localPath: source.localPath, content: opts?.content });
    return { id: 'img' };
  }

  async sendVideo(target: any, source: { localPath: string }, opts?: { content?: string }): Promise<unknown> {
    this.sentMedia.push({ kind: 'video', target, localPath: source.localPath, content: opts?.content });
    return { id: 'video' };
  }

  async sendFile(
    target: any,
    source: { localPath: string },
    opts?: { fileName?: string; content?: string }
  ): Promise<unknown> {
    this.sentMedia.push({ kind: 'file', target, localPath: source.localPath, content: opts?.content });
    return { id: 'file' };
  }

  async emitMessage(message: QQInboundLike): Promise<void> {
    for (const handler of this.handlers.get('message') ?? []) {
      await handler({}, message);
    }
  }

  emit(event: string, payload?: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) {
      handler(payload);
    }
  }
}

class FakeFactory implements QQBotFactory {
  readonly bots: FakeBot[] = [];
  creates = 0;
  failFirstCreates = 0;
  private readonly rejectStartOnce: number;

  constructor(options: { rejectStartOnce?: number } = {}) {
    this.rejectStartOnce = options.rejectStartOnce ?? 0;
  }

  create(): QQBotLike {
    this.creates += 1;
    if (this.failFirstCreates > 0) {
      this.failFirstCreates -= 1;
      throw new Error('simulated create failure');
    }
    const rejectStart = this.bots.length < this.rejectStartOnce
      ? new Error('simulated gateway start failure')
      : undefined;
    const bot = new FakeBot({ rejectStart });
    this.bots.push(bot);
    return bot;
  }
}

interface ConnectorHarness {
  starter: QQConnectStarter;
  callbacks: () => QQConnectHandlers;
  disposed: () => boolean;
  options: () => { displayQrCodeToConsole?: boolean; source?: string } | undefined;
}

function makeConnector(): ConnectorHarness {
  let handlers: QQConnectHandlers | null = null;
  let disposed = false;
  let receivedOptions: { displayQrCodeToConsole?: boolean; source?: string } | undefined;
  return {
    starter: async (callbacks, options) => {
      handlers = callbacks;
      receivedOptions = options;
      return () => {
        disposed = true;
      };
    },
    callbacks: () => {
      if (!handlers) throw new Error('connect starter was not called');
      return handlers;
    },
    disposed: () => disposed,
    options: () => receivedOptions,
  };
}

function makeMediaNetwork(bytes: Buffer, contentType = 'image/png'): QQMediaNetwork & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    async fetchBytes(url: string) {
      urls.push(url);
      return { bytes, contentType };
    },
  };
}

interface GatewayHarness {
  gateway: QQGateway;
  store: QQStore;
  factory: FakeFactory;
  connector: ConnectorHarness;
  mediaRoot: string;
  stateDir: string;
  clock: { value: number };
  sleeps: number[];
}

function makeGateway(options: {
  mediaNetwork?: QQMediaNetwork;
  probeFetch?: QQProbeFetch;
  reconnectBackoffMs?: number[];
  rejectStartOnce?: number;
  mediaRoot?: string;
} = {}): GatewayHarness {
  const stateDir = makeTempDir('state');
  const mediaRoot = options.mediaRoot ?? makeTempDir('media');
  const store = new QQStore(stateDir);
  const factory = new FakeFactory({ rejectStartOnce: options.rejectStartOnce });
  const connector = makeConnector();
  const clock = { value: 1_700_000_000_000 };
  const sleeps: number[] = [];

  const gateway = new QQGateway({
    store,
    botFactory: factory,
    connectStarter: connector.starter,
    now: () => clock.value,
    sleep: async (ms) => {
      sleeps.push(ms);
      await Promise.resolve();
    },
    reconnectBackoffMs: options.reconnectBackoffMs ?? [10, 20, 40],
    mediaRootDir: mediaRoot,
    mediaNetwork: options.mediaNetwork ?? makeMediaNetwork(Buffer.from('fake-bytes')),
    probeFetch: options.probeFetch,
    typingIndicator: true,
  });

  return { gateway, store, factory, connector, mediaRoot, stateDir, clock, sleeps };
}

async function startGateway(harness: GatewayHarness): Promise<FakeBot> {
  await harness.gateway.start({
    enabled: true,
    appId: '102000001',
    appSecret: 'test-secret-value',
    debug: false,
  });
  await waitFor(() => harness.factory.bots.length === 1, 2000, 'first bot');
  return harness.factory.bots[0];
}

function pngBytes(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
}

// ---------------------------------------------------------------------------
// Pure protocol helpers
// ---------------------------------------------------------------------------

test('conversation ids keep direct and group chats apart', () => {
  assert.equal(qqConversationId('c2c', 'user-1'), 'qq:c2c:user-1');
  assert.equal(qqConversationId('group', 'user-1'), 'qq:group:user-1');
  assert.notEqual(qqConversationId('c2c', 'same'), qqConversationId('group', 'same'));
});

test('toQQIMMessage maps c2c and group messages including chatType', () => {
  const direct = toQQIMMessage(inbound({ content: 'hi' }), {
    appId: '102000001',
    now: 1_700_000_000_000,
  });
  assert.ok(direct);
  assert.equal(direct.platform, 'qq');
  assert.equal(direct.chatType, 'direct');
  assert.equal(direct.conversationId, 'qq:c2c:user-openid-1');
  assert.equal(direct.content, 'hi');
  assert.equal(direct.timestamp, Date.parse('2026-11-02T00:00:00Z'));

  const group = toQQIMMessage(
    inbound({
      kind: 'group',
      groupOpenid: 'group-openid-9',
      rawEventType: 'GROUP_AT_MESSAGE_CREATE',
      content: '<@!102000001> ping',
    }),
    { appId: '102000001', now: 1_700_000_000_000 }
  );
  assert.ok(group);
  assert.equal(group.chatType, 'group');
  assert.equal(group.conversationId, 'qq:group:group-openid-9');
  assert.equal(group.content, 'ping');
});

test('guild/dm messages are outside this channel and map to null', () => {
  const guild = toQQIMMessage(inbound({ kind: 'guild', channelId: 'c1' }), {
    appId: '102000001',
    now: 1,
  });
  assert.equal(guild, null);
});

test('group @-mention gate: event, structured mentions, content fallback, and plain group', () => {
  const appId = '102000001';
  assert.equal(
    qqMentionDecision(inbound({ kind: 'group', rawEventType: 'GROUP_AT_MESSAGE_CREATE' }), appId).via,
    'event'
  );
  assert.equal(
    qqMentionDecision(
      inbound({ kind: 'group', rawEventType: 'GROUP_MESSAGE_CREATE', mentions: [{ is_you: true }] }),
      appId
    ).via,
    'mentions'
  );
  assert.equal(
    qqMentionDecision(
      inbound({ kind: 'group', rawEventType: 'GROUP_MESSAGE_CREATE', content: '<@102000001> yo' }),
      appId
    ).via,
    'content'
  );
  const plain = qqMentionDecision(
    inbound({ kind: 'group', rawEventType: 'GROUP_MESSAGE_CREATE', content: 'no mention here' }),
    appId
  );
  assert.deepEqual(plain, { mentioned: false, via: 'none' });
  assert.equal(qqMentionDecision(inbound({ kind: 'c2c' }), appId).mentioned, true);
});

test('mention markers are stripped from content', () => {
  assert.equal(stripQQMentionMarkers('<@!1020> hello <@!1020> world', '1020'), 'hello world');
  assert.equal(stripQQMentionMarkers('<@other> text', '1020'), '<@other> text');
});

test('splitQQText respects the client-side chunk limit and marks truncation', () => {
  const long = 'a'.repeat(QQ_TEXT_CHUNK_LIMIT + 50);
  const chunks = splitQQText(long);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].length, QQ_TEXT_CHUNK_LIMIT);

  const runaway = 'b'.repeat(QQ_TEXT_CHUNK_LIMIT * 30);
  const capped = splitQQText(runaway, QQ_TEXT_CHUNK_LIMIT, 3);
  assert.equal(capped.length, 3);
  assert.match(capped[capped.length - 1], /\(truncated\)$/);
  assert.deepEqual(splitQQText('   '), []);
});

test('inbound and outbound media classification', () => {
  assert.equal(classifyQQInbound('image/png', 'x.bin'), 'image');
  assert.equal(classifyQQInbound('video/mp4', 'x.bin'), 'video');
  assert.equal(classifyQQInbound(undefined, 'a.pdf'), 'document');
  assert.equal(classifyQQOutbound('/tmp/a.PNG'), 'image');
  assert.equal(classifyQQOutbound('/tmp/a.mp4'), 'video');
  assert.equal(classifyQQOutbound('/tmp/a.pdf'), 'file');
});

test('readQQMediaRefs prefers voice_wav_url and drops non-https urls', () => {
  const { refs, skipped, asrTexts } = readQQMediaRefs([
    { content_type: 'audio/silk', url: 'ftp://bad', voice_wav_url: 'https://cdn.example/voice.wav', asr_refer_text: '你好' },
    { content_type: 'image/png', url: 'https://cdn.example/a.png', filename: 'a.png' },
    { content_type: 'file/pdf', url: 'http://insecure.example/a.pdf' },
  ]);
  assert.equal(refs.length, 2);
  assert.equal(refs[0].url, 'https://cdn.example/voice.wav');
  assert.equal(skipped, 1);
  assert.deepEqual(asrTexts, ['你好']);
});

// ---------------------------------------------------------------------------
// File-name / path safety
// ---------------------------------------------------------------------------

test('remote file names cannot traverse directories', () => {
  assert.equal(sanitizeQQFileName('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeQQFileName('..\\..\\windows\\system32\\evil.exe'), 'evil.exe');
  assert.equal(sanitizeQQFileName('..'), 'qq-file');
  assert.equal(sanitizeQQFileName('\u0000\u0001'), 'qq-file');
  assert.equal(sanitizeQQFileName('report.pdf'), 'report.pdf');
  const long = `${'x'.repeat(400)}.pdf`;
  assert.ok(sanitizeQQFileName(long).length <= 120);
});

test('resolveInsideQQMediaDir refuses escapes', () => {
  const dir = makeTempDir('inside');
  assert.equal(resolveInsideQQMediaDir(dir, 'ok.txt'), path.join(dir, 'ok.txt'));
  assert.throws(() => resolveInsideQQMediaDir(dir, '../escape.txt'), /outside the media directory/);
  assert.throws(() => resolveInsideQQMediaDir(dir, path.join('a', '..', '..', 'x')), /outside/);
});

test('media urls must be https and must not target localhost/private literals', () => {
  assert.equal(assertQQMediaUrl('https://cdn.example/a.png').hostname, 'cdn.example');
  for (const bad of [
    'http://cdn.example/a.png',
    'https://localhost/a.png',
    'https://127.0.0.1/a.png',
    'https://192.168.1.5/a.png',
    'https://169.254.1.1/a.png',
    'https://[::1]/a.png',
    'https://user:pass@cdn.example/a.png',
  ]) {
    assert.throws(() => assertQQMediaUrl(bad), /media url/);
  }
});

test('documented upload ceilings match the installed SDK', async () => {
  // Local module import only: no network. This is the guard that keeps the
  // constants in qqProtocol.ts from drifting away from the SDK's own table.
  const sdk: any = await import('@tencent-connect/qqbot-nodejs');
  assert.equal(sdk.getMaxUploadSize(sdk.MediaFileType.IMAGE), QQ_MEDIA_LIMITS_BYTES.image);
  assert.equal(sdk.getMaxUploadSize(sdk.MediaFileType.VIDEO), QQ_MEDIA_LIMITS_BYTES.video);
  assert.equal(sdk.getMaxUploadSize(sdk.MediaFileType.VOICE), QQ_MEDIA_LIMITS_BYTES.voice);
  assert.equal(sdk.getMaxUploadSize(sdk.MediaFileType.FILE), QQ_MEDIA_LIMITS_BYTES.file);
});

test('MIME sniffing and outbound limits', () => {
  assert.equal(sniffQQMediaMime(pngBytes()), 'image/png');
  assert.equal(sniffQQMediaMime(Buffer.from([0xff, 0xd8, 0xff, 0x00])), 'image/jpeg');
  assert.equal(sniffQQMediaMime(Buffer.from('nope')), null);

  const dir = makeTempDir('limits');
  const img = path.join(dir, 'big.png');
  fs.writeFileSync(img, '');
  fs.truncateSync(img, QQ_MEDIA_LIMITS_BYTES.image + 1);
  assert.throws(() => checkQQOutboundFile(img, 'image'), /platform ceiling/);

  const missing = path.join(dir, 'missing.png');
  assert.throws(() => checkQQOutboundFile(missing, 'image'), /does not exist/);
});

// ---------------------------------------------------------------------------
// Credential store
// ---------------------------------------------------------------------------

test('QQStore writes 0600 files and never returns the secret from a summary', () => {
  const dir = makeTempDir('store');
  const store = new QQStore(dir);
  const saved = store.saveCredentials(
    { appId: '102000001', appSecret: 'super-secret', userOpenid: 'owner-1' },
    { accountId: normalizeQQAccountId('102000001'), source: 'manual', now: 123 }
  );
  assert.equal(saved.appId, '102000001');
  assert.equal(normalizeQQAccountId(''), 'default');

  const filePath = store.getCredentialsPath(normalizeQQAccountId('102000001'));
  assert.ok(fs.existsSync(filePath));
  if (process.platform !== 'win32') {
    const mode = fs.statSync(filePath).mode & 0o777;
    assert.equal(mode, 0o600);
  }

  const loaded = store.loadCredentials(normalizeQQAccountId('102000001'));
  assert.equal(loaded?.appSecret, 'super-secret');

  const summary = store.describeStored(normalizeQQAccountId('102000001'));
  assert.equal(summary.present, true);
  assert.equal(summary.appId, '102000001');
  assert.ok(!JSON.stringify(summary).includes('super-secret'));

  // The fixture is intentionally left on disk (task policy: no deletions).
});

// ---------------------------------------------------------------------------
// Inbound flow
// ---------------------------------------------------------------------------

test('c2c message reaches the callback and a reply carries the passive msgId', async () => {
  const harness = makeGateway();
  try {
    const received: any[] = [];
    harness.gateway.setMessageCallback(async (message, reply) => {
      received.push(message);
      await reply('pong');
    });
    const bot = await startGateway(harness);

    await bot.emitMessage(inbound({ messageId: 'm-c2c-1', content: 'hello' }));
    await waitFor(() => received.length === 1);

    assert.equal(received[0].conversationId, 'qq:c2c:user-openid-1');
    assert.equal(received[0].chatType, 'direct');
    assert.equal(bot.sentTexts.length, 1);
    assert.deepEqual(bot.sentTexts[0].target, {
      scope: 'c2c',
      targetId: 'user-openid-1',
      msgId: 'm-c2c-1',
    });
    assert.equal(bot.sentTexts[0].content, 'pong');
    assert.equal(bot.typingCalls, 1, 'C2C shows a typing indicator');
  } finally {
    await harness.gateway.stop();
  }
});

test('group chat answers @-mentions only and isolates conversations', async () => {
  const harness = makeGateway();
  try {
    const received: any[] = [];
    harness.gateway.setMessageCallback(async (message, reply) => {
      received.push(message);
      await reply('group-pong');
    });
    const bot = await startGateway(harness);

    await bot.emitMessage(
      inbound({
        kind: 'group',
        groupOpenid: 'g-1',
        messageId: 'm-group-plain',
        rawEventType: 'GROUP_MESSAGE_CREATE',
        content: 'just chatting',
      })
    );
    await bot.emitMessage(
      inbound({
        kind: 'group',
        groupOpenid: 'g-1',
        messageId: 'm-group-at',
        rawEventType: 'GROUP_AT_MESSAGE_CREATE',
        content: '<@!102000001> help',
      })
    );
    await waitFor(() => received.length === 1);

    assert.equal(received[0].conversationId, 'qq:group:g-1');
    assert.equal(received[0].chatType, 'group');
    assert.equal(received[0].content, 'help');
    assert.equal(bot.typingCalls, 0, 'group chats get no typing indicator');
    assert.equal(bot.sentTexts[0].target.scope, 'group');
    assert.equal(bot.sentTexts[0].target.targetId, 'g-1');
  } finally {
    await harness.gateway.stop();
  }
});

test('duplicate platform message ids are processed once', async () => {
  const harness = makeGateway();
  try {
    let calls = 0;
    harness.gateway.setMessageCallback(async () => {
      calls += 1;
    });
    const bot = await startGateway(harness);
    const message = inbound({ messageId: 'same-id' });
    await bot.emitMessage(message);
    await bot.emitMessage(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls, 1);
  } finally {
    await harness.gateway.stop();
  }
});

test('inbound image is downloaded into the workspace media dir with a safe name', async () => {
  const network = makeMediaNetwork(pngBytes(), 'image/png');
  const harness = makeGateway({ mediaNetwork: network });
  try {
    const received: any[] = [];
    harness.gateway.setMessageCallback(async (message) => {
      received.push(message);
    });
    const bot = await startGateway(harness);

    await bot.emitMessage(
      inbound({
        messageId: 'm-media-1',
        content: '',
        attachments: [
          {
            content_type: 'image/png',
            url: 'https://cdn.example/x.png',
            filename: '../../evil name.png',
            width: 64,
            height: 64,
          },
        ],
      })
    );
    await waitFor(() => received.length === 1);

    const attachment = received[0].attachments[0];
    assert.equal(attachment.type, 'image');
    assert.equal(attachment.mimeType, 'image/png');
    assert.equal(attachment.fileName, 'evil name.png');
    assert.equal(attachment.width, 64);
    assert.ok(attachment.localPath.startsWith(path.resolve(harness.mediaRoot)));
    assert.ok(!attachment.localPath.includes('..'));
    assert.ok(fs.existsSync(attachment.localPath));
    assert.deepEqual(fs.readFileSync(attachment.localPath), pngBytes());
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(attachment.localPath).mode & 0o777, 0o600);
    }
  } finally {
    await harness.gateway.stop();
  }
});

test('oversized and non-https inbound attachments are reported, not written', async () => {
  const network = makeMediaNetwork(pngBytes(), 'image/png');
  const harness = makeGateway({ mediaNetwork: network });
  try {
    const received: any[] = [];
    harness.gateway.setMessageCallback(async (message) => {
      received.push(message);
    });
    const bot = await startGateway(harness);

    await bot.emitMessage(
      inbound({
        messageId: 'm-media-over',
        attachments: [
          {
            content_type: 'image/png',
            url: 'https://cdn.example/huge.png',
            filename: 'huge.png',
            size: QQ_INBOUND_MAX_BYTES + 1,
          },
          { content_type: 'image/png', url: 'http://insecure/h.png' },
        ],
      })
    );
    await waitFor(() => received.length === 1);

    assert.equal(received[0].attachments, undefined);
    assert.match(received[0].content, /2 attachment\(s\) failed to download/);
    assert.equal(fs.readdirSync(harness.mediaRoot).length, 0);
  } finally {
    await harness.gateway.stop();
  }
});

// ---------------------------------------------------------------------------
// Concurrency / queueing
// ---------------------------------------------------------------------------

test('same-conversation messages are serialized; different conversations run in parallel', async () => {
  const harness = makeGateway();
  try {
    const order: string[] = [];
    const gates = new Map<string, () => void>();
    harness.gateway.setMessageCallback(async (message) => {
      order.push(`start:${message.content}`);
      await new Promise<void>((resolve) => gates.set(message.content, resolve));
      order.push(`end:${message.content}`);
    });
    const bot = await startGateway(harness);

    const first = bot.emitMessage(inbound({ messageId: 'q-1', content: 'first' }));
    await waitFor(() => gates.has('first'));
    const second = bot.emitMessage(inbound({ messageId: 'q-2', content: 'second' }));
    const other = bot.emitMessage(
      inbound({ kind: 'c2c', senderId: 'user-2', messageId: 'q-3', content: 'other-chat' })
    );
    await waitFor(() => gates.has('other-chat'), 1000, 'parallel conversation');

    assert.deepEqual(order.filter((entry) => entry.startsWith('start:')), ['start:first', 'start:other-chat']);

    gates.get('first')?.();
    await waitFor(() => gates.has('second'), 1000, 'queued message');
    assert.ok(order.includes('end:first'));
    gates.get('second')?.();
    gates.get('other-chat')?.();
    await Promise.all([first, second, other]);

    assert.deepEqual(order, ['start:first', 'start:other-chat', 'end:first', 'start:second', 'end:second', 'end:other-chat']);
    await waitFor(() => harness.gateway.getQueueDepth('qq:c2c:user-openid-1') === 0, 1000, 'queue drained');
  } finally {
    await harness.gateway.stop();
  }
});

test('a busy conversation sends one queue notice and rate-limits it', async () => {
  const harness = makeGateway();
  try {
    const releases: Array<() => void> = [];
    harness.gateway.setMessageCallback(async () => {
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
    });
    const bot = await startGateway(harness);

    const pending = bot.emitMessage(inbound({ messageId: 'n-1', content: 'one' }));
    await waitFor(() => releases.length === 1);
    pending.catch(() => undefined);
    const queued = bot.emitMessage(inbound({ messageId: 'n-2', content: 'two' }));
    queued.catch(() => undefined);
    await waitFor(() => bot.sentTexts.length === 1, 1000, 'first queue notice');

    assert.match(bot.sentTexts[0].content, /还在处理中/);

    // Widen the clock past the cooldown but keep the first task running: the
    // second notice is allowed again.
    harness.clock.value += 31_000;
    const queuedAgain = bot.emitMessage(inbound({ messageId: 'n-3', content: 'three' }));
    queuedAgain.catch(() => undefined);
    await waitFor(() => bot.sentTexts.length === 2, 1000, 'second queue notice');

    // Drain the FIFO: each started task registers the resolver for the next one.
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const next = releases.shift();
      if (!next) {
        if (harness.gateway.getQueueDepth('qq:c2c:user-openid-1') === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      next();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await Promise.all([pending, queued, queuedAgain]);
  } finally {
    await harness.gateway.stop();
  }
});

// ---------------------------------------------------------------------------
// Outbound
// ---------------------------------------------------------------------------

test('sendText drops an expired passive msgId and chunks long answers', async () => {
  const harness = makeGateway();
  try {
    harness.gateway.setMessageCallback(async () => undefined);
    const bot = await startGateway(harness);
    await bot.emitMessage(inbound({ messageId: 'ttl-1' }));

    await harness.gateway.sendText('qq:c2c:user-openid-1', 'short');
    assert.equal(bot.sentTexts[0].target.msgId, 'ttl-1');

    harness.clock.value += QQ_PASSIVE_REPLY_TTL_MS + 1;
    await harness.gateway.sendText('qq:c2c:user-openid-1', 'after the window');
    assert.equal(bot.sentTexts[1].target.msgId, undefined, 'degrades to an active push');

    const long = 'x'.repeat(QQ_TEXT_CHUNK_LIMIT + 10);
    await harness.gateway.sendText('qq:c2c:user-openid-1', long);
    assert.equal(bot.sentTexts.length, 4);
  } finally {
    await harness.gateway.stop();
  }
});

test('sendMedia picks the right SDK helper and enforces the platform ceiling', async () => {
  const harness = makeGateway();
  try {
    harness.gateway.setMessageCallback(async () => undefined);
    const bot = await startGateway(harness);
    await bot.emitMessage(inbound({ messageId: 'media-out' }));

    const imagePath = path.join(harness.mediaRoot, 'photo.png');
    fs.writeFileSync(imagePath, pngBytes());
    await harness.gateway.sendMedia('qq:c2c:user-openid-1', imagePath, 'caption');

    assert.equal(bot.sentMedia.length, 1);
    assert.equal(bot.sentMedia[0].kind, 'image');
    assert.equal(bot.sentMedia[0].localPath, imagePath);
    assert.equal(bot.sentMedia[0].content, 'caption');

    const bigVideo = path.join(harness.mediaRoot, 'big.mp4');
    fs.writeFileSync(bigVideo, '');
    fs.truncateSync(bigVideo, QQ_MEDIA_LIMITS_BYTES.video + 1);
    await assert.rejects(
      () => harness.gateway.sendMedia('qq:c2c:user-openid-1', bigVideo),
      /platform ceiling/
    );
  } finally {
    await harness.gateway.stop();
  }
});

// ---------------------------------------------------------------------------
// Reconnect / status
// ---------------------------------------------------------------------------

test('supervisor applies exponential backoff and keeps the gateway alive', async () => {
  const harness = makeGateway({ reconnectBackoffMs: [10, 20, 40] });
  harness.factory.failFirstCreates = 3;
  try {
    await harness.gateway.start({
      enabled: true,
      appId: '102000001',
      appSecret: 'test-secret-value',
      debug: false,
    });
    await waitFor(() => harness.factory.bots.length === 1, 2000, 'recovered bot');
    assert.deepEqual(harness.sleeps, [10, 20, 40]);
    assert.equal(harness.factory.creates, 4);
    assert.match(harness.gateway.getStatus().lastError ?? '', /simulated create failure/);
  } finally {
    await harness.gateway.stop();
  }
});

test('fatal start failure keeps retrying and finally reports connected on ready', async () => {
  const harness = makeGateway({ rejectStartOnce: 2, reconnectBackoffMs: [5, 5, 5] });
  try {
    await harness.gateway.start({
      enabled: true,
      appId: '102000001',
      appSecret: 'test-secret-value',
      debug: false,
    });
    await waitFor(() => harness.factory.bots.length === 3, 2000, 'third bot');
    const bot = harness.factory.bots[2];
    bot.emit('ready');
    await waitFor(() => harness.gateway.getStatus().connected, 1000, 'ready state');
    assert.equal(harness.gateway.getStatus().lastError, null);
  } finally {
    await harness.gateway.stop();
  }
});

test('probeAuth reports success without ever echoing the AppSecret', async () => {
  const seen: string[] = [];
  const probeFetch: QQProbeFetch = async (request) => {
    seen.push(request.url);
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'token-abc', expires_in: 7200 }),
    };
  };
  const harness = makeGateway({ probeFetch });
  const message = await harness.gateway.probeAuth(1000, {
    enabled: true,
    appId: '102000001',
    appSecret: 'super-secret-value',
  });
  assert.match(message, /102000001/);
  assert.ok(!message.includes('super-secret-value'));
  assert.ok(seen[0].startsWith('https://bots.qq.com/app/getAppAccessToken'));
});

test('probeAuth surfaces a credential error without leaking the secret', async () => {
  const probeFetch: QQProbeFetch = async () => ({
    ok: false,
    status: 401,
    json: async () => ({ error: 'invalid appSecret super-secret-value' }),
  });
  const harness = makeGateway({ probeFetch });
  await assert.rejects(
    () => harness.gateway.probeAuth(1000, { enabled: true, appId: '102000001', appSecret: 'super-secret-value' }),
    (error: Error) => {
      assert.match(error.message, /HTTP 401/);
      assert.ok(!error.message.includes('super-secret-value'));
      return true;
    }
  );
});

// ---------------------------------------------------------------------------
// QR authorization
// ---------------------------------------------------------------------------

test('QR state machine: wait -> scanned/confirmed, credentials persisted 0600', async () => {
  const harness = makeGateway();
  try {
    const qrPending = harness.gateway.requestQrCode();
    await waitFor(() => {
      try {
        harness.connector.callbacks();
        return true;
      } catch {
        return false;
      }
    }, 1000, 'connector start');
    assert.equal(harness.gateway.getStatus().loginPending, true);
    assert.equal(harness.gateway.getStatus().loginState, 'wait');
    assert.equal(harness.connector.options()?.displayQrCodeToConsole, false, 'never print the QR to a log');
    assert.equal(harness.connector.options()?.source, 'idbots');

    harness.connector.callbacks().onQrDisplayed?.('https://qq.com/qr/abc');
    const qr = await qrPending;
    assert.equal(qr.content, 'https://qq.com/qr/abc');
    assert.equal(harness.gateway.getStatus().qrContent, 'https://qq.com/qr/abc');

    harness.connector.callbacks().onQrExpired?.();
    assert.equal(harness.gateway.getStatus().loginState, 'expired');

    harness.connector.callbacks().onQrDisplayed?.('https://qq.com/qr/def');
    harness.connector.callbacks().onSuccess?.([
      { appId: '102000009', appSecret: 'qr-secret', userOpenid: 'owner-openid' },
    ]);

    const credentials = await harness.gateway.pollLogin();
    assert.equal(credentials.appId, '102000009');
    assert.equal(credentials.appSecret, 'qr-secret');

    const status = harness.gateway.getStatus();
    assert.equal(status.loginPending, false);
    assert.equal(status.loginState, 'confirmed');
    assert.equal(status.qrContent, null);
    assert.ok(!JSON.stringify(status).includes('qr-secret'));

    const stored = harness.store.loadCredentials(normalizeQQAccountId('102000009'));
    assert.equal(stored?.appSecret, 'qr-secret');
    assert.equal(stored?.source, 'qr');
    assert.equal(stored?.ownerUserOpenid, 'owner-openid');
  } finally {
    await harness.gateway.stop();
  }
});

test('QR cancel rejects the pending wait and resets the status', async () => {
  const harness = makeGateway();
  try {
    const pending = harness.gateway.requestQrCode();
    await waitFor(() => {
      try {
        harness.connector.callbacks();
        return true;
      } catch {
        return false;
      }
    }, 1000, 'connector start');
    await harness.gateway.cancelLogin();
    await assert.rejects(() => pending, /cancelled|closed/);
    assert.equal(harness.gateway.getStatus().loginPending, false);
    assert.equal(harness.gateway.getStatus().loginState, 'idle');
    assert.equal(harness.connector.disposed(), true);
  } finally {
    await harness.gateway.stop();
  }
});

test('QR failure surfaces an error state and rejects pollLogin', async () => {
  const harness = makeGateway();
  try {
    const pending = harness.gateway.requestQrCode();
    await waitFor(() => {
      try {
        harness.connector.callbacks();
        return true;
      } catch {
        return false;
      }
    }, 1000, 'connector start');
    harness.connector.callbacks().onQrDisplayed?.('https://qq.com/qr/x');
    await pending;
    harness.connector.callbacks().onFailure(new Error('user rejected'));

    assert.equal(harness.gateway.getStatus().loginState, 'error');
    assert.match(harness.gateway.getStatus().lastError ?? '', /user rejected/);
    await assert.rejects(() => harness.gateway.pollLogin(), /user rejected/);
  } finally {
    await harness.gateway.stop();
  }
});

test('beginLogin persists the credential and restarts the gateway with it', async () => {
  const harness = makeGateway();
  try {
    const loginPending = harness.gateway.beginLogin();
    await waitFor(() => {
      try {
        harness.connector.callbacks();
        return true;
      } catch {
        return false;
      }
    }, 1000, 'connector start');
    harness.connector.callbacks().onQrDisplayed?.('https://qq.com/qr/abc');
    const qr = await loginPending;
    assert.equal(typeof qr.content, 'string');
    harness.connector.callbacks().onSuccess?.([
      { appId: '102000010', appSecret: 'begin-secret', userOpenid: 'owner' },
    ]);

    await waitFor(() => harness.factory.creates >= 1, 2000, 'gateway restart');
    const stored = harness.store.loadCredentials(normalizeQQAccountId('102000010'));
    assert.equal(stored?.appSecret, 'begin-secret');
    assert.equal(harness.gateway.getStatus().appId, '102000010');
  } finally {
    await harness.gateway.stop();
  }
});

test('manual credentials are saved under the appId slot and can start the gateway', async () => {
  const harness = makeGateway();
  try {
    const saved = harness.gateway.saveManualCredentials({
      appId: '102000011',
      appSecret: 'manual-secret',
      ownerUserOpenid: 'owner-2',
    });
    assert.equal(saved.appId, '102000011');
    assert.equal(qqAccountSlot('102000011'), '102000011');

    const summary = harness.gateway.credentialSummary();
    assert.equal(summary.hasCredentials, true);
    assert.equal(summary.appId, '102000011');
    assert.equal(summary.source, 'manual');
    assert.ok(!JSON.stringify(summary).includes('manual-secret'));

    await harness.gateway.start({ enabled: true, appId: '102000011', debug: false });
    await waitFor(() => harness.factory.bots.length === 1);
  } finally {
    await harness.gateway.stop();
  }
});
