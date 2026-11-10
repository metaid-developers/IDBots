// Voice button state machine unit tests (voice P1: hold to send).
//
// Exhaustive transition coverage for the PURE reducer in
// src/mobile/app/voice/voiceButtonState.ts, including the idempotency
// guarantee (out-of-phase events are no-ops, reset always works), the two
// interaction modes (hold vs the a11y tap fallback) and the overlay variant
// mapping.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  reduceVoiceUi,
  voiceOverlayVariant,
  voicePhaseTestid,
  VOICE_UI_INITIAL,
  type VoiceUiState,
} from '../src/mobile/app/voice/voiceButtonState.ts';

const happyPath = (state: VoiceUiState): VoiceUiState =>
  reduceVoiceUi(reduceVoiceUi(reduceVoiceUi(state, { type: 'tapStart' }), { type: 'micGranted' }), { type: 'socketReady' });

const holdPath = (state: VoiceUiState): VoiceUiState =>
  reduceVoiceUi(
    reduceVoiceUi(reduceVoiceUi(state, { type: 'holdStart' }), { type: 'micGranted' }),
    { type: 'socketReady' },
  );

test('tap happy path: idle -> requestingMic -> connecting -> recording -> stopping -> idle', () => {
  let s = VOICE_UI_INITIAL;
  s = reduceVoiceUi(s, { type: 'tapStart' });
  assert.deepEqual(s, { phase: 'requestingMic', mode: 'tap', errorCode: null, keptText: false });
  s = reduceVoiceUi(s, { type: 'micGranted' });
  assert.equal(s.phase, 'connecting');
  s = reduceVoiceUi(s, { type: 'socketReady' });
  assert.equal(s.phase, 'recording');
  s = reduceVoiceUi(s, { type: 'tapStop' });
  assert.equal(s.phase, 'stopping');
  s = reduceVoiceUi(s, { type: 'sessionDone', keptText: true });
  assert.deepEqual(s, { phase: 'idle', mode: 'hold', errorCode: null, keptText: true });
});

test('hold happy path: pointerdown enters requestingMic with mode hold', () => {
  let s = reduceVoiceUi(VOICE_UI_INITIAL, { type: 'holdStart' });
  assert.deepEqual(s, { phase: 'requestingMic', mode: 'hold', errorCode: null, keptText: false });
  s = reduceVoiceUi(s, { type: 'micGranted' });
  s = reduceVoiceUi(s, { type: 'socketReady' });
  assert.equal(s.phase, 'recording');
  assert.equal(s.mode, 'hold');
  s = reduceVoiceUi(s, { type: 'holdStop' });
  assert.equal(s.phase, 'stopping', 'release starts the recognizing wait');
  s = reduceVoiceUi(s, { type: 'sessionDone', keptText: true });
  assert.equal(s.phase, 'idle');
});

test('holdStart is ignored while a session is already active (no double start)', () => {
  const recording = holdPath(VOICE_UI_INITIAL);
  assert.equal(reduceVoiceUi(recording, { type: 'holdStart' }).phase, 'recording');
  const requesting = reduceVoiceUi(VOICE_UI_INITIAL, { type: 'holdStart' });
  assert.equal(reduceVoiceUi(requesting, { type: 'holdStart' }).phase, 'requestingMic');
});

test('holdStop only applies to hold sessions; tap mode ignores it', () => {
  const tapRecording = happyPath(VOICE_UI_INITIAL);
  assert.equal(reduceVoiceUi(tapRecording, { type: 'holdStop' }).phase, 'recording');
  const holdRecording = holdPath(VOICE_UI_INITIAL);
  assert.equal(reduceVoiceUi(holdRecording, { type: 'holdStop' }).phase, 'stopping');
});

test('holdCancel discards from every active phase and from error', () => {
  for (const phase of ['requestingMic', 'connecting', 'recording', 'stopping'] as const) {
    const state: VoiceUiState = { phase, mode: 'hold', errorCode: null, keptText: false };
    assert.deepEqual(reduceVoiceUi(state, { type: 'holdCancel' }), VOICE_UI_INITIAL, phase);
  }
  const errored: VoiceUiState = { phase: 'error', mode: 'hold', errorCode: 'mic_denied', keptText: false };
  assert.deepEqual(reduceVoiceUi(errored, { type: 'holdCancel' }), VOICE_UI_INITIAL);
});

test('tap toggle: tapping the mic while recording moves straight to stopping', () => {
  const recording = happyPath(VOICE_UI_INITIAL);
  const s = reduceVoiceUi(recording, { type: 'tapStart' });
  assert.equal(s.phase, 'stopping', 'second tap = stop');
});

test('tapStop works from requestingMic and connecting too (early cancel)', () => {
  const requesting = reduceVoiceUi(VOICE_UI_INITIAL, { type: 'tapStart' });
  assert.equal(reduceVoiceUi(requesting, { type: 'tapStop' }).phase, 'stopping');
  const connecting = reduceVoiceUi(requesting, { type: 'micGranted' });
  assert.equal(reduceVoiceUi(connecting, { type: 'tapStop' }).phase, 'stopping');
});

test('mic_denied lands in error with the right code (from requestingMic)', () => {
  const requesting = reduceVoiceUi(VOICE_UI_INITIAL, { type: 'tapStart' });
  const s = reduceVoiceUi(requesting, { type: 'micDenied' });
  assert.deepEqual(s, { phase: 'error', mode: 'tap', errorCode: 'mic_denied', keptText: false });
  const dismissed = reduceVoiceUi(s, { type: 'dismissError' });
  assert.deepEqual(dismissed, VOICE_UI_INITIAL, 'dismiss returns to a clean idle');
});

test('hold mic_denied keeps mode hold so the overlay shows the error card', () => {
  const requesting = reduceVoiceUi(VOICE_UI_INITIAL, { type: 'holdStart' });
  const s = reduceVoiceUi(requesting, { type: 'micDenied' });
  assert.equal(s.phase, 'error');
  assert.equal(s.mode, 'hold');
});

test('mic_timeout only fires while the mic request is actually pending', () => {
  const requesting = reduceVoiceUi(VOICE_UI_INITIAL, { type: 'tapStart' });
  assert.equal(reduceVoiceUi(requesting, { type: 'micTimeout' }).errorCode, 'mic_timeout');
  assert.equal(reduceVoiceUi(VOICE_UI_INITIAL, { type: 'micTimeout' }).phase, 'idle', 'idle: no-op');
});

test('socketReady is ignored outside connecting', () => {
  const requesting = reduceVoiceUi(VOICE_UI_INITIAL, { type: 'tapStart' });
  assert.equal(reduceVoiceUi(requesting, { type: 'socketReady' }).phase, 'requestingMic');
  assert.equal(reduceVoiceUi(VOICE_UI_INITIAL, { type: 'socketReady' }).phase, 'idle');
});

test('connect_timeout: server never acks -> error, no text kept', () => {
  const connecting = reduceVoiceUi(reduceVoiceUi(VOICE_UI_INITIAL, { type: 'tapStart' }), { type: 'micGranted' });
  const s = reduceVoiceUi(connecting, { type: 'socketError', code: 'connect_timeout' });
  assert.deepEqual(s, { phase: 'error', mode: 'tap', errorCode: 'connect_timeout', keptText: false });
});

test('connection_lost while recording keeps the accumulated text', () => {
  const recording = happyPath(VOICE_UI_INITIAL);
  const s = reduceVoiceUi(recording, { type: 'socketError', code: 'connection_lost' });
  assert.deepEqual(s, { phase: 'error', mode: 'tap', errorCode: 'connection_lost', keptText: true });
});

test('server error while stopping also keeps text', () => {
  const stopping = reduceVoiceUi(happyPath(VOICE_UI_INITIAL), { type: 'tapStop' });
  const s = reduceVoiceUi(stopping, { type: 'socketError', code: 'server:quota_exceeded' });
  assert.equal(s.errorCode, 'server:quota_exceeded');
  assert.equal(s.keptText, true);
});

test('socketError from idle is a no-op (nothing to fail)', () => {
  assert.equal(reduceVoiceUi(VOICE_UI_INITIAL, { type: 'socketError', code: 'connection_lost' }).phase, 'idle');
});

test('unsupported capability fails cleanly from idle', () => {
  const s = reduceVoiceUi(VOICE_UI_INITIAL, { type: 'unsupported' });
  assert.deepEqual(s, { phase: 'error', mode: 'hold', errorCode: 'unsupported', keptText: false });
});

test('interrupted (lock screen / call) moves recording into stopping', () => {
  const recording = happyPath(VOICE_UI_INITIAL);
  assert.equal(reduceVoiceUi(recording, { type: 'interrupted' }).phase, 'stopping');
  const connecting = reduceVoiceUi(reduceVoiceUi(VOICE_UI_INITIAL, { type: 'tapStart' }), { type: 'micGranted' });
  assert.equal(reduceVoiceUi(connecting, { type: 'interrupted' }).phase, 'stopping');
  assert.equal(reduceVoiceUi(VOICE_UI_INITIAL, { type: 'interrupted' }).phase, 'idle', 'idle: no-op');
});

test('sessionDone from recording/connecting also resolves (finalize races)', () => {
  const recording = happyPath(VOICE_UI_INITIAL);
  const s = reduceVoiceUi(recording, { type: 'sessionDone', keptText: false });
  assert.deepEqual(s, { phase: 'idle', mode: 'hold', errorCode: null, keptText: false });
});

test('reset always returns to the initial state from every phase and mode', () => {
  for (const phase of ['requestingMic', 'connecting', 'recording', 'stopping', 'error'] as const) {
    for (const mode of ['hold', 'tap'] as const) {
      const state: VoiceUiState = {
        phase,
        mode,
        errorCode: phase === 'error' ? 'mic_denied' : null,
        keptText: false,
      };
      assert.deepEqual(reduceVoiceUi(state, { type: 'reset' }), VOICE_UI_INITIAL, `${mode}/${phase}`);
    }
  }
});

test('error phase ignores tapStart until dismissed (card owns dismissal)', () => {
  const errored = reduceVoiceUi(VOICE_UI_INITIAL, { type: 'unsupported' });
  assert.equal(reduceVoiceUi(errored, { type: 'tapStart' }).phase, 'error');
});

test('voicePhaseTestid follows the phase (e2e selectors)', () => {
  assert.equal(voicePhaseTestid(VOICE_UI_INITIAL), 'voice-btn-idle');
  assert.equal(
    voicePhaseTestid({ phase: 'recording', mode: 'hold', errorCode: null, keptText: false }),
    'voice-btn-recording',
  );
});

// ---------------------------------------------------------------------------
// Overlay variant mapping (data-testid source for the three overlay states)
// ---------------------------------------------------------------------------

test('voiceOverlayVariant: hold phases map to recording / recognizing / error', () => {
  const hold = (phase: VoiceUiState['phase'], errorCode: VoiceUiState['errorCode'] = null): VoiceUiState =>
    ({ phase, mode: 'hold', errorCode, keptText: false });
  assert.equal(voiceOverlayVariant(hold('requestingMic'), false), 'recording');
  assert.equal(voiceOverlayVariant(hold('connecting'), false), 'recording');
  assert.equal(voiceOverlayVariant(hold('recording'), false), 'recording');
  assert.equal(voiceOverlayVariant(hold('stopping'), false), 'recognizing');
  assert.equal(voiceOverlayVariant(hold('error', 'mic_denied'), false), 'error');
  assert.equal(voiceOverlayVariant(VOICE_UI_INITIAL, false), null);
});

test('voiceOverlayVariant: swipe-up arms the cancel variant while still pressed', () => {
  const recording: VoiceUiState = { phase: 'recording', mode: 'hold', errorCode: null, keptText: false };
  assert.equal(voiceOverlayVariant(recording, true), 'cancel');
  assert.equal(voiceOverlayVariant(recording, false), 'recording');
});

test('voiceOverlayVariant: tap mode never renders the hold overlay', () => {
  const tapRecording: VoiceUiState = { phase: 'recording', mode: 'tap', errorCode: null, keptText: false };
  assert.equal(voiceOverlayVariant(tapRecording, false), null);
});
