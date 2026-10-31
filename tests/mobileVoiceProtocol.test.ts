// Voice WebSocket protocol + client unit tests (voice P0, subtask #10).
//
// protocol.ts is THE alignment point with the gateway. These tests pin the
// ASR channel v1 dialect (docs/cloud-mobile/voice/asr-channel.md) so any
// accidental drift fails loudly — endpoint/auth, frame shapes, event names,
// error/close-code classes and quota semantics are all covered here.
// The client tests use a fake WebSocket constructor (same
// Transport-abstraction pattern as mobileGatewayClient).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildVoiceSocketUrl,
  classifyVoiceClose,
  classifyVoiceErrorCode,
  decodeServerEvent,
  decodeVoiceQuota,
  encodeAbortFrame,
  encodeClientMessage,
  encodeFinishFrame,
  errorClassToCopyCode,
  isVoiceCopyCode,
  isVoiceQuotaExhausted,
  VOICE_CHANNEL_LIMITS,
  VOICE_CHUNK_BYTES,
  VOICE_PCM_FORMAT,
  VOICE_PROTOCOL_VERSION,
  VOICE_QUOTA_PATH,
  VOICE_SESSION_COOKIE,
  VOICE_WS_PATH,
  voiceQuotaRemainingMs,
} from '../src/mobile/app/voice/protocol.ts';
import { VoiceSocketClient, type VoiceWebSocketLike } from '../src/mobile/app/voice/voiceSocket.ts';

// ---------------------------------------------------------------------------
// protocol.ts — channel shape (doc sections 1 / 3 / 6)
// ---------------------------------------------------------------------------

test('channel constants match the frozen v1 document', () => {
  assert.equal(VOICE_PROTOCOL_VERSION, 'v1');
  assert.equal(VOICE_WS_PATH, '/asr/v1/ws', 'gateway mount point');
  assert.equal(VOICE_QUOTA_PATH, '/api/v1/asr/quota', 'quota preflight read API');
  assert.equal(VOICE_SESSION_COOKIE, 'idb_session', 'same session as /api/v1');
  assert.deepEqual(
    { ...VOICE_PCM_FORMAT },
    { sampleRate: 16000, encoding: 's16le', channels: 1, bytesPerSample: 2 },
  );
  // 100 ms and 200 ms of 16 kHz mono s16le are exactly the doc's byte range.
  assert.equal(VOICE_CHUNK_BYTES.min, 16000 * 0.1 * 2);
  assert.equal(VOICE_CHUNK_BYTES.max, 16000 * 0.2 * 2);
  assert.equal(VOICE_CHANNEL_LIMITS.dailyFreeMinutes, 60);
  assert.equal(VOICE_CHANNEL_LIMITS.maxSessionSeconds, 600);
  assert.equal(VOICE_CHANNEL_LIMITS.bufferedChunks, 64);
});

test('buildVoiceSocketUrl: production default is the same-origin v1 path', () => {
  const original = globalThis.location;
  try {
    Object.defineProperty(globalThis, 'location', {
      value: { origin: 'https://tenant.example', protocol: 'https:', host: 'tenant.example' },
      configurable: true,
    });
    assert.equal(buildVoiceSocketUrl(), 'wss://tenant.example/asr/v1/ws');
    // The dev/e2e override wins verbatim and carries NO token (cookie auth).
    assert.equal(buildVoiceSocketUrl('ws://127.0.0.1:8791'), 'ws://127.0.0.1:8791');
    assert.equal(buildVoiceSocketUrl('   '), 'wss://tenant.example/asr/v1/ws', 'blank override ignored');
  } finally {
    if (original === undefined) {
      delete (globalThis as { location?: unknown }).location;
    } else {
      Object.defineProperty(globalThis, 'location', { value: original, configurable: true });
    }
  }
  // Node/test fallback: relative path, still no token.
  assert.equal(buildVoiceSocketUrl(undefined), VOICE_WS_PATH);
});

test('client control frames: finish and abort are the only two', () => {
  assert.deepEqual(JSON.parse(encodeFinishFrame()), { type: 'finish' });
  assert.deepEqual(JSON.parse(encodeAbortFrame()), { type: 'abort' });
  assert.deepEqual(JSON.parse(encodeClientMessage({ type: 'finish' })), { type: 'finish' });
  assert.deepEqual(JSON.parse(encodeClientMessage({ type: 'abort' })), { type: 'abort' });
});

// ---------------------------------------------------------------------------
// protocol.ts — server events (doc section 4)
// ---------------------------------------------------------------------------

test('decodeServerEvent: asr.open carries the per-connection budget', () => {
  assert.deepEqual(decodeServerEvent('{"type":"asr.open","sessionId":"stub-1","remainingMs":3599870}'), {
    kind: 'open',
    sessionId: 'stub-1',
    remainingMs: 3599870,
  });
  // Missing optional fields stay undefined rather than failing the frame.
  assert.deepEqual(decodeServerEvent('{"type":"asr.open"}'), {
    kind: 'open',
    sessionId: undefined,
    remainingMs: undefined,
  });
});

test('decodeServerEvent: partial and final both require text', () => {
  assert.deepEqual(decodeServerEvent('{"type":"asr.partial","text":"今天天"}'), { kind: 'partial', text: '今天天' });
  assert.deepEqual(decodeServerEvent('{"type":"asr.final","text":"今天天气怎么样？"}'), {
    kind: 'final',
    text: '今天天气怎么样？',
  });
  assert.equal(decodeServerEvent('{"type":"asr.partial"}'), null);
  assert.equal(decodeServerEvent('{"type":"asr.final","text":42}'), null);
});

test('decodeServerEvent: asr.done carries usage and the remaining budget', () => {
  assert.deepEqual(
    decodeServerEvent('{"type":"asr.done","usageSeconds":3.2,"remainingMs":3596870,"upstreamDurationMs":3200}'),
    { kind: 'done', usageSeconds: 3.2, remainingMs: 3596870, upstreamDurationMs: 3200 },
  );
  assert.deepEqual(decodeServerEvent('{"type":"asr.done"}'), {
    kind: 'done',
    usageSeconds: undefined,
    remainingMs: undefined,
    upstreamDurationMs: undefined,
  });
});

test('decodeServerEvent: UPSTREAM_LOST is a self-healing event, not a terminal error', () => {
  assert.deepEqual(
    decodeServerEvent('{"type":"asr.error","code":"UPSTREAM_LOST","message":"upstream reset","retryable":true}'),
    { kind: 'upstream_lost', message: 'upstream reset' },
  );
});

test('decodeServerEvent: terminal errors keep the raw code and expose a behaviour class', () => {
  assert.deepEqual(decodeServerEvent('{"type":"asr.error","code":"QUOTA_EXHAUSTED","message":"no minutes"}'), {
    kind: 'error',
    rawCode: 'QUOTA_EXHAUSTED',
    class: 'quota',
    message: 'no minutes',
    retryable: false,
  });
  assert.deepEqual(decodeServerEvent('{"type":"asr.error","code":"SESSION_CAP","retryable":false}'), {
    kind: 'error',
    rawCode: 'SESSION_CAP',
    class: 'session_cap',
    message: undefined,
    retryable: false,
  });
  // Provider/stub codes are prefix-classified, raw code preserved for logs.
  assert.equal(
    (decodeServerEvent('{"type":"asr.error","code":"DOUBAO_45000001"}') as { class: string }).class,
    'provider',
  );
  assert.equal(
    (decodeServerEvent('{"type":"asr.error","code":"STUB_DISCONNECT"}') as { class: string }).class,
    'stub',
  );
});

test('decodeServerEvent: garbage, foreign and unknown frames return null (never crash the UI)', () => {
  assert.equal(decodeServerEvent('not json'), null);
  assert.equal(decodeServerEvent('42'), null);
  assert.equal(decodeServerEvent('null'), null);
  assert.equal(decodeServerEvent('{"type":"mystery"}'), null);
  assert.equal(decodeServerEvent('{"noType":true}'), null);
  // The draft-v0 dialect is NOT silently accepted: it is a different channel.
  assert.equal(decodeServerEvent('{"type":"ready"}'), null);
  assert.equal(decodeServerEvent('{"type":"end"}'), null);
  assert.equal(decodeServerEvent('{"type":"error","code":"quota_exceeded"}'), null);
  assert.equal(decodeServerEvent('{"type":"asr.error"}'), null, 'error without code is invalid');
});

test('classifyVoiceErrorCode: full table', () => {
  assert.equal(classifyVoiceErrorCode('UPSTREAM_LOST'), 'upstream');
  assert.equal(classifyVoiceErrorCode('QUOTA_EXHAUSTED'), 'quota');
  assert.equal(classifyVoiceErrorCode('SESSION_CAP'), 'session_cap');
  assert.equal(classifyVoiceErrorCode('DOUBAO_45000001'), 'provider');
  assert.equal(classifyVoiceErrorCode('STUB_DELAY'), 'stub');
  assert.equal(classifyVoiceErrorCode('warp_core_breach'), 'unknown');
});

// ---------------------------------------------------------------------------
// protocol.ts — close codes (doc section 5)
// ---------------------------------------------------------------------------

test('classifyVoiceClose: 41xx table matches the documented frontend action', () => {
  assert.deepEqual(classifyVoiceClose(1000), { action: 'none' });
  assert.deepEqual(classifyVoiceClose(4101), { action: 'fail', class: 'unauthorized' });
  assert.deepEqual(classifyVoiceClose(4103), { action: 'fail', class: 'protocol' });
  assert.deepEqual(classifyVoiceClose(4105), { action: 'fail', class: 'upstream' });
  assert.deepEqual(classifyVoiceClose(4106), { action: 'fail', class: 'protocol' });
  assert.deepEqual(classifyVoiceClose(1011), { action: 'reconnect', class: 'upstream' });
  assert.deepEqual(classifyVoiceClose(1006), { action: 'reconnect', class: 'upstream' });
  assert.deepEqual(classifyVoiceClose(4000), { action: 'fail', class: 'unknown' });
});

test('classifyVoiceClose: 4104 is disambiguated by the preceding asr.error', () => {
  // Daily quota gone: the conservative reading (never silently re-dial).
  assert.deepEqual(classifyVoiceClose(4104), { action: 'fail', class: 'quota' });
  assert.deepEqual(classifyVoiceClose(4104, 'quota'), { action: 'fail', class: 'quota' });
  // Per-session cap with quota remaining: a fresh connection is allowed.
  assert.deepEqual(classifyVoiceClose(4104, 'session_cap'), { action: 'reconnect', class: 'session_cap' });
});

test('errorClassToCopyCode: every class lands on an existing i18n suffix', () => {
  assert.equal(errorClassToCopyCode('unauthorized'), 'unauthorized');
  assert.equal(errorClassToCopyCode('quota'), 'quota');
  assert.equal(errorClassToCopyCode('session_cap'), 'sessionCap');
  assert.equal(errorClassToCopyCode('upstream'), 'upstream');
  assert.equal(errorClassToCopyCode('provider'), 'upstream');
  assert.equal(errorClassToCopyCode('stub'), 'upstream');
  assert.equal(errorClassToCopyCode('protocol'), 'generic');
  assert.equal(errorClassToCopyCode('unknown'), 'generic');
  assert.equal(isVoiceCopyCode('sessionCap'), true);
  assert.equal(isVoiceCopyCode('busy'), false, 'draft-v0 copy codes are gone');
});

// ---------------------------------------------------------------------------
// protocol.ts — quota preflight (doc sections 1 / 6)
// ---------------------------------------------------------------------------

test('decodeVoiceQuota: reads the REST payload and tolerates extra fields', () => {
  const quota = decodeVoiceQuota({
    limitMinutes: 60,
    limitSeconds: 3600,
    usedSeconds: 12.5,
    remainingSeconds: 3587.5,
    dayStartMs: 1793376000000,
    timezone: 'Asia/Shanghai',
    upstream: 'doubao',
    unknownField: 'ignored',
  });
  assert.deepEqual(quota, {
    limitMinutes: 60,
    limitSeconds: 3600,
    usedSeconds: 12.5,
    remainingSeconds: 3587.5,
    dayStartMs: 1793376000000,
    timezone: 'Asia/Shanghai',
    upstream: 'doubao',
  });
  assert.equal(decodeVoiceQuota(null), null);
  assert.equal(decodeVoiceQuota('nope'), null);
  assert.equal(decodeVoiceQuota({}), null, 'no known field => not a quota payload');
});

test('quota helpers: exhaustion and remaining budget', () => {
  assert.equal(isVoiceQuotaExhausted({ remainingSeconds: 0 }), true);
  assert.equal(isVoiceQuotaExhausted({ remainingSeconds: -1 }), true);
  assert.equal(isVoiceQuotaExhausted({ remainingSeconds: 30 }), false);
  assert.equal(isVoiceQuotaExhausted({}), false, 'unknown is not exhausted');
  assert.equal(voiceQuotaRemainingMs({ remainingSeconds: 12.5 }), 12500);
  assert.equal(voiceQuotaRemainingMs({ remainingSeconds: -3 }), 0);
  assert.equal(voiceQuotaRemainingMs({}), undefined);
});

// ---------------------------------------------------------------------------
// voiceSocket.ts — client behaviour with a fake WebSocket
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

function makeHarness(urlOverride?: string): Harness {
  const h: Harness = { sockets: [], events: [], closes: [], dropped: [] };
  // Class (not arrow fn): `new VoiceSocketClient(...).dial()` invokes the impl
  // with `new`, and arrow functions are not constructable.
  class RecordedSocket extends FakeWebSocket {
    constructor(url: string) {
      super(url);
      h.sockets.push(this);
    }
  }
  h.client = new VoiceSocketClient({
    urlOverride,
    WebSocketImpl: RecordedSocket as unknown as new (url: string) => VoiceWebSocketLike,
    onEvent: (event) => h.events.push(event as { kind: string }),
    onOpen: () => h.events.push({ kind: '__open' }),
    onClose: (info) => h.closes.push(info),
    onDroppedFrame: (raw) => h.dropped.push(raw),
  });
  return h;
}

test('client: dialing sends NO start frame — v1 has no client handshake', () => {
  const h = makeHarness('ws://stub/voice');
  h.client.dial();
  assert.equal(h.sockets[0].url, 'ws://stub/voice', 'no token in the URL');
  h.sockets[0].serverOpen();
  assert.equal(h.sockets[0].sent.length, 0, 'open alone writes nothing to the wire');
  assert.deepEqual(h.events, [{ kind: '__open' }]);
});

test('client: gateway events flow through and malformed frames are dropped', () => {
  const h = makeHarness('ws://stub/voice');
  h.client.dial();
  h.sockets[0].serverOpen();
  h.sockets[0].serverText('{"type":"asr.open","sessionId":"s1","remainingMs":3599870}');
  h.sockets[0].serverText('{"type":"asr.partial","text":"今天"}');
  h.sockets[0].serverText('garbage-frame');
  h.sockets[0].serverText('{"type":"ready"}'); // draft-v0 frame
  assert.deepEqual(h.events, [
    { kind: '__open' },
    { kind: 'open', sessionId: 's1', remainingMs: 3599870 },
    { kind: 'partial', text: '今天' },
  ]);
  assert.deepEqual(h.dropped, ['garbage-frame', '{"type":"ready"}']);
});

test('client: PCM rides as binary, finish/abort are JSON text frames', () => {
  const h = makeHarness('ws://stub/voice');
  h.client.dial();
  h.sockets[0].serverOpen();
  assert.equal(h.client.sendPcm(Uint8Array.from([1, 2, 3, 4])), true);
  h.client.sendFinish();
  h.client.sendAbort();
  const sent = h.sockets[0].sent;
  assert.equal(sent.length, 3, 'PCM chunk, finish frame, abort frame');
  assert.deepEqual(Array.from(sent[0] as Uint8Array), [1, 2, 3, 4], 'PCM rides raw');
  assert.deepEqual(JSON.parse(String(sent[1])), { type: 'finish' });
  assert.deepEqual(JSON.parse(String(sent[2])), { type: 'abort' });
});

test('client: empty PCM chunks are skipped; pre-open sends are no-ops', () => {
  const h = makeHarness('ws://stub/voice');
  assert.equal(h.client.sendPcm(Uint8Array.from([9])), false, 'not open yet');
  h.client.dial();
  h.sockets[0].serverOpen();
  assert.equal(h.client.sendPcm(new Uint8Array(0)), false, 'empty chunk ignored');
  assert.equal(h.sockets[0].sent.length, 0);
});

test('client: server close surfaces as onClose with the raw code', () => {
  const h = makeHarness('ws://stub/voice');
  h.client.dial();
  h.sockets[0].serverOpen();
  h.sockets[0].serverClose(4104);
  assert.deepEqual(h.closes, [{ code: 4104, wasOpen: true }]);
});

test('client: our own close() tears down silently and ignores late server closes', () => {
  const h = makeHarness('ws://stub/voice');
  h.client.dial();
  h.sockets[0].serverOpen();
  h.client.close();
  assert.equal(h.sockets[0].closed?.code, 1000, 'clean client close');
  h.sockets[0].serverClose(1006); // late event must not fire onClose again
  assert.deepEqual(h.closes, [], 'no onClose after our own close');
  assert.equal(h.client.isOpen, false);
});
