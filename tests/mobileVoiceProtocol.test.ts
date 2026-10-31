// Voice WebSocket protocol + client unit tests (voice P0, subtask #10).
//
// protocol.ts is THE alignment point with the gateway (DRAFT v0 until
// 阿码's protocol document lands) — these tests pin the wire dialect so any
// accidental drift fails loudly. The client tests use a fake WebSocket
// constructor (same Transport-abstraction pattern as mobileGatewayClient).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildVoiceSocketUrl,
  decodeServerEvent,
  encodeClientMessage,
  encodeStartMessage,
  mapServerErrorToCopyKey,
  VOICE_PCM_FORMAT,
  VOICE_PROTOCOL_ID,
} from '../src/mobile/app/voice/protocol.ts';
import { VoiceSocketClient, type VoiceWebSocketLike } from '../src/mobile/app/voice/voiceSocket.ts';

// ---------------------------------------------------------------------------
// protocol.ts — wire dialect
// ---------------------------------------------------------------------------

test('start frame declares the draft protocol id and the 16 kHz s16le mono contract', () => {
  const frame = JSON.parse(encodeStartMessage('zh-CN')) as Record<string, unknown>;
  assert.equal(frame.protocol, VOICE_PROTOCOL_ID);
  assert.equal(frame.type, 'start');
  assert.equal(frame.sampleRate, VOICE_PCM_FORMAT.sampleRate);
  assert.equal(frame.sampleRate, 16000);
  assert.equal(frame.pcm, 's16le');
  assert.equal(frame.channels, 1);
  assert.equal(frame.locale, 'zh-CN');
  const noLocale = JSON.parse(encodeStartMessage()) as Record<string, unknown>;
  assert.equal('locale' in noLocale, false, 'locale is omitted when unknown');
});

test('stop frame is a bare type marker', () => {
  assert.deepEqual(JSON.parse(encodeClientMessage({ type: 'stop' })), { type: 'stop' });
});

test('decodeServerEvent: every server frame kind parses into its typed event', () => {
  assert.deepEqual(decodeServerEvent('{"type":"ready","sessionId":"s1","quotaRemainingSeconds":300}'), {
    kind: 'ready',
    sessionId: 's1',
    quotaRemainingSeconds: 300,
  });
  assert.deepEqual(decodeServerEvent('{"type":"partial","text":"你好"}'), { kind: 'partial', text: '你好' });
  assert.deepEqual(decodeServerEvent('{"type":"final","text":"你好世界。"}'), { kind: 'final', text: '你好世界。' });
  assert.deepEqual(decodeServerEvent('{"type":"error","code":"quota_exceeded"}'), {
    kind: 'error',
    code: 'quota_exceeded',
    message: undefined,
  });
  assert.deepEqual(decodeServerEvent('{"type":"end"}'), { kind: 'end' });
});

test('decodeServerEvent: garbage and foreign frames return null (never crash the UI)', () => {
  assert.equal(decodeServerEvent('not json'), null);
  assert.equal(decodeServerEvent('42'), null);
  assert.equal(decodeServerEvent('null'), null);
  assert.equal(decodeServerEvent('{"type":"partial"}'), null, 'partial without text is invalid');
  assert.equal(decodeServerEvent('{"type":"mystery"}'), null, 'unknown type is invalid');
  assert.equal(decodeServerEvent('{"noType":true}'), null);
});

test('decodeServerEvent: unknown error codes map to "unknown" instead of failing', () => {
  assert.deepEqual(decodeServerEvent('{"type":"error","code":"warp_core_breach","message":"soon"}'), {
    kind: 'error',
    code: 'unknown',
    message: 'soon',
  });
});

test('mapServerErrorToCopyKey: full table (keep in sync with i18n errorServer.*)', () => {
  assert.equal(mapServerErrorToCopyKey('unauthorized'), 'unauthorized');
  assert.equal(mapServerErrorToCopyKey('quota_exceeded'), 'quota');
  assert.equal(mapServerErrorToCopyKey('rate_limited'), 'busy');
  assert.equal(mapServerErrorToCopyKey('upstream_unavailable'), 'upstream');
  assert.equal(mapServerErrorToCopyKey('timeout'), 'timeout');
  assert.equal(mapServerErrorToCopyKey('bad_request'), 'generic');
  assert.equal(mapServerErrorToCopyKey('internal'), 'generic');
  assert.equal(mapServerErrorToCopyKey('unknown'), 'generic');
});

test('buildVoiceSocketUrl: explicit override wins; node default is the same-origin path', () => {
  assert.equal(buildVoiceSocketUrl('ws://127.0.0.1:8791/voice'), 'ws://127.0.0.1:8791/voice');
  assert.equal(buildVoiceSocketUrl('  '), '/ws/voice', 'blank override falls back');
  assert.equal(buildVoiceSocketUrl(undefined), '/ws/voice', 'no location (Node) → relative default');
});

// ---------------------------------------------------------------------------
// VoiceSocketClient with a fake WebSocket
// ---------------------------------------------------------------------------

class FakeWebSocket implements VoiceWebSocketLike {
  readyState = 0;
  sent: (string | ArrayBufferLike | ArrayBufferView)[] = [];
  closed: { code?: number; reason?: string } | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;

  constructor(public url: string) {}

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    this.readyState = 3;
  }

  // Test helpers to simulate the server side.
  serverOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  serverText(raw: string): void {
    this.onmessage?.({ data: raw });
  }

  serverClose(code = 1006): void {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

interface Harness {
  client: VoiceSocketClient;
  sockets: FakeWebSocket[];
  events: { kind: string; [key: string]: unknown }[];
  closes: { code: number; wasOpen: boolean }[];
  dropped: string[];
}

function makeHarness(urlOverride?: string, token?: string): Harness {
  const h: Harness = { sockets: [], events: [], closes: [], dropped: [] };
  // Class (not arrow fn): `new VoiceSocketClient(...).dialStart()` invokes
  // the impl with `new`, and arrow functions are not constructable.
  class RecordedSocket extends FakeWebSocket {
    constructor(url: string) {
      super(url);
      h.sockets.push(this);
    }
  }
  h.client = new VoiceSocketClient({
    urlOverride,
    token,
    WebSocketImpl: RecordedSocket as unknown as new (url: string) => VoiceWebSocketLike,
    onEvent: (event) => h.events.push(event as { kind: string }),
    onOpen: () => h.events.push({ kind: '__open' }),
    onClose: (info) => h.closes.push(info),
    onDroppedFrame: (raw) => h.dropped.push(raw),
  });
  return h;
}

test('client: dialing sends the start frame on open; server events flow through', () => {
  const h = makeHarness('ws://stub/voice', 'tok-123');
  h.client.dialStart();
  assert.equal(h.sockets[0].url, 'ws://stub/voice?token=tok-123', 'token rides the query string');
  h.sockets[0].serverOpen();
  const sent = h.sockets[0].sent;
  assert.equal(sent.length, 1, 'open → exactly the start frame');
  const frame = JSON.parse(String(sent[0])) as Record<string, unknown>;
  assert.equal(frame.type, 'start');
  assert.equal(frame.protocol, VOICE_PROTOCOL_ID);

  h.sockets[0].serverText('{"type":"partial","text":"识别中"}');
  h.sockets[0].serverText('garbage-frame');
  assert.deepEqual(h.events, [{ kind: '__open' }, { kind: 'partial', text: '识别中' }]);
  assert.deepEqual(h.dropped, ['garbage-frame'], 'malformed frames are dropped and counted');
});

test('client: PCM bytes pass through binary; stop is a JSON text frame', () => {
  const h = makeHarness('ws://stub/voice');
  h.client.dialStart();
  h.sockets[0].serverOpen();
  const bytes = Uint8Array.from([1, 2, 3, 4]);
  assert.equal(h.client.sendPcm(bytes), true);
  h.client.sendStop();
  const sent = h.sockets[0].sent;
  assert.equal(sent.length, 3, 'start frame, PCM chunk, stop frame');
  assert.deepEqual(Array.from(sent[1] as Uint8Array), [1, 2, 3, 4], 'PCM rides as raw binary');
  assert.deepEqual(JSON.parse(String(sent[2])), { type: 'stop' });
});

test('client: sendPcm before open is a no-op returning false', () => {
  const h = makeHarness('ws://stub/voice');
  assert.equal(h.client.sendPcm(Uint8Array.from([9])), false);
});

test('client: server close surfaces as onClose with the code', () => {
  const h = makeHarness('ws://stub/voice');
  h.client.dialStart();
  h.sockets[0].serverOpen();
  h.sockets[0].serverClose(1011);
  assert.deepEqual(h.closes, [{ code: 1011, wasOpen: true }]);
});

test('client: our own close() tears down silently and ignores late server closes', () => {
  const h = makeHarness('ws://stub/voice');
  h.client.dialStart();
  h.sockets[0].serverOpen();
  h.client.close();
  assert.equal(h.sockets[0].closed?.code, 1000, 'clean client close');
  h.sockets[0].serverClose(1006); // late event must not fire onClose again
  assert.deepEqual(h.closes, [], 'no onClose after our own close');
  assert.equal(h.client.isOpen, false);
});
