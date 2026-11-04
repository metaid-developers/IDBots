/**
 * Weixin quote ledger tests.
 *
 * Covers the four behaviours the feature promises:
 *   1. an outbound `sendmessage` id is stored and a later quote resolves it
 *   2. an inbound message id is stored and a quote of it resolves
 *   3. retention: newest N per conversation, plus a TTL sweep
 *   4. degradation: a broken ledger (write OR read) keeps delivering messages
 *      and falls back to the honest sentence — never throws
 *
 * Everything runs offline against a fake transport / in-memory SQLite.
 *
 * Run: npx tsx --test tests/weixinLedger.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'node:module';

import { WeixinGateway } from '../src/main/im/weixinGateway';
import { WeixinStore } from '../src/main/im/weixinStore';
import { IMStore } from '../src/main/im/imStore';
import { NativeSqliteDatabase } from '../src/main/nativeSqliteDatabase';
import {
  parseSendMessageResponse,
  WEIXIN_QUOTE_UNRESOLVED_PREFIX,
} from '../src/main/im/weixinProtocol';
import { parseWeixinJsonBody } from '../src/main/im/weixinTransport';
import {
  buildWeixinLedgerEntry,
  isWeixinLedgerEnabledByEnv,
  normalizeWeixinLedgerId,
  WEIXIN_LEDGER_ENV_VAR,
  WEIXIN_LEDGER_MAX_ROWS_PER_CONVERSATION,
  WEIXIN_LEDGER_TEXT_MAX_CHARS,
  WEIXIN_LEDGER_TTL_MS,
  type WeixinLedgerEntry,
  type WeixinMessageLedger,
} from '../src/main/im/weixinLedger';
import type {
  WeixinHttpRequest,
  WeixinHttpResponse,
  WeixinTransport,
} from '../src/main/im/weixinTransport';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);
const OWNER = 'user@im.wechat';
/** Real capture (2026-11-04): a `sendmessage` response carries this id. */
const OUTBOUND_ID = '7523489994131519368';
/** Real capture: the id a quote of an earlier message carries. */
const INBOUND_ID = '7523486488309966856';

class FakeTransport implements WeixinTransport {
  readonly calls: WeixinHttpRequest[] = [];
  private handler: (request: WeixinHttpRequest) => Promise<WeixinHttpResponse> | WeixinHttpResponse;

  constructor(handler: (request: WeixinHttpRequest) => Promise<WeixinHttpResponse> | WeixinHttpResponse) {
    this.handler = handler;
  }

  async request(request: WeixinHttpRequest): Promise<WeixinHttpResponse> {
    this.calls.push(request);
    return this.handler(request);
  }

  callsTo(pathName: string): WeixinHttpRequest[] {
    return this.calls.filter((call) => call.path === pathName);
  }
}

class MemoryLedger implements WeixinMessageLedger {
  readonly rows = new Map<string, WeixinLedgerEntry>();

  put(entry: WeixinLedgerEntry): void {
    this.rows.set(entry.msgId, entry);
  }

  get(msgId: string): WeixinLedgerEntry | null {
    return this.rows.get(msgId) ?? null;
  }
}

/** Every operation fails — the state a locked/corrupt database would produce. */
class BrokenLedger implements WeixinMessageLedger {
  put(): void {
    throw new Error('ledger write exploded');
  }

  get(): WeixinLedgerEntry | null {
    throw new Error('ledger read exploded');
  }
}

/** Unique state dir per test; intentionally never deleted (task policy: no deletions). */
function makeStore(): WeixinStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'idbots-weixin-ledger-'));
  return new WeixinStore(dir);
}

function seedCredentials(store: WeixinStore): void {
  store.saveCredentials(
    {
      token: 'ilinkbot_ledger_test_token',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      botId: 'bot@im.bot',
      userId: OWNER,
    },
    'default'
  );
  store.saveSync('cursor-0', 'default');
}

function makeGateway(
  transport: FakeTransport,
  store: WeixinStore,
  extra: { messageLedger?: WeixinMessageLedger; messageLedgerEnabled?: boolean } = {}
): WeixinGateway {
  let tick = 1_700_000_000_000;
  return new WeixinGateway({
    transport,
    store,
    now: () => ++tick,
    sleep: async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    pollBackoffMs: [1, 1],
    pollTimeoutMs: 50,
    ...extra,
  });
}

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

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Serve ONE getupdates batch (all messages in order), then block forever.
 *
 * Since the 2026-11-04 steering change the gateway orders PREPARATION and
 * DISPATCH, but never waits for a turn: a message that arrives while a turn is
 * running is steered into it. Use `replyThenQuoteTransport` below when the
 * test needs "the reply is on the wire before the next message is parsed".
 */
function batchTransport(messages: Array<Record<string, unknown>>, messageId: string): FakeTransport {
  let served = false;
  return new FakeTransport((request) => {
    if (request.path === 'ilink/bot/getupdates') {
      if (!served) {
        served = true;
        return {
          status: 200,
          data: { ret: 0, msgs: messages, get_updates_buf: 'cursor-1' },
        };
      }
      return blockingLongPoll(request);
    }
    if (request.path === 'ilink/bot/getconfig') return { status: 200, data: { ret: 0, typing_ticket: 't' } };
    if (request.path === 'ilink/bot/sendtyping') return { status: 200, data: { ret: 0 } };
    if (request.path === 'ilink/bot/sendmessage') return { status: 200, data: { ret: 0, message_id: messageId } };
    throw new Error(`unexpected path ${request.path}`);
  });
}

/**
 * Serve one inbound batch, then hold the next batch until the bot's reply has
 * actually been sent.
 *
 * Since the 2026-11-04 steering change the gateway dispatches inbound messages
 * concurrently (a second message is steered INTO the running turn instead of
 * waiting for it), so a quote can only resolve once the quoted reply is on the
 * wire. That is also the only order a real user can produce: they quote a
 * message they can already see.
 */
function replyThenQuoteTransport(
  firstBatch: Array<Record<string, unknown>>,
  secondBatch: Array<Record<string, unknown>>,
  messageId: string,
): FakeTransport {
  let phase = 0;
  const transport: FakeTransport = new FakeTransport(async (request) => {
    if (request.path === 'ilink/bot/getupdates') {
      if (phase === 0) {
        phase = 1;
        return {
          status: 200,
          data: { ret: 0, msgs: firstBatch, get_updates_buf: 'cursor-1' },
        };
      }
      if (phase === 1) {
        const deadline = Date.now() + 4000;
        while (transport.callsTo('ilink/bot/sendmessage').length === 0) {
          if (Date.now() > deadline) return blockingLongPoll(request);
          await new Promise((resolve) => setTimeout(resolve, 2));
        }
        phase = 2;
        return {
          status: 200,
          data: { ret: 0, msgs: secondBatch, get_updates_buf: 'cursor-2' },
        };
      }
      return blockingLongPoll(request);
    }
    if (request.path === 'ilink/bot/getconfig') return { status: 200, data: { ret: 0, typing_ticket: 't' } };
    if (request.path === 'ilink/bot/sendtyping') return { status: 200, data: { ret: 0 } };
    if (request.path === 'ilink/bot/sendmessage') return { status: 200, data: { ret: 0, message_id: messageId } };
    throw new Error(`unexpected path ${request.path}`);
  });
  return transport;
}

function textMessage(id: string, text: string, quotedId?: string): Record<string, unknown> {
  const item: Record<string, unknown> = {
    type: 1,
    msg_id: `v1:${id}`,
    text_item: { text },
  };
  if (quotedId) {
    item.ref_msg = { message_item: { type: 0, msg_id: quotedId } };
  }
  return {
    message_id: id,
    from_user_id: OWNER,
    message_type: 1,
    context_token: 'ctx-1',
    create_time_ms: 1_793_738_900_000,
    item_list: [item],
  };
}

/** Capture console.warn for the duration of one async block. */
async function captureConsoleWarn<T>(run: () => Promise<T>): Promise<{ result: T; warns: string[] }> {
  const original = console.warn;
  const warns: string[] = [];
  console.warn = (...args: unknown[]) => {
    warns.push(args.map((arg) => String(arg)).join(' '));
  };
  try {
    return { result: await run(), warns };
  } finally {
    console.warn = original;
  }
}

// ---------------------------------------------------------------------------
// 1. Outbound — the sendmessage id becomes quotable
// ---------------------------------------------------------------------------

test('outbound: a sendmessage id is stored and quoting it resolves the reply text', async () => {
  const store = makeStore();
  seedCredentials(store);
  const ledger = new MemoryLedger();
  const transport = replyThenQuoteTransport(
    [textMessage(INBOUND_ID, 'ping')],
    // The quote arrives once the reply it refers to is on the wire.
    [textMessage('7523486488309966857', '引用一下', OUTBOUND_ID)],
    OUTBOUND_ID
  );

  const gateway = makeGateway(transport, store, { messageLedger: ledger });
  const emitted: string[] = [];
  gateway.on('message', (message) => emitted.push(message.content));
  let handled = 0;
  gateway.setMessageCallback(async (_message, replyFn) => {
    handled += 1;
    if (handled === 1) await replyFn('这是机器人的回复');
  });

  await gateway.start({ enabled: true, accountId: 'default' });
  try {
    await waitFor(() => emitted.length === 2);
  } finally {
    await gateway.stop();
  }

  const row = ledger.get(OUTBOUND_ID);
  assert.ok(row, 'the sendmessage id must be in the ledger');
  assert.equal(row?.direction, 'out');
  assert.equal(row?.kind, 'text');
  assert.equal(row?.text, '这是机器人的回复');
  assert.equal(row?.conversationId, OWNER);

  assert.deepEqual(emitted, ['ping', '（引用：这是机器人的回复）引用一下']);
});

test('outbound: a polled sendmessage response that only has a number id is refused, not rounded', async () => {
  // A caller that bypassed the transport fix (pre-parsed body) hands us a
  // number that was already rounded: storing it would make every quote miss.
  const parsed = parseSendMessageResponse({ ret: 0, message_id: 7523489994131520000 });
  assert.deepEqual(parsed, { messageId: null, rejection: 'unsafe-number' });
});

// ---------------------------------------------------------------------------
// 2. Inbound — user messages are quotable too
// ---------------------------------------------------------------------------

test('inbound: a message id is stored and quoting it resolves the original text', async () => {
  const store = makeStore();
  seedCredentials(store);
  const ledger = new MemoryLedger();
  const transport = batchTransport(
    [
      textMessage(INBOUND_ID, '第一句原话'),
      textMessage('7523486488309966858', '第二句', INBOUND_ID),
    ],
    OUTBOUND_ID
  );

  const gateway = makeGateway(transport, store, { messageLedger: ledger });
  const emitted: string[] = [];
  gateway.on('message', (message) => emitted.push(message.content));

  await gateway.start({ enabled: true, accountId: 'default' });
  try {
    await waitFor(() => emitted.length === 2);
  } finally {
    await gateway.stop();
  }

  const row = ledger.get(INBOUND_ID);
  assert.ok(row, 'the inbound message id must be in the ledger');
  assert.equal(row?.direction, 'in');
  assert.equal(row?.kind, 'text');
  assert.equal(row?.text, '第一句原话');

  assert.deepEqual(emitted, ['第一句原话', '（引用：第一句原话）第二句']);
});

test('inbound: quoting a media message is labelled by type without downloading it', async () => {
  const store = makeStore();
  seedCredentials(store);
  const ledger = new MemoryLedger();
  const imageMessage = {
    message_id: '7523486488309966859',
    from_user_id: OWNER,
    message_type: 1,
    item_list: [{ type: 2 }],
  };
  const transport = batchTransport(
    [imageMessage, textMessage('7523486488309966860', '这张图', '7523486488309966859')],
    OUTBOUND_ID
  );

  const gateway = makeGateway(transport, store, { messageLedger: ledger });
  const emitted: string[] = [];
  gateway.on('message', (message) => emitted.push(message.content));

  await gateway.start({ enabled: true, accountId: 'default' });
  try {
    await waitFor(() => emitted.length === 2);
  } finally {
    await gateway.stop();
  }

  assert.equal(ledger.get('7523486488309966859')?.kind, 'image');
  assert.equal(emitted[1], '（引用了一张图片）这张图');
});

test('inbound: the stored body is the message own text, never the quote prefix', async () => {
  const store = makeStore();
  seedCredentials(store);
  const ledger = new MemoryLedger();
  const transport = batchTransport(
    [
      textMessage(INBOUND_ID, '原话'),
      // This one is itself a reply — its OWN text must be stored verbatim.
      textMessage('7523486488309966861', '转述', INBOUND_ID),
    ],
    OUTBOUND_ID
  );

  const gateway = makeGateway(transport, store, { messageLedger: ledger });
  await gateway.start({ enabled: true, accountId: 'default' });
  try {
    await waitFor(() => ledger.get('7523486488309966861') !== null);
  } finally {
    await gateway.stop();
  }

  assert.equal(ledger.get('7523486488309966861')?.text, '转述');
});

// ---------------------------------------------------------------------------
// 3. Retention — cap per conversation + TTL
// ---------------------------------------------------------------------------

function makeInMemoryIMStore(): { store: IMStore; db: NativeSqliteDatabase } {
  const sqlite = require('node:sqlite');
  const db = new NativeSqliteDatabase(':memory:', sqlite);
  const store = new IMStore(db, () => {});
  return { store, db };
}

test('retention: the newest N rows per conversation survive, older ones are evicted', () => {
  const { store, db } = makeInMemoryIMStore();
  const base = 1_700_000_000_000;
  const conversation = OWNER;
  const total = WEIXIN_LEDGER_MAX_ROWS_PER_CONVERSATION + 5;

  for (let index = 0; index < total; index += 1) {
    store.putWeixinLedgerEntry({
      msgId: `m-${index}`,
      conversationId: conversation,
      direction: 'out',
      kind: 'text',
      text: `第${index}条`,
      createdAt: base + index,
    });
  }

  assert.equal(store.countWeixinLedgerEntries(conversation), WEIXIN_LEDGER_MAX_ROWS_PER_CONVERSATION);
  assert.equal(store.getWeixinLedgerEntry('m-0'), null, 'the 5 oldest rows must be gone');
  assert.equal(store.getWeixinLedgerEntry('m-4'), null);
  assert.equal(store.getWeixinLedgerEntry('m-5')?.text, '第5条');
  assert.equal(store.getWeixinLedgerEntry(`m-${total - 1}`)?.text, `第${total - 1}条`);

  // The cap is per conversation: a second conversation keeps its own rows.
  store.putWeixinLedgerEntry({
    msgId: 'other-1',
    conversationId: 'another@im.wechat',
    direction: 'in',
    kind: 'text',
    text: '别的会话',
    createdAt: base + 1_000,
  });
  assert.equal(store.countWeixinLedgerEntries('another@im.wechat'), 1);
  assert.equal(store.countWeixinLedgerEntries(), WEIXIN_LEDGER_MAX_ROWS_PER_CONVERSATION + 1);

  // The (msg_id) primary key and the created_at index are real, not implied.
  const indexColumns = db
    .exec('PRAGMA index_info(idx_im_weixin_message_ledger_created_at)')
    .flatMap((result) => result.values.map((row) => String(row[2])));
  assert.deepEqual(indexColumns, ['created_at']);
  db.close();
});

test('retention: rows older than the TTL are swept on the next write', () => {
  const { store, db } = makeInMemoryIMStore();
  const now = 1_700_000_000_000;
  const conversation = OWNER;

  store.putWeixinLedgerEntry({
    msgId: 'stale',
    conversationId: conversation,
    direction: 'in',
    kind: 'text',
    text: '八天前',
    createdAt: now - WEIXIN_LEDGER_TTL_MS - 60_000,
  });
  assert.ok(store.getWeixinLedgerEntry('stale'), 'a row is not swept by its own insert');

  store.putWeixinLedgerEntry({
    msgId: 'fresh',
    conversationId: conversation,
    direction: 'in',
    kind: 'text',
    text: '刚刚',
    createdAt: now,
  });

  assert.equal(store.getWeixinLedgerEntry('stale'), null, 'the expired row must be gone');
  assert.equal(store.getWeixinLedgerEntry('fresh')?.text, '刚刚');
  db.close();
});

// ---------------------------------------------------------------------------
// 4. Degradation — a broken or disabled ledger never costs a message
// ---------------------------------------------------------------------------

test('degradation: a ledger write failure is logged and the message still goes out', async () => {
  const store = makeStore();
  seedCredentials(store);
  const ledger = new BrokenLedger();
  const transport = batchTransport(
    [textMessage(INBOUND_ID, 'ping'), textMessage('7523486488309966862', '再引用', OUTBOUND_ID)],
    OUTBOUND_ID
  );
  const gateway = makeGateway(transport, store, { messageLedger: ledger });
  const emitted: string[] = [];
  gateway.on('message', (message) => emitted.push(message.content));
  gateway.setMessageCallback(async (_message, replyFn) => {
    await replyFn('回复照发');
  });

  const { warns } = await captureConsoleWarn(async () => {
    await gateway.start({ enabled: true, accountId: 'default' });
    try {
      await waitFor(() => emitted.length === 2);
    } finally {
      await gateway.stop();
    }
  });

  // The reply was really sent — one text sendmessage call for the callback.
  assert.ok(transport.callsTo('ilink/bot/sendmessage').length >= 1);
  assert.ok(
    warns.some((line) => line.includes('message ledger write failed')),
    `expected a write-failure warning, got: ${warns.join(' | ')}`
  );
  // And the quote honestly falls back instead of inventing content.
  assert.equal(emitted[1], `${WEIXIN_QUOTE_UNRESOLVED_PREFIX}再引用`);
});

test('degradation: a ledger read failure falls back to the honest sentence', async () => {
  const store = makeStore();
  seedCredentials(store);
  const transport = batchTransport(
    [textMessage('7523486488309966863', '引用坏台账', INBOUND_ID)],
    OUTBOUND_ID
  );
  const gateway = makeGateway(transport, store, { messageLedger: new BrokenLedger() });
  const emitted: string[] = [];
  gateway.on('message', (message) => emitted.push(message.content));

  const { warns } = await captureConsoleWarn(async () => {
    await gateway.start({ enabled: true, accountId: 'default' });
    try {
      await waitFor(() => emitted.length === 1);
    } finally {
      await gateway.stop();
    }
  });

  assert.equal(emitted[0], `${WEIXIN_QUOTE_UNRESOLVED_PREFIX}引用坏台账`);
  assert.ok(
    warns.some((line) => line.includes('message ledger read failed')),
    `expected a read-failure warning, got: ${warns.join(' | ')}`
  );
});

test('degradation: messageLedgerEnabled=false disables both writes and lookups', async () => {
  const store = makeStore();
  seedCredentials(store);
  const ledger = new MemoryLedger();
  ledger.put({
    msgId: INBOUND_ID,
    conversationId: OWNER,
    direction: 'in',
    kind: 'text',
    text: '台账里有这句',
    createdAt: 1_700_000_000_000,
  });
  const transport = batchTransport(
    [textMessage(INBOUND_ID, '原话'), textMessage('7523486488309966864', '引用', INBOUND_ID)],
    OUTBOUND_ID
  );
  const gateway = makeGateway(transport, store, {
    messageLedger: ledger,
    messageLedgerEnabled: false,
  });
  const emitted: string[] = [];
  gateway.on('message', (message) => emitted.push(message.content));
  gateway.setMessageCallback(async (_message, replyFn) => {
    await replyFn('回复');
  });

  await gateway.start({ enabled: true, accountId: 'default' });
  try {
    await waitFor(() => emitted.length === 2);
  } finally {
    await gateway.stop();
  }

  // Off means OFF: the seeded row is not read, and no outbound row was written.
  assert.equal(emitted[1], `${WEIXIN_QUOTE_UNRESOLVED_PREFIX}引用`);
  assert.equal(ledger.rows.size, 1, 'no write may happen while the ledger is off');
});

test('degradation: IDBOTS_WEIXIN_LEDGER=0 is a runtime off-switch', async () => {
  assert.equal(WEIXIN_LEDGER_ENV_VAR, 'IDBOTS_WEIXIN_LEDGER');
  assert.equal(isWeixinLedgerEnabledByEnv({}), true);
  assert.equal(isWeixinLedgerEnabledByEnv({ [WEIXIN_LEDGER_ENV_VAR]: '1' }), true);
  assert.equal(isWeixinLedgerEnabledByEnv({ [WEIXIN_LEDGER_ENV_VAR]: '0' }), false);

  const store = makeStore();
  seedCredentials(store);
  const ledger = new MemoryLedger();
  ledger.put({
    msgId: INBOUND_ID,
    conversationId: OWNER,
    direction: 'in',
    kind: 'text',
    text: '台账里有这句',
    createdAt: 1_700_000_000_000,
  });
  const transport = batchTransport(
    [textMessage('7523486488309966866', '引用', INBOUND_ID)],
    OUTBOUND_ID
  );

  const previous = process.env[WEIXIN_LEDGER_ENV_VAR];
  process.env[WEIXIN_LEDGER_ENV_VAR] = '0';
  const gateway = makeGateway(transport, store, { messageLedger: ledger });
  const emitted: string[] = [];
  gateway.on('message', (message) => emitted.push(message.content));
  try {
    await gateway.start({ enabled: true, accountId: 'default' });
    await waitFor(() => emitted.length === 1);
  } finally {
    await gateway.stop();
    if (previous === undefined) delete process.env[WEIXIN_LEDGER_ENV_VAR];
    else process.env[WEIXIN_LEDGER_ENV_VAR] = previous;
  }

  assert.equal(emitted[0], `${WEIXIN_QUOTE_UNRESOLVED_PREFIX}引用`);
  assert.equal(ledger.rows.size, 1, 'the env switch must also stop writes');
});

// ---------------------------------------------------------------------------
// 5. Wiring — the production adapter (gateway → IMStore → SQLite)
// ---------------------------------------------------------------------------
test('wiring: the IMStore-backed ledger resolves a quote end to end', async () => {
  const { store: imStore, db } = makeInMemoryIMStore();
  const store = makeStore();
  seedCredentials(store);
  // EXACTLY the adapter IMGatewayManager builds.
  const ledger: WeixinMessageLedger = {
    put: (entry) => imStore.putWeixinLedgerEntry(entry),
    get: (msgId) => imStore.getWeixinLedgerEntry(msgId),
  };
  const transport = replyThenQuoteTransport(
    [textMessage(INBOUND_ID, 'ping')],
    [textMessage('7523486488309966865', '引用一下', OUTBOUND_ID)],
    OUTBOUND_ID
  );

  const gateway = makeGateway(transport, store, { messageLedger: ledger });
  const emitted: string[] = [];
  gateway.on('message', (message) => emitted.push(message.content));
  let handled = 0;
  gateway.setMessageCallback(async (_message, replyFn) => {
    handled += 1;
    if (handled === 1) await replyFn('从 SQLite 读出来的回复');
  });

  await gateway.start({ enabled: true, accountId: 'default' });
  try {
    await waitFor(() => emitted.length === 2);
  } finally {
    await gateway.stop();
  }

  assert.equal(imStore.getWeixinLedgerEntry(OUTBOUND_ID)?.text, '从 SQLite 读出来的回复');
  assert.equal(imStore.getWeixinLedgerEntry(OUTBOUND_ID)?.direction, 'out');
  assert.equal(emitted[1], '（引用：从 SQLite 读出来的回复）引用一下');
  db.close();
});

// ---------------------------------------------------------------------------
// 6. Exact ids — the transport must not round 19-digit values
// ---------------------------------------------------------------------------

test('ids: a 19-digit message_id survives JSON parsing without precision loss', () => {
  const parsed = parseWeixinJsonBody('{"ret":0,"message_id":7523489994131519368}') as Record<string, unknown>;
  assert.equal(parsed.message_id, OUTBOUND_ID);
  assert.equal(typeof parsed.message_id, 'string');

  // Small ids keep their number type — nothing else about the payload changes.
  const small = parseWeixinJsonBody('{"ret":0,"message_id":42}') as Record<string, unknown>;
  assert.equal(small.message_id, 42);

  // Nested per-item ids get the same treatment.
  const nested = parseWeixinJsonBody('{"msg_id":7523486488309966856}') as Record<string, unknown>;
  assert.equal(nested.msg_id, INBOUND_ID);
});

test('ids: parseSendMessageResponse accepts the exact string and rejects malformed values', () => {
  assert.deepEqual(parseSendMessageResponse({ message_id: OUTBOUND_ID }), {
    messageId: OUTBOUND_ID,
    rejection: null,
  });
  assert.deepEqual(parseSendMessageResponse({ msg: { message_id: OUTBOUND_ID } }), {
    messageId: OUTBOUND_ID,
    rejection: null,
  });
  assert.deepEqual(parseSendMessageResponse({ message_id: 42 }), { messageId: '42', rejection: null });
  assert.deepEqual(parseSendMessageResponse({}), { messageId: null, rejection: null });
  assert.deepEqual(parseSendMessageResponse(null), { messageId: null, rejection: null });
  assert.deepEqual(parseSendMessageResponse({ message_id: {} }), { messageId: null, rejection: 'malformed' });
});

test('ids: an entry is only built from a faithful id and a capped body', () => {
  assert.equal(normalizeWeixinLedgerId(7523489994131520000), null, 'a rounded number is refused');
  assert.equal(normalizeWeixinLedgerId('   '), null);
  assert.equal(normalizeWeixinLedgerId(42), '42');

  const longText = '甲'.repeat(WEIXIN_LEDGER_TEXT_MAX_CHARS + 50);
  const entry = buildWeixinLedgerEntry({
    msgId: OUTBOUND_ID,
    conversationId: OWNER,
    direction: 'out',
    kind: 'text',
    text: longText,
    createdAt: 1,
  });
  assert.equal(Array.from(entry?.text ?? '').length, WEIXIN_LEDGER_TEXT_MAX_CHARS);

  assert.equal(buildWeixinLedgerEntry({
    msgId: '',
    conversationId: OWNER,
    direction: 'out',
    kind: 'text',
    text: 'x',
    createdAt: 1,
  }), null);
});
