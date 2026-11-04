/**
 * Weixin gateway unit tests.
 *
 * Everything here runs against a fake transport: no request ever leaves the
 * process, so the suite is safe offline and in CI.
 *
 * Run: npx tsx --test tests/weixinGateway.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { WeixinGateway } from '../src/main/im/weixinGateway';
import { WeixinStore } from '../src/main/im/weixinStore';
import {
  formatWeixinQuotePrefix,
  formatWeixinRawInboundLogLine,
  isWeixinRawLogEnabled,
  parseQrStatusResponse,
  parseUpdatesResponse,
  readWeixinQuoteRef,
  splitWeixinText,
  toIMMessage,
  WeixinSessionExpiredError,
  WEIXIN_QUOTE_TEXT_MAX_CHARS,
  WEIXIN_QUOTE_UNRESOLVED_PREFIX,
  WEIXIN_RAW_LOG_ENV_VAR,
  WEIXIN_RAW_LOG_ITEM_LIST_MAX_CHARS,
  WEIXIN_TEXT_CHUNK_LIMIT,
} from '../src/main/im/weixinProtocol';
import {
  WeixinRequestTimeoutError,
  type WeixinHttpRequest,
  type WeixinHttpResponse,
  type WeixinTransport,
} from '../src/main/im/weixinTransport';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type Handler = (request: WeixinHttpRequest) => Promise<WeixinHttpResponse> | WeixinHttpResponse;

class FakeTransport implements WeixinTransport {
  readonly calls: WeixinHttpRequest[] = [];
  private handler: Handler;

  constructor(handler: Handler) {
    this.handler = handler;
  }

  setHandler(handler: Handler): void {
    this.handler = handler;
  }

  async request(request: WeixinHttpRequest): Promise<WeixinHttpResponse> {
    this.calls.push(request);
    return this.handler(request);
  }

  paths(): string[] {
    return this.calls.map((call) => call.path);
  }

  callsTo(pathName: string): WeixinHttpRequest[] {
    return this.calls.filter((call) => call.path === pathName);
  }
}

/** Unique state dir per test; intentionally never deleted (task policy: no deletions). */
function makeStore(): WeixinStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-weixin-test-'));
  return new WeixinStore(dir);
}

function makeGateway(transport: FakeTransport, store: WeixinStore, extra: {
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  pollBackoffMs?: number[];
} = {}): WeixinGateway {
  let tick = 1_700_000_000_000;
  return new WeixinGateway({
    transport,
    store,
    now: () => ++tick,
    sleep: extra.sleep,
    pollBackoffMs: extra.pollBackoffMs,
  });
}

function seedCredentials(store: WeixinStore, token = 'ilinkbot_test_token'): void {
  store.saveCredentials(
    { token, baseUrl: 'https://ilinkai.weixin.qq.com', botId: 'bot_test@im.bot', userId: 'user@im.wechat' },
    'default'
  );
  store.saveSync('cursor-0', 'default');
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('waitFor timed out');
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** A blocking long poll that only settles when the gateway aborts it. */
function blockingLongPoll(request: WeixinHttpRequest): Promise<WeixinHttpResponse> {
  return new Promise((_resolve, reject) => {
    const signal = request.signal;
    if (!signal) {
      reject(new Error('blocking long poll requires an abort signal'));
      return;
    }
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
}

// ---------------------------------------------------------------------------
// Protocol helpers
// ---------------------------------------------------------------------------

test('splitWeixinText honours the 1800 character limit and prefers line breaks', () => {
  assert.equal(WEIXIN_TEXT_CHUNK_LIMIT, 1800);
  assert.deepEqual(splitWeixinText(''), []);

  const chunks = splitWeixinText('a'.repeat(4000));
  assert.equal(chunks.length, 3);
  assert.equal(chunks[0].length, 1800);
  assert.equal(chunks[1].length, 1800);
  assert.equal(chunks[2].length, 400);

  // A newline near the end of the window wins over a hard cut.
  const paragraph = `${'x'.repeat(1000)}\n${'y'.repeat(1500)}`;
  const paraChunks = splitWeixinText(paragraph);
  assert.equal(paraChunks[0], `${'x'.repeat(1000)}\n`);
  assert.equal(paraChunks.length, 2);

  // A paragraph break is preferred over a single line break.
  const withParagraph = `${'a'.repeat(1200)}\n\n${'b'.repeat(2000)}`;
  const withParagraphChunks = splitWeixinText(withParagraph);
  assert.equal(withParagraphChunks[0], `${'a'.repeat(1200)}\n\n`);

  // Hard cap: the tail is cut with an explicit marker instead of being dropped silently.
  const capped = splitWeixinText('z'.repeat(1800 * 25), 1800, 3);
  assert.equal(capped.length, 3);
  assert.match(capped[2], /…\(truncated\)$/);
});

test('parseQrStatusResponse maps the documented state machine', () => {
  assert.equal(parseQrStatusResponse({ ret: 0, status: 'wait' }).state, 'wait');
  assert.equal(parseQrStatusResponse({ status: 'scaned' }).state, 'scanned');
  assert.equal(parseQrStatusResponse({ status: 'expired' }).state, 'expired');

  const confirmed = parseQrStatusResponse({
    status: 'confirmed',
    bot_token: 'ilinkbot_x',
    ilink_bot_id: 'bot@im.bot',
    ilink_user_id: 'user@im.wechat',
    baseurl: 'https://ilinkai.weixin.qq.com',
  });
  assert.equal(confirmed.state, 'confirmed');
  assert.equal(confirmed.credentials?.token, 'ilinkbot_x');
  assert.equal(confirmed.credentials?.botId, 'bot@im.bot');

  const missingToken = parseQrStatusResponse({ status: 'confirmed' });
  assert.equal(missingToken.state, 'error');
  assert.match(missingToken.error || '', /bot token/);
});

test('parseUpdatesResponse raises a session-expired error on ret=-14', () => {
  assert.throws(
    () => parseUpdatesResponse({ ret: -14, errcode: -14, errmsg: 'session timeout' }),
    (error: unknown) => error instanceof WeixinSessionExpiredError
  );

  const updates = parseUpdatesResponse({
    ret: 0,
    msgs: [{ message_id: 1, from_user_id: 'u@im.wechat', item_list: [{ type: 1, text_item: { text: 'hi' } }] }],
    get_updates_buf: 'cursor-1',
    longpolling_timeout_ms: 35000,
  });
  assert.equal(updates.messages.length, 1);
  assert.equal(updates.nextBuf, 'cursor-1');
  assert.equal(updates.longPollingTimeoutMs, 35000);
});

test('toIMMessage drops bot echoes and keeps direct-chat text', () => {
  assert.equal(toIMMessage({ message_type: 2, from_user_id: 'x' }), null);

  const message = toIMMessage({
    message_id: 9812451782375,
    from_user_id: 'o9cq@im.wechat',
    message_type: 1,
    create_time_ms: 1_774_158_905_123,
    context_token: 'ctx',
    item_list: [{ type: 1, text_item: { text: '帮我总结一下' } }],
  });
  assert.ok(message);
  assert.equal(message?.platform, 'weixin');
  assert.equal(message?.chatType, 'direct');
  assert.equal(message?.conversationId, 'o9cq@im.wechat');
  assert.equal(message?.messageId, '9812451782375');
  assert.equal(message?.content, '帮我总结一下');
  assert.equal(message?.timestamp, 1_774_158_905_123);

  // Media-only messages degrade to a readable placeholder instead of silence.
  const media = toIMMessage({
    message_id: 2,
    from_user_id: 'o9cq@im.wechat',
    message_type: 1,
    item_list: [{ type: 2 }],
  });
  assert.match(media?.content || '', /unsupported weixin message: image/);
});

// ---------------------------------------------------------------------------
// QR authorization
// ---------------------------------------------------------------------------

test('requestQrCode returns the scannable payload and marks the status pending', async () => {
  const store = makeStore();
  const transport = new FakeTransport((request) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.path, 'ilink/bot/get_bot_qrcode');
    assert.equal(request.query?.bot_type, 3);
    assert.deepEqual(request.body, { local_token_list: [] });
    return {
      status: 200,
      data: {
        qrcode: '53be12188f8287ba6b20c7b6d0a90220',
        qrcode_img_content:
          'https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=53be12188f8287ba6b20c7b6d0a90220&bot_type=3',
        ret: 0,
      },
    };
  });
  const gateway = makeGateway(transport, store);

  const qr = await gateway.requestQrCode();
  assert.equal(qr.qrcode, '53be12188f8287ba6b20c7b6d0a90220');
  assert.match(qr.content, /^https:\/\/liteapp\.weixin\.qq\.com\//);

  const status = gateway.getStatus();
  assert.equal(status.loginPending, true);
  assert.equal(status.loginState, 'wait');
  assert.equal(status.qrContent, qr.content);
});

test('pollQrStatus persists the token after confirmation and never leaks it in status', async () => {
  const store = makeStore();
  const transport = new FakeTransport((request) => {
    assert.equal(request.method, 'GET');
    assert.equal(request.path, 'ilink/bot/get_qrcode_status');
    assert.equal(request.query?.qrcode, 'qr-token-1');
    assert.equal(request.extraHeaders?.['iLink-App-ClientVersion'], '1');
    return {
      status: 200,
      data: {
        status: 'confirmed',
        bot_token: 'ilinkbot_secret_value',
        ilink_bot_id: 'e06c1ceea05e@im.bot',
        ilink_user_id: 'o9cq800kum@im.wechat',
        baseurl: 'https://ilinkai.weixin.qq.com',
      },
    };
  });
  const gateway = makeGateway(transport, store);

  // Prime a pending QR without hitting get_bot_qrcode again.
  transport.setHandler((request) => {
    if (request.path === 'ilink/bot/get_bot_qrcode') {
      return { status: 200, data: { qrcode: 'qr-token-1', qrcode_img_content: 'qr-content', ret: 0 } };
    }
    return {
      status: 200,
      data: {
        status: 'confirmed',
        bot_token: 'ilinkbot_secret_value',
        ilink_bot_id: 'e06c1ceea05e@im.bot',
        ilink_user_id: 'o9cq800kum@im.wechat',
        baseurl: 'https://ilinkai.weixin.qq.com',
      },
    };
  });
  await gateway.requestQrCode();

  const result = await gateway.pollQrStatus();
  assert.equal(result.state, 'confirmed');

  const stored = store.loadCredentials('default');
  assert.equal(stored?.token, 'ilinkbot_secret_value');
  assert.equal(stored?.botId, 'e06c1ceea05e@im.bot');

  // The credential file must not be world readable.
  const mode = fs.statSync(store.getCredentialsPath('default')).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600 credential file, got ${mode.toString(8)}`);

  const status = gateway.getStatus();
  assert.equal(status.loginPending, false);
  assert.equal(status.loginState, 'idle');
  assert.equal(status.qrContent, null);
  assert.equal(JSON.stringify(status).includes('ilinkbot_secret_value'), false);
});

test('start() refuses to run without a token, and starts once one is stored', async () => {
  const store = makeStore();
  const transport = new FakeTransport((request) => blockingLongPoll(request));
  const gateway = makeGateway(transport, store);

  await assert.rejects(
    () => gateway.start({ enabled: true, accountId: 'default' }),
    /bot token is missing/i
  );

  seedCredentials(store);
  await gateway.start({ enabled: true, accountId: 'default' });
  assert.equal(gateway.isConnected(), true);
  assert.equal(gateway.getStatus().accountId, 'default');
  await gateway.stop();
});

// ---------------------------------------------------------------------------
// Inbound -> IMMessage -> reply
// ---------------------------------------------------------------------------

test('an inbound message becomes an IMMessage, triggers typing, and is answered with the context token', async () => {
  const store = makeStore();
  seedCredentials(store);

  let getUpdatesCount = 0;
  const transport = new FakeTransport((request) => {
    if (request.path === 'ilink/bot/getupdates') {
      getUpdatesCount += 1;
      if (getUpdatesCount === 1) {
        return {
          status: 200,
          data: {
            ret: 0,
            msgs: [
              {
                message_id: 9812451782375,
                from_user_id: 'user@im.wechat',
                message_type: 1,
                create_time_ms: 1_774_158_905_123,
                context_token: 'AARzJWA-context',
                item_list: [{ type: 1, text_item: { text: '你好，自我介绍一下' } }],
              },
            ],
            get_updates_buf: 'cursor-1',
          },
        };
      }
      return blockingLongPoll(request);
    }
    if (request.path === 'ilink/bot/getconfig') {
      assert.equal(request.body?.ilink_user_id, 'user@im.wechat');
      assert.equal(request.body?.context_token, 'AARzJWA-context');
      return { status: 200, data: { ret: 0, typing_ticket: 'ticket-1' } };
    }
    if (request.path === 'ilink/bot/sendtyping') {
      return { status: 200, data: { ret: 0 } };
    }
    if (request.path === 'ilink/bot/sendmessage') {
      return { status: 200, data: {} };
    }
    throw new Error(`unexpected path ${request.path}`);
  });

  const gateway = makeGateway(transport, store);
  const received: Array<{ content: string; conversationId: string; messageId: string }> = [];
  const replyTexts: string[] = [];

  gateway.setMessageCallback(async (message, replyFn) => {
    received.push({
      content: message.content,
      conversationId: message.conversationId,
      messageId: message.messageId,
    });
    await replyFn('我是半糖浆的网关测试回复。');
    replyTexts.push('sent');
  });

  const emitted: string[] = [];
  gateway.on('message', (message) => emitted.push(message.content));

  await gateway.start({ enabled: true, accountId: 'default' });
  await waitFor(() => replyTexts.length === 1);

  assert.deepEqual(received, [{
    content: '你好，自我介绍一下',
    conversationId: 'user@im.wechat',
    messageId: '9812451782375',
  }]);
  assert.deepEqual(emitted, ['你好，自我介绍一下']);

  // Cursor persisted from the update.
  assert.equal(store.loadSync('default')?.getUpdatesBuf, 'cursor-1');

  const typingCalls = transport.callsTo('ilink/bot/sendtyping');
  assert.deepEqual(typingCalls.map((call) => (call.body as { status: number }).status), [1, 2]);
  assert.ok(typingCalls.every((call) => (call.body as { typing_ticket: string }).typing_ticket === 'ticket-1'));

  const sendCalls = transport.callsTo('ilink/bot/sendmessage');
  assert.equal(sendCalls.length, 1);
  const payload = sendCalls[0].body as {
    msg: { to_user_id: string; message_type: number; message_state: number; context_token: string; item_list: Array<{ type: number; text_item: { text: string } }> };
    base_info: { channel_version: string };
  };
  assert.equal(payload.msg.to_user_id, 'user@im.wechat');
  assert.equal(payload.msg.message_type, 2);
  assert.equal(payload.msg.message_state, 2);
  assert.equal(payload.msg.context_token, 'AARzJWA-context');
  assert.deepEqual(payload.msg.item_list, [{ type: 1, text_item: { text: '我是半糖浆的网关测试回复。' } }]);
  assert.equal(payload.base_info.channel_version, '1.0.0');

  await gateway.stop();
});

test('a second inbound message is dispatched while the first turn is still running', async () => {
  const store = makeStore();
  seedCredentials(store);

  const pollMessage = (messageId: number, text: string) => ({
    message_id: messageId,
    from_user_id: 'user@im.wechat',
    message_type: 1,
    create_time_ms: 1_774_158_905_123,
    context_token: 'AARzJWA-context',
    item_list: [{ type: 1, text_item: { text } }],
  });

  let polls = 0;
  const transport = new FakeTransport((request) => {
    if (request.path === 'ilink/bot/getupdates') {
      polls += 1;
      if (polls === 1) {
        return {
          status: 200,
          data: { ret: 0, msgs: [pollMessage(1, '收到 1')], get_updates_buf: 'cursor-1' },
        };
      }
      if (polls === 2) {
        return {
          status: 200,
          data: { ret: 0, msgs: [pollMessage(2, '收到 2')], get_updates_buf: 'cursor-2' },
        };
      }
      return blockingLongPoll(request);
    }
    if (request.path === 'ilink/bot/getconfig') {
      return { status: 200, data: { ret: 0, typing_ticket: 'ticket-1' } };
    }
    if (request.path === 'ilink/bot/sendtyping') {
      return { status: 200, data: { ret: 0 } };
    }
    throw new Error(`unexpected path ${request.path}`);
  });

  const gateway = makeGateway(transport, store);
  const started: string[] = [];
  let releaseFirstTurn!: () => void;
  const firstTurnRunning = new Promise<void>((resolve) => {
    releaseFirstTurn = resolve;
  });

  gateway.setMessageCallback(async (message) => {
    started.push(message.content);
    if (message.content === '收到 1') {
      // Message #1's turn is still running when #2 arrives — the real-device
      // state that used to leave #2 queued at the gateway (or rejected).
      await firstTurnRunning;
    }
  });

  await gateway.start({ enabled: true, accountId: 'default' });

  // Both messages reach the handler although the first turn never finished.
  await waitFor(() => started.length === 2);
  assert.deepEqual(started, ['收到 1', '收到 2']);

  // Typing stays ON while any turn of the conversation is running: the second
  // message must not switch it off behind the first one.
  const typingWhileRunning = transport
    .callsTo('ilink/bot/sendtyping')
    .map((call) => (call.body as { status: number }).status);
  assert.deepEqual(typingWhileRunning, [1]);

  releaseFirstTurn();
  await waitFor(() => transport.callsTo('ilink/bot/sendtyping').length === 2);
  assert.deepEqual(
    transport.callsTo('ilink/bot/sendtyping').map((call) => (call.body as { status: number }).status),
    [1, 2]
  );

  await gateway.stop();
});

test('sendText splits a long reply into <=1800 character sendmessage calls', async () => {
  const store = makeStore();
  seedCredentials(store);

  let primerServed = false;
  const transport = new FakeTransport((request) => {
    if (request.path === 'ilink/bot/getupdates') {
      if (!primerServed) {
        primerServed = true;
        return {
          status: 200,
          data: {
            ret: 0,
            msgs: [{
              message_id: 1,
              from_user_id: 'user@im.wechat',
              message_type: 1,
              context_token: 'ctx-1',
              item_list: [{ type: 1, text_item: { text: 'ping' } }],
            }],
          },
        };
      }
      return blockingLongPoll(request);
    }
    if (request.path === 'ilink/bot/getconfig') return { status: 200, data: { ret: 0, typing_ticket: 't' } };
    if (request.path === 'ilink/bot/sendtyping') return { status: 200, data: { ret: 0 } };
    if (request.path === 'ilink/bot/sendmessage') return { status: 200, data: {} };
    throw new Error(`unexpected path ${request.path}`);
  });

  const gateway = makeGateway(transport, store);
  gateway.setMessageCallback(async (_message, replyFn) => {
    await replyFn('x'.repeat(4000));
  });

  await gateway.start({ enabled: true, accountId: 'default' });
  await waitFor(() => transport.callsTo('ilink/bot/sendmessage').length === 3);

  const texts = transport.callsTo('ilink/bot/sendmessage').map(
    (call) => (call.body as { msg: { item_list: Array<{ text_item: { text: string } }>; context_token?: string } })
      .msg.item_list[0].text_item.text
  );
  assert.deepEqual(texts.map((text) => text.length), [1800, 1800, 400]);
  assert.ok(transport.callsTo('ilink/bot/sendmessage').every(
    (call) => (call.body as { msg: { context_token?: string } }).msg.context_token === 'ctx-1'
  ));

  await gateway.stop();
});

test('cancelLogin clears the pending state immediately, without waiting for the long poll', async () => {
  const store = makeStore();
  const transport = new FakeTransport((request) => {
    if (request.path === 'ilink/bot/get_bot_qrcode') {
      return { status: 200, data: { qrcode: 'qr-cancel', qrcode_img_content: 'qr-content', ret: 0 } };
    }
    if (request.path === 'ilink/bot/get_qrcode_status') {
      // Park the poll exactly like the server's 35 s long poll.
      return new Promise<never>((_resolve, reject) => {
        const signal = request.signal;
        if (!signal) {
          reject(new Error('expected an abort signal on the qr status poll'));
          return;
        }
        signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    }
    throw new Error(`unexpected path ${request.path}`);
  });

  const gateway = makeGateway(transport, store);
  await gateway.beginLogin();
  assert.equal(gateway.getStatus().loginPending, true);

  const started = Date.now();
  await gateway.cancelLogin();
  const elapsed = Date.now() - started;

  assert.equal(gateway.getStatus().loginPending, false);
  assert.equal(gateway.getStatus().loginState, 'idle');
  assert.equal(gateway.getStatus().qrContent, null);
  assert.ok(elapsed < 200, `cancelLogin must not wait for the long poll (took ${elapsed}ms)`);

  // The aborted placeholder poll must have carried a signal.
  const qrPolls = transport.callsTo('ilink/bot/get_qrcode_status');
  assert.ok(qrPolls.length >= 1);
  assert.ok(qrPolls.every((call) => Boolean(call.signal)));
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

test('getupdates failures back off on the configured ladder instead of crashing the gateway', async () => {
  const store = makeStore();
  seedCredentials(store);

  const delays: number[] = [];
  const transport = new FakeTransport((request) => {
    if (request.path === 'ilink/bot/getupdates') {
      if (delays.length >= 3) return blockingLongPoll(request);
      throw new Error('ECONNRESET');
    }
    throw new Error(`unexpected path ${request.path}`);
  });

  const gateway = makeGateway(transport, store, {
    pollBackoffMs: [2000, 4000, 10000],
    sleep: async (ms) => {
      delays.push(ms);
    },
  });

  await gateway.start({ enabled: true, accountId: 'default' });
  await waitFor(() => delays.length >= 3);

  assert.deepEqual(delays.slice(0, 3), [2000, 4000, 10000]);
  assert.equal(gateway.getStatus().connected, true);
  assert.match(gateway.getStatus().lastError || '', /ECONNRESET/);

  await gateway.stop();
  assert.equal(gateway.getStatus().connected, false);
});

test('ret=-14 clears the stored token and cursor and stops polling', async () => {
  const store = makeStore();
  seedCredentials(store, 'ilinkbot_expired');

  const transport = new FakeTransport((request) => {
    if (request.path === 'ilink/bot/getupdates') {
      return { status: 200, data: { ret: -14, errcode: -14, errmsg: 'session timeout' } };
    }
    throw new Error(`unexpected path ${request.path}`);
  });

  const gateway = makeGateway(transport, store);
  const disconnected = new Promise<void>((resolve) => gateway.once('disconnected', () => resolve()));

  await gateway.start({ enabled: true, accountId: 'default' });
  await disconnected;

  assert.equal(gateway.getStatus().connected, false);
  assert.match(gateway.getStatus().lastError || '', /session expired/i);
  assert.equal(store.loadCredentials('default'), null);
  assert.equal(store.loadSync('default'), null);
  assert.equal(JSON.stringify(gateway.getStatus()).includes('ilinkbot_expired'), false);
});

test('a local long-poll timeout is treated as an empty poll, not a failure', async () => {
  const store = makeStore();
  seedCredentials(store);

  let polls = 0;
  const transport = new FakeTransport((request) => {
    if (request.path !== 'ilink/bot/getupdates') throw new Error(`unexpected path ${request.path}`);
    polls += 1;
    if (polls <= 2) throw new WeixinRequestTimeoutError(35_000);
    return blockingLongPoll(request);
  });

  const delays: number[] = [];
  const gateway = makeGateway(transport, store, {
    sleep: async (ms) => {
      delays.push(ms);
    },
  });

  await gateway.start({ enabled: true, accountId: 'default' });
  await waitFor(() => polls >= 3);

  assert.equal(delays.length, 0, 'timeouts must not trigger the backoff ladder');
  assert.equal(gateway.getStatus().lastError, null);
  await gateway.stop();
});

test('duplicate message ids from a replayed cursor are answered only once', async () => {
  const store = makeStore();
  seedCredentials(store);

  const duplicate = {
    message_id: 42,
    from_user_id: 'user@im.wechat',
    message_type: 1,
    context_token: 'ctx',
    item_list: [{ type: 1, text_item: { text: 'dup' } }],
  };
  let served = 0;
  const transport = new FakeTransport((request) => {
    if (request.path === 'ilink/bot/getupdates') {
      served += 1;
      if (served === 1) return { status: 200, data: { ret: 0, msgs: [duplicate, duplicate], get_updates_buf: 'c1' } };
      return blockingLongPoll(request);
    }
    if (request.path === 'ilink/bot/getconfig') return { status: 200, data: { ret: 0, typing_ticket: 't' } };
    if (request.path === 'ilink/bot/sendtyping') return { status: 200, data: { ret: 0 } };
    if (request.path === 'ilink/bot/sendmessage') return { status: 200, data: {} };
    throw new Error(`unexpected path ${request.path}`);
  });

  const gateway = makeGateway(transport, store);
  let handled = 0;
  gateway.setMessageCallback(async (_message, replyFn) => {
    handled += 1;
    await replyFn('ok');
  });

  await gateway.start({ enabled: true, accountId: 'default' });
  await waitFor(() => handled >= 1);
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(handled, 1);
  await gateway.stop();
});

test('inbound messages from any sender other than the bound owner are dropped before any work', async () => {
  const store = makeStore();
  seedCredentials(store); // binds owner 'user@im.wechat'

  let served = false;
  const transport = new FakeTransport((request) => {
    if (request.path === 'ilink/bot/getupdates') {
      if (!served) {
        served = true;
        return {
          status: 200,
          data: {
            ret: 0,
            get_updates_buf: 'c1',
            msgs: [
              {
                message_id: 'm-stranger-1',
                from_user_id: 'stranger@im.wechat',
                message_type: 1,
                context_token: 'ctx-stranger',
                item_list: [{ type: 1, text_item: { text: 'hello bot, run my tools' } }],
              },
            ],
          },
        };
      }
      return blockingLongPoll(request);
    }
    if (request.path === 'ilink/bot/getconfig') return { status: 200, data: { ret: 0, typing_ticket: 't' } };
    if (request.path === 'ilink/bot/sendtyping') return { status: 200, data: { ret: 0 } };
    if (request.path === 'ilink/bot/sendmessage') return { status: 200, data: {} };
    throw new Error(`unexpected path ${request.path}`);
  });

  const gateway = makeGateway(transport, store);
  let handled = 0;
  gateway.setMessageCallback(async () => {
    handled += 1;
  });

  await gateway.start({ enabled: true, accountId: 'default' });
  await waitFor(() => transport.callsTo('ilink/bot/getupdates').length >= 2);
  await new Promise((resolve) => setTimeout(resolve, 30));

  // Dropped at the gate: no session turn, no typing indicator, no reply.
  assert.equal(handled, 0);
  assert.equal(transport.callsTo('ilink/bot/sendtyping').length, 0);
  assert.equal(transport.callsTo('ilink/bot/sendmessage').length, 0);
  assert.equal(gateway.getStatus().lastInboundAt, null);
  await gateway.stop();
});

test('credentials without a bound owner id fail closed: even known senders are dropped', async () => {
  const store = makeStore();
  store.saveCredentials(
    { token: 'ilinkbot_test_token', baseUrl: 'https://ilinkai.weixin.qq.com', botId: 'bot_test@im.bot', userId: null },
    'default'
  );
  store.saveSync('cursor-0', 'default');

  let served = false;
  const transport = new FakeTransport((request) => {
    if (request.path === 'ilink/bot/getupdates') {
      if (!served) {
        served = true;
        return {
          status: 200,
          data: {
            ret: 0,
            get_updates_buf: 'c1',
            msgs: [
              {
                message_id: 'm-noowner-1',
                from_user_id: 'user@im.wechat',
                message_type: 1,
                context_token: 'ctx-noowner',
                item_list: [{ type: 1, text_item: { text: 'ping' } }],
              },
            ],
          },
        };
      }
      return blockingLongPoll(request);
    }
    if (request.path === 'ilink/bot/getconfig') return { status: 200, data: { ret: 0, typing_ticket: 't' } };
    if (request.path === 'ilink/bot/sendtyping') return { status: 200, data: { ret: 0 } };
    if (request.path === 'ilink/bot/sendmessage') return { status: 200, data: {} };
    throw new Error(`unexpected path ${request.path}`);
  });

  const gateway = makeGateway(transport, store);
  let handled = 0;
  gateway.setMessageCallback(async () => {
    handled += 1;
  });

  await gateway.start({ enabled: true, accountId: 'default' });
  await waitFor(() => transport.callsTo('ilink/bot/getupdates').length >= 2);
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(handled, 0);
  assert.equal(transport.callsTo('ilink/bot/sendtyping').length, 0);
  assert.equal(transport.callsTo('ilink/bot/sendmessage').length, 0);
  await gateway.stop();
});

// ---------------------------------------------------------------------------
// Raw inbound debug log (IDBOTS_WEIXIN_RAW_LOG=1) + STEP-2 quote prefix contract
// ---------------------------------------------------------------------------

/** Capture console.log for the duration of one async block. */
async function captureConsoleLog<T>(run: () => Promise<T>): Promise<{ result: T; logs: string[] }> {
  const original = console.log;
  const logs: string[] = [];
  console.log = (...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '));
  };
  try {
    return { result: await run(), logs };
  } finally {
    console.log = original;
  }
}

async function withEnv<T>(name: string, value: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

/** getupdates serving exactly one message, then blocking. */
function oneMessageTransport(message: Record<string, unknown>): FakeTransport {
  let polls = 0;
  return new FakeTransport((request) => {
    if (request.path === 'ilink/bot/getupdates') {
      polls += 1;
      if (polls === 1) {
        return { status: 200, data: { ret: 0, msgs: [message], get_updates_buf: 'cursor-1' } };
      }
      return blockingLongPoll(request);
    }
    if (request.path === 'ilink/bot/getconfig') return { status: 200, data: { ret: 0, typing_ticket: 't' } };
    if (request.path === 'ilink/bot/sendtyping') return { status: 200, data: { ret: 0 } };
    if (request.path === 'ilink/bot/sendmessage') return { status: 200, data: {} };
    throw new Error(`unexpected path ${request.path}`);
  });
}

const RAW_LOG_PREFIX = '[Weixin Raw Inbound]';

test('raw inbound log line carries ids, timestamps, key skeleton and redacts secrets', () => {
  const line = formatWeixinRawInboundLogLine({
    message_id: 9812451782375,
    from_user_id: 'user@im.wechat',
    message_type: 1,
    create_time_ms: 1_774_158_905_123,
    context_token: 'CONTEXT_TOKEN_MUST_NOT_APPEAR',
    item_list: [
      {
        type: 1,
        msg_id: 'v1:2094126644801196353',
        ref_msg: { message_item: { type: 0, msg_id: '7523486488309966856' } },
        text_item: { text: '引用测试正文' },
      },
      {
        type: 2,
        image_item: {
          aes_key: 'SUPER_SECRET_AES',
          encrypt_query_param: 'SECRET_QUERY_PARAM',
          url: 'https://cdn.example/download?encrypted_query_param=SECRET_IN_URL&x=1',
        },
      },
    ],
  } as Parameters<typeof formatWeixinRawInboundLogLine>[0], 1_700_000_000_456);

  assert.ok(line.startsWith(`${RAW_LOG_PREFIX} `), 'line must carry a stable grep prefix');
  assert.ok(!line.includes('\n'), 'the debug record must stay on ONE line');
  assert.ok(line.includes('message_id="9812451782375"'));
  assert.ok(line.includes('create_time_ms=1774158905123'));
  assert.ok(line.includes('logged_at="2023-11-14T22:13:20.456Z"'));
  assert.ok(line.includes('item_count=2'));
  assert.ok(line.includes('truncated=false'));
  // The key skeleton proves which fields arrived even if the value dump is cut.
  assert.ok(line.includes('ref_msg.message_item.msg_id'), 'the real quote field must survive in item_keys');
  assert.ok(line.includes('v1:2094126644801196353'));
  // Message-level fields are also listed as NAMES (a quote field could live
  // outside item_list); their values are never dumped.
  assert.ok(line.includes('message_keys='));
  assert.ok(line.includes('"context_token"'));
  assert.ok(line.includes('"item_list"'));
  assert.ok(line.includes('"text":"引用测试正文"'), 'text body is kept (debug payload)');

  // Never leak the context token or credential values.
  assert.ok(!line.includes('CONTEXT_TOKEN_MUST_NOT_APPEAR'));
  assert.ok(!line.includes('SUPER_SECRET_AES'));
  assert.ok(!line.includes('SECRET_QUERY_PARAM'));
  assert.ok(!line.includes('SECRET_IN_URL'));
  assert.ok(line.includes('[REDACTED]'));
});

test('raw inbound log line caps item_list at 2000 characters and flags the cut', () => {
  const longText = 'x'.repeat(5_000);
  const line = formatWeixinRawInboundLogLine(
    { message_id: 9, item_list: [{ type: 1, text_item: { text: longText } }] },
    1
  );

  assert.ok(line.includes('truncated=true'));
  assert.ok(line.includes('…[truncated:'));
  assert.ok(!line.includes('x'.repeat(WEIXIN_RAW_LOG_ITEM_LIST_MAX_CHARS + 1)));
  const payload = line.slice(line.indexOf('item_list=') + 'item_list='.length);
  assert.ok(payload.length <= WEIXIN_RAW_LOG_ITEM_LIST_MAX_CHARS + 40, `payload=${payload.length}`);
});

test('raw inbound log switch is exactly IDBOTS_WEIXIN_RAW_LOG=1', () => {
  assert.equal(WEIXIN_RAW_LOG_ENV_VAR, 'IDBOTS_WEIXIN_RAW_LOG');
  assert.equal(isWeixinRawLogEnabled({ IDBOTS_WEIXIN_RAW_LOG: '1' }), true);
  assert.equal(isWeixinRawLogEnabled({ IDBOTS_WEIXIN_RAW_LOG: '0' }), false);
  assert.equal(isWeixinRawLogEnabled({ IDBOTS_WEIXIN_RAW_LOG: 'true' }), false);
  assert.equal(isWeixinRawLogEnabled({}), false);
});

test('IDBOTS_WEIXIN_RAW_LOG=1 logs each inbound item_list once and leaves delivery untouched', async () => {
  const store = makeStore();
  seedCredentials(store);
  const transport = oneMessageTransport({
    message_id: 9812451782375,
    from_user_id: 'user@im.wechat',
    message_type: 1,
    create_time_ms: 1_774_158_905_123,
    context_token: 'ctx-must-not-be-logged',
    item_list: [{ type: 1, text_item: { text: '你好，引用一条旧消息' }, quote_probe: { title: '旧消息原文' } }],
  });
  const emitted: string[] = [];

  await withEnv(WEIXIN_RAW_LOG_ENV_VAR, '1', async () => {
    const { logs } = await captureConsoleLog(async () => {
      const gateway = makeGateway(transport, store);
      gateway.on('message', (message) => emitted.push(message.content));
      await gateway.start({ enabled: true, accountId: 'default' });
      await waitFor(() => emitted.length === 1);
      await gateway.stop();
    });

    const rawLines = logs.filter((line) => line.startsWith(RAW_LOG_PREFIX));
    assert.equal(rawLines.length, 1, `expected exactly one raw dump, got ${rawLines.length}`);
    assert.ok(rawLines[0].includes('message_id="9812451782375"'));
    assert.ok(rawLines[0].includes('quote_probe.title'));
    assert.ok(rawLines[0].includes('旧消息原文'));
    assert.ok(!rawLines[0].includes('ctx-must-not-be-logged'));
  });

  // The debug switch must not change what the handler receives.
  assert.deepEqual(emitted, ['你好，引用一条旧消息']);
});

test('the raw inbound log stays silent when the switch is absent', async () => {
  const store = makeStore();
  seedCredentials(store);
  const transport = oneMessageTransport({
    message_id: 'm-silent',
    from_user_id: 'user@im.wechat',
    message_type: 1,
    item_list: [{ type: 1, text_item: { text: '静默' } }],
  });
  const emitted: string[] = [];

  await withEnv(WEIXIN_RAW_LOG_ENV_VAR, undefined, async () => {
    const { logs } = await captureConsoleLog(async () => {
      const gateway = makeGateway(transport, store);
      gateway.on('message', (message) => emitted.push(message.content));
      await gateway.start({ enabled: true, accountId: 'default' });
      await waitFor(() => emitted.length === 1);
      await gateway.stop();
    });
    assert.equal(logs.filter((line) => line.startsWith(RAW_LOG_PREFIX)).length, 0);
  });

  assert.deepEqual(emitted, ['静默']);
});

// STEP 2: the real capture (2026-11-04) proved the platform returns ONLY an id
// (`item.ref_msg.message_item.msg_id`) — no text, no sender. The prefix is built
// from a LOCAL lookup; when no record matches, the honest sentence is used.
test('quote prefix: text is summarized to 120 chars, media is labelled by type only', () => {
  assert.equal(formatWeixinQuotePrefix({ text: '原话内容' }), '（引用：原话内容）');
  // Whitespace is collapsed so the prefix stays one line.
  assert.equal(formatWeixinQuotePrefix({ text: ' 多\n行\t文本 ' }), '（引用：多 行 文本）');
  assert.equal(formatWeixinQuotePrefix({ kind: 'image' }), '（引用了一张图片）');
  assert.equal(formatWeixinQuotePrefix({ kind: 'file' }), '（引用了一个文件）');
  assert.equal(formatWeixinQuotePrefix({ kind: 'voice' }), '（引用了一条语音）');
  assert.equal(formatWeixinQuotePrefix({ kind: 'video' }), '（引用了一段视频）');
  // A media quote is labelled by type only — no caption is quoted as text.
  assert.equal(formatWeixinQuotePrefix({ kind: 'voice', text: '字幕' }), '（引用了一条语音）');
  const long = formatWeixinQuotePrefix({ text: '甲'.repeat(300) });
  assert.equal(long, `（引用：${'甲'.repeat(WEIXIN_QUOTE_TEXT_MAX_CHARS)}…）`);
  // Truncation counts code points: 120 whole emoji, never a split surrogate.
  const emojiQuote = formatWeixinQuotePrefix({ text: '😀'.repeat(130) }) ?? '';
  assert.equal(emojiQuote.match(/😀/gu)?.length, WEIXIN_QUOTE_TEXT_MAX_CHARS);
  // Nothing usable -> no prefix at all.
  assert.equal(formatWeixinQuotePrefix(null), null);
  assert.equal(formatWeixinQuotePrefix({}), null);
  assert.equal(WEIXIN_QUOTE_TEXT_MAX_CHARS, 120);
  assert.equal(WEIXIN_QUOTE_UNRESOLVED_PREFIX, '（引用了一条此前的消息）');
});

test('readWeixinQuoteRef reads ref_msg.message_item.msg_id and ignores malformed refs', () => {
  assert.deepEqual(
    readWeixinQuoteRef([{
      type: 1,
      create_time_ms: 1793738982833,
      msg_id: 'v1:2094126644801196353',
      ref_msg: {
        message_item: {
          type: 0,
          create_time_ms: 1793738959000,
          update_time_ms: 1793738959000,
          is_completed: true,
          msg_id: '7523486488309966856',
          button_item_list: [],
          at_bot_username_list: [],
        },
      },
      text_item: { text: '测试引用' },
    }]),
    { msgId: '7523486488309966856' }
  );
  // Tolerant: numeric ids are accepted, empty/missing ones are ignored.
  assert.deepEqual(readWeixinQuoteRef([{ ref_msg: { message_item: { msg_id: 42 } } }]), { msgId: '42' });
  assert.equal(readWeixinQuoteRef([{ type: 1, text_item: { text: 'x' } }]), null);
  assert.equal(readWeixinQuoteRef([{ ref_msg: { message_item: {} } }]), null);
  assert.equal(readWeixinQuoteRef([{ ref_msg: null }]), null);
  assert.equal(readWeixinQuoteRef(undefined), null);
});

/** The exact payload shape captured on 2026-11-04 (text reply to a quote). */
const REAL_QUOTE_RAW = {
  message_id: 'm-quote-real-1',
  from_user_id: 'user@im.wechat',
  message_type: 1,
  create_time_ms: 1793738982833,
  item_list: [{
    type: 1,
    create_time_ms: 1793738982833,
    msg_id: 'v1:2094126644801196353',
    ref_msg: {
      message_item: {
        type: 0,
        create_time_ms: 1793738959000,
        update_time_ms: 1793738959000,
        is_completed: true,
        msg_id: '7523486488309966856',
        button_item_list: [],
        at_bot_username_list: [],
      },
    },
    text_item: { text: '测试引用' },
  }],
};

test('toIMMessage prefixes a resolved quote with its local summary', () => {
  const message = toIMMessage(REAL_QUOTE_RAW, 1, {}, {
    resolveQuote: (msgId) => (
      msgId === '7523486488309966856' ? { text: '被引用的原话' } : null
    ),
  });
  assert.equal(message?.content, '（引用：被引用的原话）测试引用');
});

test('toIMMessage never invents quote content when no local record matches', () => {
  // Production passes no resolver today (no item-id ledger), and a resolver may
  // also return null for an evicted/unknown id: both use the honest sentence.
  assert.equal(toIMMessage(REAL_QUOTE_RAW, 1)?.content, '（引用了一条此前的消息）测试引用');
  assert.equal(
    toIMMessage(REAL_QUOTE_RAW, 1, {}, { resolveQuote: () => null })?.content,
    '（引用了一条此前的消息）测试引用'
  );
  assert.equal(
    toIMMessage(REAL_QUOTE_RAW, 1, {}, { resolveQuote: () => { throw new Error('db down'); } })?.content,
    '（引用了一条此前的消息）测试引用'
  );
});

test('toIMMessage leaves the body untouched when the item has no ref_msg', () => {
  const message = toIMMessage({
    ...REAL_QUOTE_RAW,
    item_list: [{ type: 1, text_item: { text: '测试引用' } }],
  }, 1);
  assert.equal(message?.content, '测试引用');
});

test('toIMMessage labels a resolved media quote by type without downloading it', () => {
  const message = toIMMessage(REAL_QUOTE_RAW, 1, {}, { resolveQuote: () => ({ kind: 'image' }) });
  assert.equal(message?.content, '（引用了一张图片）测试引用');
  // The quoted media is never fetched/attached; only the reply's own media would be.
  assert.equal(message?.attachments, undefined);
});

test('the gateway emits the quote prefix end-to-end (honest fallback today)', async () => {
  const store = makeStore();
  seedCredentials(store);
  const transport = oneMessageTransport(REAL_QUOTE_RAW as unknown as Record<string, unknown>);
  const emitted: string[] = [];

  const gateway = makeGateway(transport, store);
  gateway.on('message', (message) => emitted.push(message.content));
  await gateway.start({ enabled: true, accountId: 'default' });
  await waitFor(() => emitted.length === 1);
  await gateway.stop();

  assert.deepEqual(emitted, ['（引用了一条此前的消息）测试引用']);
});
