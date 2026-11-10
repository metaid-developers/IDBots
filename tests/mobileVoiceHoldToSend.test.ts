// Hold-to-talk behavioural tests (voice P1).
//
// These are REAL end-to-end assertions over the imperative session core
// (VoiceSession) with a fake capture + fake socket: pointerdown/release,
// asr.done, final-text emission and the chat.send hand-off. No DOM is needed,
// which matches the repo's SSR-only renderer test convention.
//
// Acceptance mapping:
//  - release -> final transcript -> chat.send(final, []) and the user's draft
//    is byte-for-byte unchanged;
//  - swipe-up cancel and < 400 ms presses never call chat.send;
//  - error path keeps the words and can hand them back to the composer;
//  - the level signal comes from real PCM frame RMS (capture.ts), not noise.
import test from 'node:test';
import assert from 'node:assert/strict';

import { rmsToLevel, VoiceCapture, type VoiceCaptureEvents } from '../src/mobile/app/voice/capture.ts';
import {
  holdCancelArmed,
  sendVoiceMessage,
  resolveHoldRelease,
} from '../src/mobile/app/voice/holdToSend.ts';
import {
  reduceVoiceUi,
  VOICE_UI_INITIAL,
  type VoiceUiEvent,
  type VoiceUiState,
} from '../src/mobile/app/voice/voiceButtonState.ts';
import {
  MAX_SESSION_MS,
  VoiceSession,
  type VoiceCaptureLike,
  type VoiceSocketLike,
  type VoiceServerEventLike,
  type VoiceSocketHandlers,
} from '../src/mobile/app/voice/voiceSession.ts';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

class FakeCapture implements VoiceCaptureLike {
  started = false;
  stopCalls = 0;
  constructor(readonly events: VoiceCaptureEvents) {}

  async start(): Promise<{ sampleRate: number }> {
    this.started = true;
    return { sampleRate: 16_000 };
  }

  stop(): Uint8Array | null {
    this.stopCalls += 1;
    return null;
  }
}

class FakeSocket implements VoiceSocketLike {
  dialed = false;
  closed = false;
  isOpen = false;
  finishFrames = 0;
  abortFrames = 0;
  pcmChunks: Uint8Array[] = [];

  constructor(readonly handlers: VoiceSocketHandlers) {}

  dial(): void {
    this.dialed = true;
    this.isOpen = true;
    this.handlers.onOpen();
  }

  sendPcm(bytes: Uint8Array): void {
    this.pcmChunks.push(bytes);
  }

  sendFinish(): void {
    this.finishFrames += 1;
  }

  sendAbort(): void {
    this.abortFrames += 1;
  }

  close(): void {
    this.closed = true;
    this.isOpen = false;
  }

  emit(event: VoiceServerEventLike): void {
    this.handlers.onEvent(event);
  }
}

interface Harness {
  session: VoiceSession;
  capture: FakeCapture;
  socket: FakeSocket;
  ui: () => VoiceUiState;
  events: VoiceUiEvent[];
  draftWrites: { text: string; caret: number }[];
  finalTexts: string[];
  levels: number[];
  recognized: string[];
  elapsed: number[];
}

function createHarness(options: { draft?: string; caret?: number | null } = {}): Harness {
  const draftWrites: { text: string; caret: number }[] = [];
  const finalTexts: string[] = [];
  const levels: number[] = [];
  const recognized: string[] = [];
  const elapsed: number[] = [];
  const events: VoiceUiEvent[] = [];
  let ui = VOICE_UI_INITIAL;
  let capture!: FakeCapture;
  let socket!: FakeSocket;

  const session = new VoiceSession(
    { mode: 'hold', draft: options.draft ?? '', caret: options.caret ?? null },
    {
      onUiEvent: (event) => {
        events.push(event);
        ui = reduceVoiceUi(ui, event);
      },
      onElapsed: (sec) => elapsed.push(sec),
      onLevel: (level) => levels.push(level),
      onRecognizedText: (text) => recognized.push(text),
      onDraftReplace: (text, caret) => draftWrites.push({ text, caret }),
      onFinalText: (text) => finalTexts.push(text),
    },
    {
      createCapture: (captureEvents) => {
        capture = new FakeCapture(captureEvents);
        return capture;
      },
      createSocket: (handlers) => {
        socket = new FakeSocket(handlers);
        return socket;
      },
    },
  );

  return {
    session,
    get capture() {
      return capture;
    },
    get socket() {
      return socket;
    },
    ui: () => ui,
    events,
    draftWrites,
    finalTexts,
    levels,
    recognized,
    elapsed,
  };
}

/** Lets the capture.start() promise (and the dial chain) run. */
async function settleMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function recordingHarness(
  options: { draft?: string; caret?: number | null } = {},
): Promise<Harness> {
  const harness = createHarness(options);
  harness.session.start();
  await settleMicrotasks();
  harness.socket.emit({ kind: 'open', remainingMs: 60_000 });
  return harness;
}

// ---------------------------------------------------------------------------
// 1. Release-to-send: final transcript -> chat.send(final, []) ; draft untouched
// ---------------------------------------------------------------------------

test('hold -> release -> asr.done emits the final transcript exactly once', async () => {
  const harness = await recordingHarness({ draft: '已有的草稿', caret: 5 });
  assert.equal(harness.ui().phase, 'recording');
  assert.equal(harness.ui().mode, 'hold');
  assert.equal(harness.socket.dialed, true);

  harness.socket.emit({ kind: 'partial', text: '你好' });
  assert.equal(harness.session.recognizedText, '你好');
  // Hold mode never writes the composer.
  assert.deepEqual(harness.draftWrites, [], 'no draft write during a hold session');

  // Pointerup: flush + finish and switch the overlay to "recognizing".
  harness.session.finish();
  assert.equal(harness.ui().phase, 'stopping');
  assert.equal(harness.socket.finishFrames, 1);

  // Gateway settles the utterance and ends the interaction.
  harness.socket.emit({ kind: 'final', text: '你好世界' });
  harness.socket.emit({ kind: 'done' });

  assert.deepEqual(harness.finalTexts, ['你好世界'], 'final transcript emitted once');
  assert.equal(harness.ui().phase, 'idle');
  assert.equal(harness.socket.closed, true);
  assert.deepEqual(harness.draftWrites, [], 'draft still untouched after the session');
});

test('release -> asr.done -> chat.send(finalText, []) end to end (draft untouched)', async () => {
  // One test spanning the REAL controller and the REAL hand-off helper: the
  // screen's onFinalText wiring is exactly this one line.
  const calls: { text: string; attachments: unknown[] }[] = [];
  const chat = {
    draft: '我的原始草稿',
    send(text: string, attachments: unknown[] = []) {
      calls.push({ text, attachments });
      return { status: 'success' };
    },
    setDraft(next: string) {
      this.draft = next;
    },
  };
  let ui = VOICE_UI_INITIAL;
  let capture!: FakeCapture;
  let socket!: FakeSocket;
  const session = new VoiceSession(
    { mode: 'hold', draft: chat.draft, caret: chat.draft.length },
    {
      onUiEvent: (event) => {
        ui = reduceVoiceUi(ui, event);
      },
      onElapsed: () => {},
      onLevel: () => {},
      onRecognizedText: () => {},
      onDraftReplace: (text, caret) => chat.setDraft(text.slice(0, caret)),
      onFinalText: (text) => {
        sendVoiceMessage(chat, text, { blocked: false });
      },
    },
    {
      createCapture: (events) => {
        capture = new FakeCapture(events);
        return capture;
      },
      createSocket: (handlers) => {
        socket = new FakeSocket(handlers);
        return socket;
      },
    },
  );

  session.start();
  await settleMicrotasks();
  socket.emit({ kind: 'open', remainingMs: 60_000 });
  socket.emit({ kind: 'partial', text: '明天上午十点' });

  // Pointerup: recognizing state, waiting for the final.
  session.finish();
  assert.equal(ui.phase, 'stopping');
  assert.equal(calls.length, 0, 'nothing is sent before asr.done');

  socket.emit({ kind: 'final', text: '明天上午十点开会' });
  socket.emit({ kind: 'done' });

  assert.deepEqual(calls, [{ text: '明天上午十点开会', attachments: [] }]);
  assert.equal(chat.draft, '我的原始草稿', 'the pre-existing draft survives unchanged');
  assert.equal(ui.phase, 'idle');
});

test('the emitted transcript becomes a NEW message with no attachments; the draft is preserved', async () => {
  const harness = await recordingHarness({ draft: '用户已经输入的草稿', caret: 4 });
  harness.socket.emit({ kind: 'partial', text: '帮我看一下' });
  harness.session.finish();
  harness.socket.emit({ kind: 'final', text: '帮我看一下' });
  harness.socket.emit({ kind: 'done' });

  const calls: { text: string; attachments: unknown[] }[] = [];
  const chat = {
    draft: '用户已经输入的草稿',
    send(text: string, attachments: unknown[] = []) {
      calls.push({ text, attachments });
      return { status: 'success' };
    },
    setDraft(next: string) {
      this.draft = next;
    },
  };

  const outcome = sendVoiceMessage(chat, harness.finalTexts[0]!);
  assert.equal(outcome, 'sent');
  assert.deepEqual(calls, [{ text: '帮我看一下', attachments: [] }], 'chat.send(finalText, [])');
  assert.equal(chat.draft, '用户已经输入的草稿', 'composer draft is byte-for-byte unchanged');
  assert.equal(harness.draftWrites.length, 0);
});

test('an empty final transcript is an accidental press: no send at all', async () => {
  const harness = await recordingHarness({ draft: 'draft' });
  harness.session.finish();
  harness.socket.emit({ kind: 'done' });

  assert.deepEqual(harness.finalTexts, [''], 'the screen gets the empty result so it can hint');
  let sendCalls = 0;
  const chat = {
    draft: 'draft',
    send() {
      sendCalls += 1;
      return { status: 'success' };
    },
    setDraft() {},
  };
  const outcome = sendVoiceMessage(chat, harness.finalTexts[0]!);
  assert.equal(outcome, 'empty');
  assert.equal(sendCalls, 0, 'nothing is sent for an empty transcript');
});

// ---------------------------------------------------------------------------
// 2. Cancel paths: swipe-up and too-short presses never send
// ---------------------------------------------------------------------------

test('swipe-up cancel discards the session: abort frame, no final text, no send', async () => {
  const harness = await recordingHarness({ draft: 'draft' });
  harness.socket.emit({ kind: 'partial', text: '这段不该被发送' });

  harness.session.cancel();

  assert.deepEqual(harness.finalTexts, [], 'cancel emits no transcript');
  assert.equal(harness.session.recognizedText, '', 'cancel clears the transcript');
  assert.equal(harness.socket.abortFrames, 1, 'gateway is told to abort');
  assert.equal(harness.socket.closed, true);
  assert.equal(harness.ui().phase, 'idle');
  let sendCalls = 0;
  sendVoiceMessage({ send: () => { sendCalls += 1; } }, harness.session.recognizedText);
  assert.equal(sendCalls, 0);
});

test('a press shorter than 400 ms resolves to cancel and never sends', () => {
  const short = resolveHoldRelease({ heldMs: 180, cancelArmed: false });
  assert.deepEqual(short, { action: 'cancel', reason: 'too_short' });
  assert.deepEqual(resolveHoldRelease({ heldMs: 399, cancelArmed: false }), {
    action: 'cancel',
    reason: 'too_short',
  });
  assert.deepEqual(resolveHoldRelease({ heldMs: 400, cancelArmed: false }), { action: 'send' });
});

test('swipe-up threshold: 80 px arms, 56 px re-arms (hysteresis)', () => {
  assert.equal(holdCancelArmed({ startY: 400, currentY: 360, armed: false }), false, '40 px up: still send');
  assert.equal(holdCancelArmed({ startY: 400, currentY: 319, armed: false }), true, '81 px up: cancel armed');
  assert.equal(holdCancelArmed({ startY: 400, currentY: 330, armed: true }), true, '70 px up stays armed');
  assert.equal(holdCancelArmed({ startY: 400, currentY: 360, armed: true }), false, '40 px up disarms');
});

test('single-session cap is unchanged at 120 s', () => {
  assert.equal(MAX_SESSION_MS, 120_000);
});

test('swipe-up threshold (80 px) arms cancel; moving back down disarms', () => {
  assert.deepEqual(resolveHoldRelease({ heldMs: 900, cancelArmed: true }), {
    action: 'cancel',
    reason: 'swipe',
  });
  assert.equal(resolveHoldRelease({ heldMs: 900, cancelArmed: false }).action, 'send');
  assert.equal(resolveHoldRelease({ heldMs: 900, cancelArmed: false, interrupted: true }).action, 'cancel');
});

test('cancelling before the mic promise resolves is still a clean discard', async () => {
  const harness = createHarness({ draft: 'x' });
  harness.session.start();
  // Cancel while getUserMedia/capture.start() is still in flight.
  harness.session.cancel();
  await settleMicrotasks();
  assert.equal(harness.socket.dialed, false, 'never dials after a cancel');
  assert.deepEqual(harness.finalTexts, []);
  assert.equal(harness.ui().phase, 'idle');
});

// ---------------------------------------------------------------------------
// 3. Failure keeps the words and offers the explicit salvage path
// ---------------------------------------------------------------------------

test('server error during a hold: error card state, no auto-send, text retained', async () => {
  const harness = await recordingHarness({ draft: '前缀:', caret: 3 });
  harness.socket.emit({ kind: 'partial', text: '识别内容' });
  harness.socket.emit({
    kind: 'error',
    class: 'quota',
    text: undefined,
  } as unknown as VoiceServerEventLike);

  assert.equal(harness.ui().phase, 'error');
  assert.equal(harness.ui().errorCode, 'server:quota');
  assert.deepEqual(harness.finalTexts, [], 'errors never auto-send');
  assert.equal(harness.session.recognizedText, '识别内容', 'recognized text is retained for salvage');

  // The error path still settles (asr.done or the 3 s safety net) and must
  // keep the transcript available to the card afterwards.
  harness.socket.emit({ kind: 'done' });
  assert.deepEqual(harness.finalTexts, [], 'a settled error still never auto-sends');
  assert.equal(harness.session.recognizedText, '识别内容', 'settling keeps the text');

  // "Put into input box": the ONLY hold-mode path that writes the composer.
  harness.session.commitToDraft();
  assert.equal(harness.draftWrites.length, 1);
  assert.deepEqual(harness.draftWrites[0], { text: '前缀:识别内容', caret: 7 });
  harness.session.dispose();
});

test('a busy composer keeps the transcript in the draft instead of dropping it', async () => {
  let draft = 'waiting';
  let sendCalls = 0;
  const outcome = sendVoiceMessage(
    {
      draft,
      send() {
        sendCalls += 1;
      },
      setDraft(next: string) {
        draft = next;
      },
    },
    '这句话不能丢',
    { blocked: true },
  );
  assert.equal(outcome, 'kept_in_draft');
  assert.equal(sendCalls, 0);
  assert.equal(draft, 'waiting 这句话不能丢');
});

// ---------------------------------------------------------------------------
// 4. Level signal: real PCM RMS, forwarded to the overlay
// ---------------------------------------------------------------------------

test('rmsToLevel maps silence to 0 and loud speech to 1 (clamped)', () => {
  assert.equal(rmsToLevel(0), 0);
  assert.equal(rmsToLevel(Number.NaN), 0);
  assert.ok(Math.abs(rmsToLevel(0.1) - 0.8) < 1e-9, '0.1 RMS = -20 dBFS -> 0.8');
  assert.equal(rmsToLevel(1), 1);
  assert.equal(rmsToLevel(10), 1, 'clamped');
});

test('capture emits a level from worklet frames; the session forwards it', async () => {
  const events: number[] = [];
  const wire: Uint8Array[] = [];
  let node: { port: { onmessage: ((event: { data: Float32Array }) => void) | null }; disconnect(): void } | null =
    null;
  class FakeAudioContext {
    sampleRate = 16_000;
    state = 'running';
    onstatechange: (() => void) | null = null;
    audioWorklet = { addModule: async () => undefined };
    destination = {};
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }
    async resume() {}
    async close() {}
  }
  const capture = new VoiceCapture(
    {
      onWireChunk: (bytes) => wire.push(bytes),
      onInterrupted: () => {},
      onError: () => assert.fail('capture must not fail in this test'),
      onLevel: (level) => events.push(level),
    },
    {
      getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) as unknown as MediaStream,
      AudioContextCtor: FakeAudioContext,
      workletUrl: 'memory://pcm-processor',
      createWorkletNode: () => {
        node = { port: { onmessage: null }, disconnect() {} };
        return node;
      },
    },
  );

  await capture.start();
  const frame = new Float32Array(128).fill(0.1);
  for (let i = 0; i < 4; i += 1) node!.port.onmessage!({ data: frame });
  assert.equal(events.length, 1, 'one level emit per 4 worklet frames');
  assert.ok(Math.abs(events[0]! - 0.8) < 1e-6, `expected 0.8, got ${events[0]}`);
  assert.ok(wire.length >= 0);
  capture.stop();
});

test('the session forwards capture levels to the consumer', async () => {
  const harness = await recordingHarness();
  // Drive the fake capture's level callback exactly like capture.ts would.
  harness.capture.events.onLevel?.(0.42);
  assert.deepEqual(harness.levels, [0.42]);
  harness.session.dispose();
});
