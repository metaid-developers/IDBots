import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CHANNEL_TIMEOUTS,
  GATEWAY_CLOSE_CODES,
  GatewayClient,
  type GatewayClientOptions,
  type GatewayConnectionState,
  type GatewayServerInfo,
  reconnectDelayMs,
} from '../src/mobile/bridge/gatewayClient.ts';

/**
 * REQ-E-25 (gateway client part): C2 frame codec, welcome/version guard,
 * close-code semantics, invoke queueing (32 in flight), offline/lost
 * rejections, channel-aware timeouts, backoff with jitter, ordered event
 * dispatch, and network/visibility triggered reconnects.
 *
 * All timers go through the injected `schedule`/`cancel` pair, so nothing
 * here leaves real handles behind; the two tests that intentionally use real
 * timers pass `schedule`/`cancel` overrides and keep their delays in ms.
 */

const URL = 'wss://cp.example.test/ws';

const WELCOME: Record<string, unknown> = {
  v: 1,
  type: 'welcome',
  contractVersion: '1.0.0',
  appVersion: '0.12.0',
  tenantId: 't_0123456789abcdefghij',
  serverTime: 1_700_000_000_000,
  ready: true,
  phase: 'ready',
};

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: FakeWebSocket[] = [];

  readyState: number = FakeWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closedWith: { code?: number; reason?: string } | null = null;
  readonly sentFrames: Record<string, unknown>[] = [];

  constructor(readonly url: string) {
    assert.equal(url, URL);
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    assert.equal(this.readyState, FakeWebSocket.OPEN, 'send() while not OPEN');
    this.sentFrames.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.readyState = FakeWebSocket.CLOSED;
    queueMicrotask(() => this.onclose?.({ code: code ?? 1000, reason: reason ?? '' }));
  }

  // Test drivers ------------------------------------------------------------

  doOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  doMessage(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  doRawMessage(data: string): void {
    this.onmessage?.({ data });
  }

  doClose(code: number, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }

  invokeFrames(): Record<string, unknown>[] {
    return this.sentFrames.filter((frame) => frame.type === 'invoke');
  }

  lastInvokeFrame(): Record<string, unknown> {
    const frames = this.invokeFrames();
    assert.ok(frames.length > 0, 'expected at least one invoke frame');
    return frames[frames.length - 1];
  }
}

interface ScheduledTask {
  fn: () => void;
  ms: number;
  canceled: boolean;
}

function makeFakeScheduler() {
  const tasks: ScheduledTask[] = [];
  const schedule = (fn: () => void, ms: number): ScheduledTask => {
    const task: ScheduledTask = { fn, ms, canceled: false };
    tasks.push(task);
    return task;
  };
  const cancel = (handle: unknown): void => {
    if (handle && typeof handle === 'object') {
      (handle as ScheduledTask).canceled = true;
    }
  };
  const run = (index: number): void => {
    const task = tasks[index];
    if (task && !task.canceled) {
      task.fn();
    }
  };
  const runLast = (): void => run(tasks.length - 1);
  return { tasks, schedule, cancel, run, runLast };
}

function setup(options: Partial<GatewayClientOptions> = {}) {
  FakeWebSocket.instances = [];
  const scheduler = makeFakeScheduler();
  const client = new GatewayClient({
    url: URL,
    WebSocketImpl: FakeWebSocket as unknown as GatewayClientOptions['WebSocketImpl'],
    keepaliveIntervalMs: 0,
    random: () => 0.5,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    ...options,
  });
  const socket = (): FakeWebSocket => {
    const instance = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    if (!instance) {
      throw new Error('no FakeWebSocket instance created');
    }
    return instance;
  };
  /** Opens the current socket and answers with `welcome` (online). */
  const connect = (welcome: Record<string, unknown> = WELCOME): FakeWebSocket => {
    const ws = socket();
    ws.doOpen();
    ws.doMessage(welcome);
    return ws;
  };
  return { client, socket, connect, scheduler };
}

// ---------------------------------------------------------------------------
// 1. welcome / keepalive
// ---------------------------------------------------------------------------

test('welcome -> online, exposes versions/ready/phase; ping answered with pong', (t) => {
  const { client, socket, connect } = setup();
  t.after(() => client.close());
  const states: GatewayConnectionState[] = [];
  client.onStateChange((state) => states.push(state));

  assert.equal(client.getState(), 'connecting');
  connect();
  assert.equal(client.getState(), 'online');
  assert.deepEqual(states, ['online']);

  const info = client.getServerInfo();
  assert.deepEqual(info, {
    contractVersion: '1.0.0',
    appVersion: '0.12.0',
    tenantId: 't_0123456789abcdefghij',
    serverTime: 1_700_000_000_000,
    ready: true,
    phase: 'ready',
  });

  socket().doMessage({ v: 1, type: 'ping', ts: 4242 });
  const pongs = socket().sentFrames.filter((frame) => frame.type === 'pong');
  assert.deepEqual(pongs, [{ v: 1, type: 'pong', ts: 4242 }]);
});

test('welcome with a newer minor/patch contract version still goes online', (t) => {
  const { client, connect } = setup();
  t.after(() => client.close());
  connect({ ...WELCOME, contractVersion: '1.9.9' });
  assert.equal(client.getState(), 'online');
  assert.equal(client.getServerInfo()?.contractVersion, '1.9.9');
  assert.equal(client.getVersionMismatch(), null);
});

// ---------------------------------------------------------------------------
// 2. version guard
// ---------------------------------------------------------------------------

test('major contract mismatch -> version-mismatch state, no reconnect, invokes reject', async (t) => {
  const { client, socket, connect, scheduler } = setup();
  t.after(() => client.close());
  connect({ ...WELCOME, contractVersion: '2.0.0' });

  assert.equal(client.getState(), 'version-mismatch');
  assert.deepEqual(client.getVersionMismatch(), { expected: 1, actual: '2.0.0' });
  assert.ok(socket().closedWith, 'client must close the mismatched socket');
  assert.ok(scheduler.tasks.every((task) => task.canceled), 'no reconnect timer may be scheduled');

  await assert.rejects(client.invoke('cowork:session:list'), (error: Error & { code?: string; retryable?: boolean }) => {
    assert.equal(error.code, 'OFFLINE');
    assert.equal(error.retryable, false);
    return true;
  });
  assert.equal(client.getState(), 'version-mismatch');
});

test('an unparseable contract version is treated as a mismatch', (t) => {
  const { client, connect } = setup();
  t.after(() => client.close());
  connect({ ...WELCOME, contractVersion: 'not-semver' });
  assert.equal(client.getState(), 'version-mismatch');
  assert.equal(client.getVersionMismatch()?.actual, 'not-semver');
});

// ---------------------------------------------------------------------------
// 3. invoke results and error mapping
// ---------------------------------------------------------------------------

test('invoke sends the exact C2 invoke frame (v/id/channel/args) and resolves the raw value', async (t) => {
  const { client, socket, connect } = setup();
  t.after(() => client.close());
  connect();

  const promise = client.invoke('cowork:session:list', { limit: 5 }, 'extra');
  const frame = socket().lastInvokeFrame();
  assert.equal(frame.v, 1);
  assert.equal(frame.type, 'invoke');
  assert.equal(typeof frame.id, 'string');
  assert.ok((frame.id as string).length <= 64, 'invoke id must be at most 64 chars');
  assert.equal(frame.channel, 'cowork:session:list');
  assert.deepEqual(frame.args, [{ limit: 5 }, 'extra']);

  socket().doMessage({ v: 1, type: 'result', id: frame.id, ok: true, value: { sessions: [] } });
  assert.deepEqual(await promise, { sessions: [] });
});

test('a { success: false } result value passes through unchanged (it is a successful Result)', async (t) => {
  const { client, socket, connect } = setup();
  t.after(() => client.close());
  connect();
  const promise = client.invoke('metabot:create', { name: 'x' });
  const frame = socket().lastInvokeFrame();
  socket().doMessage({
    v: 1,
    type: 'result',
    id: frame.id,
    ok: true,
    value: { success: false, error: 'name taken' },
  });
  assert.deepEqual(await promise, { success: false, error: 'name taken' });
});

test('HANDLER_ERROR rejects with a plain Error (no code property), like ipcRenderer.invoke', async (t) => {
  const { client, socket, connect } = setup();
  t.after(() => client.close());
  connect();
  const promise = client.invoke('cowork:session:start', 'bad-id');
  const frame = socket().lastInvokeFrame();
  socket().doMessage({
    v: 1,
    type: 'result',
    id: frame.id,
    ok: false,
    error: { code: 'HANDLER_ERROR', message: 'session not found', retryable: false },
  });
  await assert.rejects(promise, (error: Error & { code?: string }) => {
    assert.equal(error.message, 'session not found');
    assert.equal('code' in error, false, 'HANDLER_ERROR must not carry a code property');
    assert.equal(error.code, undefined);
    return true;
  });
});

test('other gateway errors reject with an Error carrying code and retryable', async (t) => {
  const { client, socket, connect } = setup();
  t.after(() => client.close());
  connect();

  const notAllowed = client.invoke('forbidden:channel');
  const notAllowedFrame = socket().lastInvokeFrame();
  socket().doMessage({
    v: 1,
    type: 'result',
    id: notAllowedFrame.id,
    ok: false,
    error: { code: 'CHANNEL_NOT_ALLOWED', message: 'channel not allowlisted', retryable: false },
  });
  await assert.rejects(notAllowed, (error: Error & { code?: string; retryable?: boolean }) => {
    assert.equal(error.code, 'CHANNEL_NOT_ALLOWED');
    assert.equal(error.retryable, false);
    return true;
  });

  const limited = client.invoke('cowork:session:list');
  const limitedFrame = socket().lastInvokeFrame();
  socket().doMessage({
    v: 1,
    type: 'result',
    id: limitedFrame.id,
    ok: false,
    error: { code: 'RATE_LIMITED', message: 'slow down', retryable: true },
  });
  await assert.rejects(limited, (error: Error & { code?: string; retryable?: boolean }) => {
    assert.equal(error.code, 'RATE_LIMITED');
    assert.equal(error.retryable, true);
    return true;
  });
});

test('results for unknown ids and malformed frames are ignored', (t) => {
  const { client, socket, connect } = setup();
  t.after(() => client.close());
  connect();
  socket().doMessage({ v: 1, type: 'result', id: 'never-sent', ok: true, value: 1 });
  socket().doRawMessage('this is not json');
  socket().doMessage({ noType: true });
  socket().doMessage({ type: 'event', args: 'not-an-array' });
  assert.equal(client.getInFlightCount(), 0);
  assert.equal(client.getState(), 'online');
});

// ---------------------------------------------------------------------------
// 4. offline invokes: wait up to 15 s, then reject OFFLINE
// ---------------------------------------------------------------------------

test('invoke made while disconnected waits, then resolves when the reconnect lands', async (t) => {
  const { client, socket, connect, scheduler } = setup();
  t.after(() => client.close());
  connect();
  socket().doClose(1006, 'network drop');
  assert.equal(client.getState(), 'reconnecting');
  const reconnectTask = scheduler.tasks[scheduler.tasks.length - 1];

  const promise = client.invoke('cowork:session:list');
  assert.equal(socket().invokeFrames().length, 0, 'offline invoke must not be sent yet');
  assert.equal(client.getQueuedCount(), 1);

  // Backoff fires: a second socket connects and the queued invoke drains to it.
  reconnectTask.fn();
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.equal(socket().readyState, FakeWebSocket.CONNECTING);
  connect();
  assert.equal(client.getState(), 'online');

  const frame = socket().invokeFrames()[0];
  assert.equal(frame.channel, 'cowork:session:list');
  socket().doMessage({ v: 1, type: 'result', id: frame.id, ok: true, value: 'resynced' });
  assert.equal(await promise, 'resynced');
});

test('invoke made while disconnected rejects OFFLINE (retryable) after the 15 s window', async (t) => {
  const { client, socket, connect } = setup({
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
    offlineTimeoutMs: 40,
  });
  t.after(() => client.close());
  connect();
  socket().doClose(1006, 'network drop');

  await assert.rejects(client.invoke('cowork:session:list'), (error: Error & { code?: string; retryable?: boolean }) => {
    assert.equal(error.code, 'OFFLINE');
    assert.equal(error.retryable, true);
    return true;
  });
});

test('invoke made in a terminal state rejects OFFLINE immediately (no 15 s wait)', async (t) => {
  const { client, socket, connect, scheduler } = setup();
  t.after(() => client.close());
  connect();
  socket().doClose(GATEWAY_CLOSE_CODES.TOO_MANY_DEVICES, 'max clients');
  assert.equal(client.getState(), 'too-many-devices');

  await assert.rejects(client.invoke('cowork:session:list'), (error: Error & { code?: string; retryable?: boolean }) => {
    assert.equal(error.code, 'OFFLINE');
    assert.equal(error.retryable, false);
    return true;
  });
  assert.ok(scheduler.tasks.every((task) => task.canceled), 'no timers may be pending in a terminal state');
});

// ---------------------------------------------------------------------------
// 5. in-flight invokes on a dropped socket: CONNECTION_LOST, never retried
// ---------------------------------------------------------------------------

test('in-flight invoke rejects CONNECTION_LOST on socket drop and is not re-sent after reconnect', async (t) => {
  const { client, socket, connect, scheduler } = setup();
  t.after(() => client.close());
  const first = connect();

  const promise = client.invoke('gigSquare:sendOrder', { orderId: 'o_1' });
  const frame = first.invokeFrames()[0];
  assert.equal(frame.channel, 'gigSquare:sendOrder');

  first.doClose(1006, 'network drop');
  await assert.rejects(promise, (error: Error & { code?: string; retryable?: boolean }) => {
    assert.equal(error.code, 'CONNECTION_LOST');
    assert.equal(error.retryable, true);
    return true;
  });

  // Reconnect and confirm the invoke was NOT auto-retried on the new socket.
  scheduler.runLast();
  assert.equal(FakeWebSocket.instances.length, 2);
  const second = connect();
  assert.equal(second.invokeFrames().length, 0, 'sent invokes must never be auto-retried');
  // And no phantom result can settle the old invoke: it is already rejected.
  second.doMessage({ v: 1, type: 'result', id: frame.id, ok: true, value: 'late' });
  await Promise.resolve();
  assert.equal(client.getState(), 'online');
});

test('queued (not yet sent) invokes carry over to the next socket, in FIFO order', async (t) => {
  const { client, socket, connect, scheduler } = setup();
  t.after(() => client.close());
  connect();
  socket().doClose(1006, 'drop');
  const reconnectTask = scheduler.tasks[scheduler.tasks.length - 1];

  client.invoke('cowork:session:list').catch(() => {});
  client.invoke('skills:list').catch(() => {});
  reconnectTask.fn();
  connect();

  const channels = socket().invokeFrames().map((frame) => frame.channel);
  assert.deepEqual(channels, ['cowork:session:list', 'skills:list'], 'queue must drain FIFO');
});

// ---------------------------------------------------------------------------
// 6. 32-in-flight cap; the 33rd invoke queues until a result arrives
// ---------------------------------------------------------------------------

test('33 concurrent invokes: 32 are sent, the 33rd queues until a result frees a slot', async (t) => {
  const { client, socket, connect } = setup();
  t.after(() => client.close());
  connect();

  const promises = Array.from({ length: 33 }, (_, index) => client.invoke('demo:channel', index));
  assert.equal(socket().invokeFrames().length, 32);
  assert.equal(client.getInFlightCount(), 32);
  assert.equal(client.getQueuedCount(), 1);

  // Settle the oldest invoke; the queued one drains immediately.
  const firstId = socket().invokeFrames()[0].id as string;
  socket().doMessage({ v: 1, type: 'result', id: firstId, ok: true, value: 0 });
  assert.equal(socket().invokeFrames().length, 33);
  assert.equal(client.getQueuedCount(), 0);

  // Settle everything else so the test ends with no pending promises.
  for (const frame of socket().invokeFrames().slice(1)) {
    socket().doMessage({ v: 1, type: 'result', id: frame.id as string, ok: true, value: frame.args });
  }
  const results = await Promise.all(promises);
  assert.equal(results.length, 33);
});

test('a closing socket cannot spin the queue drain while the client still says online', async (t) => {
  const { client, socket, connect } = setup({ maxInFlight: 1 });
  t.after(() => client.close());
  connect();

  const first = client.invoke('demo:first');
  const second = client.invoke('demo:second');
  second.catch(() => {});
  assert.equal(client.getInFlightCount(), 1);
  assert.equal(client.getQueuedCount(), 1);

  socket().readyState = FakeWebSocket.CLOSING;
  const firstId = socket().invokeFrames()[0].id as string;
  socket().doMessage({ v: 1, type: 'result', id: firstId, ok: true, value: 'first' });
  await first;

  assert.equal(client.getQueuedCount(), 1, 'the queued invoke must survive the unusable socket');
  assert.equal(client.getInFlightCount(), 0);

  socket().readyState = FakeWebSocket.OPEN;
  const third = client.invoke('demo:third');
  third.catch(() => {});
  assert.deepEqual(
    socket().invokeFrames().map((frame) => frame.channel),
    ['demo:first', 'demo:second'],
  );
  assert.equal(client.getQueuedCount(), 1, 'the third invoke waits behind the one-slot cap');

  const secondFrame = socket().invokeFrames()[1];
  socket().doMessage({ v: 1, type: 'result', id: secondFrame.id as string, ok: true, value: secondFrame.channel });
  const thirdFrame = socket().invokeFrames()[2];
  socket().doMessage({ v: 1, type: 'result', id: thirdFrame.id as string, ok: true, value: thirdFrame.channel });
  await Promise.all([second, third]);
});

// ---------------------------------------------------------------------------
// 7. channel-aware client timeouts (channel timeout + 10 s grace)
// ---------------------------------------------------------------------------

test('the built-in channel timeout map matches C2', () => {
  assert.equal(DEFAULT_CHANNEL_TIMEOUTS.default, 120_000);
  assert.equal(DEFAULT_CHANNEL_TIMEOUTS['idbots:createMetaBotOnChain'], 300_000);
  assert.equal(DEFAULT_CHANNEL_TIMEOUTS['chainBackup:backup'], 900_000);
  assert.equal(DEFAULT_CHANNEL_TIMEOUTS['chainBackup:restore'], 900_000);
  assert.equal(DEFAULT_CHANNEL_TIMEOUTS['gigSquare:sendOrder'], 300_000);
});

test('client-side deadline is channel timeout + 10 s grace (310 s on-chain, 130 s default)', (t) => {
  const { client, socket, connect, scheduler } = setup();
  t.after(() => client.close());
  connect();

  client.invoke('idbots:createMetaBotOnChain').catch(() => {});
  client.invoke('some:otherChannel').catch(() => {});
  client.invoke('chainBackup:restore').catch(() => {});

  const timeoutTasks = scheduler.tasks.filter((task) => !task.canceled);
  const delays = timeoutTasks.map((task) => task.ms).sort((a, b) => a - b);
  assert.deepEqual(delays, [130_000, 310_000, 910_000]);
  assert.equal(socket().invokeFrames().length, 3);
});

test('a timed-out invoke rejects with TIMEOUT (retryable) and frees its slot', async (t) => {
  const { client, socket, connect } = setup({
    schedule: (fn, ms) => setTimeout(fn, ms),
    cancel: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
    channelTimeouts: { 'demo:slow': 40 },
    timeoutGraceMs: 10,
  });
  t.after(() => client.close());
  connect();

  const started = Date.now();
  await assert.rejects(client.invoke('demo:slow'), (error: Error & { code?: string; retryable?: boolean }) => {
    assert.equal(error.code, 'TIMEOUT');
    assert.equal(error.retryable, true);
    return true;
  });
  assert.ok(Date.now() - started >= 45, 'timeout must wait for channel + grace');

  // The slot was freed and the client is still usable and online.
  assert.equal(client.getInFlightCount(), 0);
  assert.equal(client.getState(), 'online');
  const followUp = client.invoke('demo:slow');
  const frame = socket().lastInvokeFrame();
  socket().doMessage({ v: 1, type: 'result', id: frame.id, ok: true, value: 'fast' });
  assert.equal(await followUp, 'fast');
});

// ---------------------------------------------------------------------------
// 8. backoff schedule: 1, 2, 4, 8, 16, then 30, 30 s (±20 % jitter)
// ---------------------------------------------------------------------------

test('reconnectDelayMs doubles to 16 s, then stays at 30 s, with ±20 % jitter', () => {
  assert.equal(reconnectDelayMs(1, () => 0.5), 1_000);
  assert.equal(reconnectDelayMs(2, () => 0.5), 2_000);
  assert.equal(reconnectDelayMs(3, () => 0.5), 4_000);
  assert.equal(reconnectDelayMs(5, () => 0.5), 16_000);
  assert.equal(reconnectDelayMs(6, () => 0.5), 30_000);
  assert.equal(reconnectDelayMs(20, () => 0.5), 30_000);
  // Jitter bounds: random() = 0 -> -20 %, random() = 1 -> +20 %.
  assert.equal(reconnectDelayMs(1, () => 0), 800);
  assert.equal(reconnectDelayMs(1, () => 1), 1_200);
  assert.equal(reconnectDelayMs(6, () => 0), 24_000);
  assert.equal(reconnectDelayMs(6, () => 1), 36_000);
});

test('each failed attempt schedules the next backoff delay, and state flips to reconnecting', (t) => {
  const { client, socket, connect, scheduler } = setup();
  t.after(() => client.close());
  connect();
  assert.equal(client.getState(), 'online');

  const delays: number[] = [];
  for (let attempt = 1; attempt <= 7; attempt += 1) {
    socket().doClose(1006, 'drop');
    if (attempt === 1) {
      assert.equal(client.getState(), 'reconnecting', 'first close after online must be reconnecting');
    }
    const task = scheduler.tasks[scheduler.tasks.length - 1];
    assert.ok(task, `expected a reconnect timer for attempt ${attempt}`);
    delays.push(task.ms);
    task.fn(); // fire the backoff -> next socket opens
    assert.equal(FakeWebSocket.instances.length, attempt + 1);
    socket().doOpen(); // next attempt is in flight (welcome never arrives -> fails again)
  }
  assert.deepEqual(delays, [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  assert.equal(client.getState(), 'reconnecting', 'seven failed attempts never go online');
  socket().doMessage(WELCOME);
  assert.equal(client.getState(), 'online');
});

test('the very first connect stays "connecting" across failures (never "reconnecting")', (t) => {
  const { client, socket, scheduler } = setup();
  t.after(() => client.close());
  socket().doClose(1006, 'first attempt failed');
  assert.equal(client.getState(), 'connecting');
  scheduler.runLast();
  assert.equal(FakeWebSocket.instances.length, 2);
  socket().doOpen();
  socket().doMessage(WELCOME);
  assert.equal(client.getState(), 'online');
});

// ---------------------------------------------------------------------------
// 9. close codes
// ---------------------------------------------------------------------------

test('close 4001 and 4003 -> unauthorized (terminal, no reconnect, close info exposed)', (t) => {
  for (const code of [GATEWAY_CLOSE_CODES.UNAUTHORIZED, GATEWAY_CLOSE_CODES.ORIGIN_NOT_ALLOWED]) {
    FakeWebSocket.instances = [];
    const scheduler = makeFakeScheduler();
    const client = new GatewayClient({
      url: URL,
      WebSocketImpl: FakeWebSocket as unknown as GatewayClientOptions['WebSocketImpl'],
      keepaliveIntervalMs: 0,
      schedule: scheduler.schedule,
      cancel: scheduler.cancel,
    });
    try {
      const ws = FakeWebSocket.instances[0];
      ws.doOpen();
      ws.doMessage(WELCOME);
      ws.doClose(code, code === 4001 ? 'session expired' : 'bad origin');
      assert.equal(client.getState(), 'unauthorized');
      assert.deepEqual(client.getLastClose(), { code, reason: code === 4001 ? 'session expired' : 'bad origin' });
      assert.ok(scheduler.tasks.every((task) => task.canceled), 'unauthorized must not schedule reconnects');
    } finally {
      client.close();
    }
  }
});

test('close 4013 -> tenant-unavailable (terminal, UI polls /api/v1/me)', (t) => {
  const { client, socket, connect, scheduler } = setup();
  t.after(() => client.close());
  connect();
  socket().doClose(GATEWAY_CLOSE_CODES.TENANT_UNAVAILABLE, 'tenant suspended');
  assert.equal(client.getState(), 'tenant-unavailable');
  assert.equal(client.getLastClose()?.code, 4013);
  assert.ok(scheduler.tasks.every((task) => task.canceled), 'tenant-unavailable must not schedule reconnects');
});

test('close 4009 -> too-many-devices (terminal, no auto-reconnect)', (t) => {
  const { client, socket, connect, scheduler } = setup();
  t.after(() => client.close());
  connect();
  socket().doClose(GATEWAY_CLOSE_CODES.TOO_MANY_DEVICES, 'max 3 sockets');
  assert.equal(client.getState(), 'too-many-devices');
  assert.equal(client.getLastClose()?.code, 4009);
  assert.ok(scheduler.tasks.every((task) => task.canceled), 'too-many-devices must not schedule reconnects');
  assert.equal(FakeWebSocket.instances.length, 1, 'no new socket may be opened');
});

test('close 4012 -> upgrading banner, keeps reconnecting, back to online on welcome', (t) => {
  const { client, socket, connect, scheduler } = setup();
  t.after(() => client.close());
  connect();
  socket().doClose(GATEWAY_CLOSE_CODES.UPGRADING, 'restarting');
  assert.equal(client.getState(), 'upgrading');
  assert.equal(client.getLastClose()?.code, 4012);

  scheduler.runLast(); // backoff fires; still "upgrading" (banner), not "reconnecting"
  assert.equal(client.getState(), 'upgrading');
  connect();
  assert.equal(client.getState(), 'online');
});

test('close 1000/1001 and network drops -> normal reconnect flow', (t) => {
  const { client, socket, connect, scheduler } = setup();
  t.after(() => client.close());
  connect();
  socket().doClose(1001, 'going away');
  assert.equal(client.getState(), 'reconnecting');
  scheduler.runLast();
  connect();
  assert.equal(client.getState(), 'online');
});

// ---------------------------------------------------------------------------
// 10. event dispatch
// ---------------------------------------------------------------------------

test('events dispatch in order to channel and wildcard subscribers; unsubscribe stops delivery', (t) => {
  const { client, socket, connect } = setup();
  t.after(() => client.close());
  connect();

  const log: string[] = [];
  const unsubscribeMessage = client.onEvent('cowork:stream:message', (args) => {
    log.push(`channel:${JSON.stringify(args)}`);
  });
  client.onEvent('other:channel', (args) => {
    log.push(`other:${JSON.stringify(args)}`);
  });
  const unsubscribeAny = client.onAnyEvent((channel, args) => {
    log.push(`any:${channel}:${JSON.stringify(args)}`);
  });

  socket().doMessage({ v: 1, type: 'event', channel: 'cowork:stream:message', args: ['a'] });
  socket().doMessage({ v: 1, type: 'event', channel: 'cowork:stream:message', args: ['b'] });
  assert.deepEqual(log, [
    'channel:["a"]',
    'any:cowork:stream:message:["a"]',
    'channel:["b"]',
    'any:cowork:stream:message:["b"]',
  ]);

  unsubscribeMessage();
  socket().doMessage({ v: 1, type: 'event', channel: 'cowork:stream:message', args: ['c'] });
  assert.deepEqual(log.slice(-1), ['any:cowork:stream:message:["c"]']);

  unsubscribeAny();
  socket().doMessage({ v: 1, type: 'event', channel: 'cowork:stream:message', args: ['d'] });
  assert.equal(log.length, 5, 'no delivery after both unsubscribes');

  // Non-event frames never reach subscribers.
  socket().doMessage({ v: 1, type: 'pong', ts: 1 });
  assert.equal(log.length, 5);
});

// ---------------------------------------------------------------------------
// 11. immediate reconnect on network online / app foreground
// ---------------------------------------------------------------------------

test('window "online" and visibilitychange->visible trigger an immediate reconnectNow()', (t) => {
  const handlers: Record<string, () => void> = {};
  const fakeDocument: { visibilityState: string; addEventListener: (type: string, cb: () => void) => void; removeEventListener: () => void } = {
    visibilityState: 'visible',
    addEventListener: (type, cb) => {
      handlers[`document:${type}`] = cb;
    },
    removeEventListener: () => {},
  };
  const fakeWindow = {
    addEventListener: (type: string, cb: () => void) => {
      handlers[`window:${type}`] = cb;
    },
    removeEventListener: () => {},
  };
  const g = globalThis as Record<string, unknown>;
  g.window = fakeWindow;
  g.document = fakeDocument;

  try {
    const { client, socket, connect, scheduler } = setup();
    t.after(() => client.close());
    connect();
    assert.equal(client.getState(), 'online');

    // While online the hooks probe without replacing the socket.
    handlers['window:online']();
    assert.equal(FakeWebSocket.instances.length, 1);

    // Drop the socket, then recover immediately via the window hook.
    socket().doClose(1006, 'drop');
    assert.equal(client.getState(), 'reconnecting');
    const backoffTask = scheduler.tasks[scheduler.tasks.length - 1];
    handlers['window:online']();
    assert.equal(FakeWebSocket.instances.length, 2, 'window online must open a new socket immediately');
    assert.equal(backoffTask.canceled, true, 'the pending backoff timer must be canceled');
    connect();
    assert.equal(client.getState(), 'online');

    // Hidden visibility change must not reconnect; visible must.
    socket().doClose(1006, 'drop');
    fakeDocument.visibilityState = 'hidden';
    handlers['document:visibilitychange']();
    assert.equal(FakeWebSocket.instances.length, 2, 'hidden must not trigger a reconnect');
    fakeDocument.visibilityState = 'visible';
    handlers['document:visibilitychange']();
    assert.equal(FakeWebSocket.instances.length, 3, 'visible must trigger an immediate reconnect');

    // Direct foreground recovery also leaves a healthy socket in place.
    connect();
    client.reconnectNow();
    assert.equal(FakeWebSocket.instances.length, 3);
  } finally {
    delete g.window;
    delete g.document;
  }
});

test('window "offline" shows the offline banner immediately and "online" reconnects', (t) => {
  const handlers: Record<string, () => void> = {};
  const g = globalThis as Record<string, unknown>;
  g.window = {
    addEventListener: (type: string, cb: () => void) => {
      handlers[type] = cb;
    },
    removeEventListener: () => {},
  };

  try {
    const { client, socket, connect } = setup();
    t.after(() => client.close());
    connect();
    assert.equal(client.getState(), 'online');

    handlers.offline();
    assert.equal(client.getState(), 'offline');

    handlers.online();
    assert.equal(FakeWebSocket.instances.length, 2, 'online must open a socket immediately');
    connect();
    assert.equal(client.getState(), 'online');
  } finally {
    delete g.window;
  }
});

test('a stale close cannot clear the replacement socket after immediate reconnect', async (t) => {
  const handlers: Record<string, () => void> = {};
  const g = globalThis as Record<string, unknown>;
  g.window = {
    addEventListener: (type: string, cb: () => void) => { handlers[type] = cb; },
    removeEventListener: () => {},
  };
  try {
    const { client, connect, socket } = setup();
    t.after(() => client.close());
    const first = connect();
    handlers.offline();
    client.reconnectNow();
    const second = connect();
    await Promise.resolve();
    assert.equal(first.closedWith?.reason, 'reconnectNow');

    const promise = client.invoke('cowork:session:list');
    void promise.catch(() => {});
    assert.equal(second.invokeFrames().length, 1, 'the replacement socket must remain usable');
    assert.equal(socket(), second);
    second.doMessage({ v: 1, type: 'result', id: second.invokeFrames()[0].id, ok: true, value: [] });
    assert.deepEqual(await promise, []);
  } finally {
    delete g.window;
  }
});

test('duplicate foreground reconnect signals do not replace an in-flight connection attempt', (t) => {
  const handlers: Record<string, () => void> = {};
  const g = globalThis as Record<string, unknown>;
  g.window = {
    addEventListener: (type: string, cb: () => void) => { handlers[type] = cb; },
    removeEventListener: () => {},
  };
  try {
    const { client, connect } = setup();
    t.after(() => client.close());
    connect();
    handlers.offline();
    client.reconnectNow();
    client.reconnectNow();
    assert.equal(FakeWebSocket.instances.length, 2, 'native and DOM foreground events must coalesce');
  } finally {
    delete g.window;
  }
});

test('a pong keeps the healthy online socket connected after a foreground probe', (t) => {
  const { client, connect, socket, scheduler } = setup();
  t.after(() => client.close());
  const first = connect();
  client.reconnectNow();
  client.reconnectNow();
  assert.equal(FakeWebSocket.instances.length, 1, 'duplicate probes must coalesce');
  first.doMessage({ v: 1, type: 'pong', ts: Date.now() });
  assert.equal(client.getState(), 'online');
  assert.ok(scheduler.tasks.every((task) => task.canceled), 'pong cancels the probe deadline');
  assert.equal(socket(), first);
});

test('an unresponsive online socket is replaced after the foreground probe expires', (t) => {
  const { client, connect, scheduler } = setup();
  t.after(() => client.close());
  connect();
  client.reconnectNow();
  assert.equal(FakeWebSocket.instances.length, 1, 'a healthy socket is not replaced eagerly');
  scheduler.runLast();
  assert.equal(FakeWebSocket.instances.length, 2, 'a missing pong must force a fresh socket');
  assert.equal(client.getState(), 'reconnecting');
  connect();
  assert.equal(client.getState(), 'online');
});

test('a socket that never receives welcome times out and retries', (t) => {
  const { client, connect, scheduler } = setup({ connectionTimeoutMs: 10_000 });
  t.after(() => client.close());
  assert.ok(scheduler.tasks.some((task) => task.ms === 10_000), 'welcome must have a deadline');
  scheduler.runLast();
  scheduler.runLast();
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.equal(client.getState(), 'connecting');
  connect();
  assert.equal(client.getState(), 'online');
});

// ---------------------------------------------------------------------------
// 12. onReconnected hook (REQ-E-5 anchor) and teardown
// ---------------------------------------------------------------------------

test('onReconnected fires on the first connect and on every reconnect with the welcome info', (t) => {
  const { client, socket, connect, scheduler } = setup();
  t.after(() => client.close());
  const seen: GatewayServerInfo[] = [];
  client.onReconnected((info) => seen.push(info));

  connect();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].phase, 'ready');

  socket().doClose(1006, 'drop');
  scheduler.runLast();
  connect({ ...WELCOME, phase: 'ready', serverTime: 1_700_000_001_000 });
  assert.equal(seen.length, 2);
  assert.equal(seen[1].serverTime, 1_700_000_001_000);
});

test('close() rejects pending invokes, cancels timers, and ends in the offline state', async (t) => {
  const { client, socket, connect, scheduler } = setup();
  connect();
  const inFlight = client.invoke('cowork:session:list');
  socket().doClose(1006, 'drop');
  // The queued invoke is waiting for the offline window; close() must reject both.
  const queued = client.invoke('skills:list');
  client.close();

  await assert.rejects(inFlight, (error: Error & { code?: string }) => error.code === 'CONNECTION_LOST');
  await assert.rejects(queued, (error: Error & { code?: string }) => error.code === 'OFFLINE');
  assert.equal(client.getState(), 'offline');
  assert.ok(scheduler.tasks.every((task) => task.canceled), 'no scheduled task may survive close()');
});

test('an unsubscribed onReconnected listener no longer fires', (t) => {
  const { client, connect } = setup();
  t.after(() => client.close());
  let count = 0;
  const unsubscribe = client.onReconnected(() => {
    count += 1;
  });
  unsubscribe();
  connect();
  assert.equal(count, 0);
});
