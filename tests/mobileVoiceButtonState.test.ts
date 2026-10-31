// Voice button state machine unit tests (voice P0, subtask #10).
//
// Exhaustive transition coverage for the PURE reducer in
// src/mobile/app/voice/voiceButtonState.ts, including the idempotency
// guarantee (out-of-phase events are no-ops, reset always works).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  reduceVoiceUi,
  voicePhaseTestid,
  VOICE_UI_INITIAL,
  type VoiceUiState,
} from '../src/mobile/app/voice/voiceButtonState.ts';

const happyPath = (state: VoiceUiState): VoiceUiState =>
  reduceVoiceUi(reduceVoiceUi(reduceVoiceUi(state, { type: 'tapStart' }), { type: 'micGranted' }), { type: 'socketReady' });

test('happy path: idle → requestingMic → connecting → recording → stopping → idle', () => {
  let s = VOICE_UI_INITIAL;
  s = reduceVoiceUi(s, { type: 'tapStart' });
  assert.deepEqual(s, { phase: 'requestingMic', errorCode: null, keptText: false });
  s = reduceVoiceUi(s, { type: 'micGranted' });
  assert.equal(s.phase, 'connecting');
  s = reduceVoiceUi(s, { type: 'socketReady' });
  assert.equal(s.phase, 'recording');
  s = reduceVoiceUi(s, { type: 'tapStop' });
  assert.equal(s.phase, 'stopping');
  s = reduceVoiceUi(s, { type: 'sessionDone', keptText: true });
  assert.deepEqual(s, { phase: 'idle', errorCode: null, keptText: true });
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
  assert.deepEqual(s, { phase: 'error', errorCode: 'mic_denied', keptText: false });
  const dismissed = reduceVoiceUi(s, { type: 'dismissError' });
  assert.deepEqual(dismissed, VOICE_UI_INITIAL, 'dismiss returns to a clean idle');
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

test('connect_timeout: server never acks → error, no text kept', () => {
  const connecting = reduceVoiceUi(reduceVoiceUi(VOICE_UI_INITIAL, { type: 'tapStart' }), { type: 'micGranted' });
  const s = reduceVoiceUi(connecting, { type: 'socketError', code: 'connect_timeout' });
  assert.deepEqual(s, { phase: 'error', errorCode: 'connect_timeout', keptText: false });
});

test('connection_lost while recording keeps the accumulated text', () => {
  const recording = happyPath(VOICE_UI_INITIAL);
  const s = reduceVoiceUi(recording, { type: 'socketError', code: 'connection_lost' });
  assert.deepEqual(s, { phase: 'error', errorCode: 'connection_lost', keptText: true });
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
  assert.deepEqual(s, { phase: 'error', errorCode: 'unsupported', keptText: false });
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
  assert.deepEqual(s, { phase: 'idle', errorCode: null, keptText: false });
});

test('reset always returns to the initial state from every phase', () => {
  for (const phase of ['requestingMic', 'connecting', 'recording', 'stopping', 'error'] as const) {
    const state: VoiceUiState = { phase, errorCode: phase === 'error' ? 'mic_denied' : null, keptText: false };
    assert.deepEqual(reduceVoiceUi(state, { type: 'reset' }), VOICE_UI_INITIAL, phase);
  }
});

test('error phase ignores tapStart until dismissed (banner owns dismissal)', () => {
  const errored = reduceVoiceUi(VOICE_UI_INITIAL, { type: 'unsupported' });
  assert.equal(reduceVoiceUi(errored, { type: 'tapStart' }).phase, 'error');
});

test('voicePhaseTestid follows the phase (e2e selectors)', () => {
  assert.equal(voicePhaseTestid(VOICE_UI_INITIAL), 'voice-btn-idle');
  assert.equal(voicePhaseTestid({ phase: 'recording', errorCode: null, keptText: false }), 'voice-btn-recording');
});
