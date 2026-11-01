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
  parseQrStatusResponse,
  parseUpdatesResponse,
  splitWeixinText,
  toIMMessage,
  WeixinSessionExpiredError,
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
                from_user_id: 'o9cq800kum@im.wechat',
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
      assert.equal(request.body?.ilink_user_id, 'o9cq800kum@im.wechat');
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
    conversationId: 'o9cq800kum@im.wechat',
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
  assert.equal(payload.msg.to_user_id, 'o9cq800kum@im.wechat');
  assert.equal(payload.msg.message_type, 2);
  assert.equal(payload.msg.message_state, 2);
  assert.equal(payload.msg.context_token, 'AARzJWA-context');
  assert.deepEqual(payload.msg.item_list, [{ type: 1, text_item: { text: '我是半糖浆的网关测试回复。' } }]);
  assert.equal(payload.base_info.channel_version, '1.0.0');

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
