// Voice input UI wiring tests (voice P1: hold to send).
//
// Harness note (repo convention, see tests/mobileEmojiPicker.test.tsx):
// renderer tests here are server-rendered (no DOM/jsdom), so handler wiring
// on the ChatScreen is pinned with source assertions while the button, the
// hold overlay and the error banner are rendered via SSR. The behavioural
// assertions for release/cancel/error live in mobileVoiceHoldToSend.test.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { VoiceButton, VoiceErrorBanner, voiceErrorCopyKey } from '../src/mobile/app/voice/VoiceButton.tsx';
import { VoiceOverlay } from '../src/mobile/app/voice/VoiceOverlay.tsx';
import { VOICE_UI_INITIAL, type VoiceUiState } from '../src/mobile/app/voice/voiceButtonState.ts';
import { mobileI18n } from '../src/mobile/i18n.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const readSource = (relative: string): string =>
  fs.readFileSync(path.join(here, relative), 'utf-8');

// SSR copy assertions assume the zh dictionary (Node infers the language from
// the process env, which can be en) — pin it explicitly for this file.
mobileI18n.setLanguage('zh');

const state = (overrides: Partial<VoiceUiState>): VoiceUiState => ({ ...VOICE_UI_INITIAL, ...overrides });

const noop = () => {};
const buttonProps = (overrides: Record<string, unknown> = {}) => ({
  state: VOICE_UI_INITIAL,
  elapsedSec: 0,
  recognizedText: '',
  levelRef: { current: 0 },
  onStart: noop,
  onStop: noop,
  onStartHold: noop,
  onEndHold: noop,
  onCancelHold: noop,
  onSalvage: noop,
  onDismissError: noop,
  ...overrides,
});

const renderButton = (overrides: Record<string, unknown> = {}): string =>
  renderToStaticMarkup(React.createElement(VoiceButton, buttonProps(overrides)));

// ---------------------------------------------------------------------------
// VoiceButton SSR
// ---------------------------------------------------------------------------

test('VoiceButton SSR: idle shows the mic affordance with the right testid/aria', () => {
  const html = renderButton();
  assert.match(html, /data-testid="voice-btn-idle"/);
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, /语音输入/, 'zh locale default in tests');
  assert.doesNotMatch(html, /voice-overlay-/, 'no overlay while idle');
});

test('VoiceButton SSR: recording shows stop affordance, aria-pressed, and elapsed badge', () => {
  const html = renderButton({ state: state({ phase: 'recording' }), elapsedSec: 42 });
  assert.match(html, /data-testid="voice-btn-recording"/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /data-testid="voice-elapsed"/);
  assert.match(html, /42s/);
  assert.match(html, /结束语音/);
});

test('VoiceButton SSR: error phase keeps the button visible for re-entry', () => {
  const html = renderButton({ state: state({ phase: 'error', errorCode: 'mic_denied' }) });
  assert.match(html, /data-testid="voice-btn-error"/);
});

// ---------------------------------------------------------------------------
// Hold overlay SSR: three states + error card, each with a stable testid
// ---------------------------------------------------------------------------

test('hold overlay: recording state shows live text, real level bars, timer and both hints', () => {
  const html = renderButton({
    state: state({ phase: 'recording', mode: 'hold' }),
    elapsedSec: 5,
    recognizedText: '这是一段实时识别文本',
  });
  assert.match(html, /data-testid="voice-overlay-recording"/);
  assert.match(html, /data-testid="voice-overlay-text"/);
  assert.match(html, /这是一段实时识别文本/);
  assert.match(html, /data-testid="voice-overlay-level"/);
  const bars = html.match(/data-testid="voice-level-bar"/g) ?? [];
  assert.equal(bars.length, 9, 'the level meter renders its full bar set');
  assert.match(html, /data-testid="voice-overlay-timer"/);
  assert.match(html, /5s/);
  assert.match(html, /松开发送/);
  assert.match(html, /上滑取消/);
  assert.match(html, /data-testid="voice-overlay-panel"/);
});

test('hold overlay: release switches to the recognizing state', () => {
  const html = renderButton({
    state: state({ phase: 'stopping', mode: 'hold' }),
    elapsedSec: 8,
    recognizedText: '等待最终结果',
  });
  assert.match(html, /data-testid="voice-overlay-recognizing"/);
  assert.match(html, /识别中/);
  assert.match(html, /data-testid="voice-overlay-text"/);
});

test('hold overlay: cancel state arms on swipe-up and names the release action', () => {
  // Cancel is gesture state inside the button; the overlay is the rendered
  // contract, so pin it directly with cancelArmed=true.
  const html = renderToStaticMarkup(
    React.createElement(VoiceOverlay, {
      state: state({ phase: 'recording', mode: 'hold' }),
      elapsedSec: 3,
      text: '这段将被丢弃',
      levelRef: { current: 0.4 },
      cancelArmed: true,
      onSalvage: noop,
      onDismissError: noop,
    }),
  );
  assert.match(html, /data-testid="voice-overlay-cancel"/);
  assert.match(html, /松开取消/);
  assert.match(html, /data-testid="voice-overlay-cancel-hint"/);
  assert.doesNotMatch(html, /voice-level-bar/, 'the waveform yields to the cancel card');
});

test('hold overlay: tap mode keeps the P0 surface and never shows the overlay', () => {
  const html = renderButton({ state: state({ phase: 'recording', mode: 'tap' }) });
  assert.doesNotMatch(html, /voice-overlay-/);
});

test('hold overlay error card: recognized text can be put back into the composer', () => {
  const html = renderButton({
    state: state({ phase: 'error', mode: 'hold', errorCode: 'mic_denied' }),
    recognizedText: '已经识别到的文字',
  });
  assert.match(html, /data-testid="voice-overlay-error"/);
  assert.match(html, /data-testid="voice-overlay-error-text"/);
  assert.match(html, /麦克风权限被拒绝/);
  assert.match(html, /data-testid="voice-overlay-error-preview"/);
  assert.match(html, /data-testid="voice-overlay-salvage"/);
  assert.match(html, /放入输入框/);
  assert.match(html, /data-testid="voice-overlay-error-dismiss"/);
});

test('hold overlay error card: no text means no salvage button (nothing to hand back)', () => {
  const html = renderButton({
    state: state({ phase: 'error', mode: 'hold', errorCode: 'connect_timeout' }),
  });
  assert.match(html, /data-testid="voice-overlay-error"/);
  assert.doesNotMatch(html, /data-testid="voice-overlay-salvage"/);
});

// ---------------------------------------------------------------------------
// iOS guard set + reduced motion (source assertions)
// ---------------------------------------------------------------------------

test('hold gesture carries the four iOS guards, each with a stated reason', () => {
  const source = readSource('../src/mobile/app/voice/VoiceButton.tsx');
  // 1. touch-action: none — stops iOS claiming the gesture for scrolling.
  assert.match(source, /touchAction: 'none'/);
  assert.match(source, /touch-action: none/, 'the guard is explained in prose');
  // 2. -webkit-touch-callout: none — stops the long-press callout menu.
  assert.match(source, /WebkitTouchCallout: 'none'/);
  assert.match(source, /-webkit-touch-callout: none/);
  // 3. user-select: none — stops long-press text selection stealing the gesture.
  assert.match(source, /WebkitUserSelect: 'none'/);
  assert.match(source, /userSelect: 'none'/);
  // 4. Pointer capture — keeps move/up events during swipe-up cancel.
  assert.match(source, /setPointerCapture\(event\.pointerId\)/);
  assert.match(source, /releasePointerCapture\(event\.pointerId\)/);
  assert.match(source, /onLostPointerCapture=\{handleLostPointerCapture\}/);
  // Page scroll + context menu are blocked for the duration of the hold.
  assert.match(source, /addEventListener\('touchmove', preventGesture, \{ passive: false \}\)/);
  assert.match(source, /addEventListener\('contextmenu', preventGesture\)/);
});

test('reduced motion turns off the pulse/dot animation', () => {
  const button = readSource('../src/mobile/app/voice/VoiceButton.tsx');
  const overlay = readSource('../src/mobile/app/voice/VoiceOverlay.tsx');
  assert.match(button, /motion-reduce:animate-none/);
  assert.match(overlay, /motion-reduce:animate-none/);
  const css = readSource('../src/mobile/app/twin-ui.css');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
});

test('a short press is still the accessible tap toggle (click path present)', () => {
  const source = readSource('../src/mobile/app/voice/VoiceButton.tsx');
  assert.match(source, /const handleClick = \(\): void =>/, 'click/Enter/Space path exists');
  assert.match(source, /if \(state\.phase === 'recording'\) onStop\(\);/, 'second activation stops');
  assert.match(source, /pointerHandledRef/, 'pointer gestures do not double-fire the tap path');
});

// ---------------------------------------------------------------------------
// VoiceErrorBanner SSR (tap-mode only)
// ---------------------------------------------------------------------------

test('VoiceErrorBanner SSR: tap mode renders role=alert with the mapped copy and dismiss', () => {
  const html = renderToStaticMarkup(
    React.createElement(VoiceErrorBanner, {
      state: state({ phase: 'error', mode: 'tap', errorCode: 'connection_lost' }),
      onDismiss: noop,
    }),
  );
  assert.match(html, /role="alert"/);
  assert.match(html, /data-testid="voice-error"/);
  assert.match(html, /语音连接中断，已保留已识别的文字。/);
  assert.match(html, /data-testid="voice-error-dismiss"/);
});

test('VoiceErrorBanner SSR: hold errors render in the overlay, not as a banner', () => {
  const html = renderToStaticMarkup(
    React.createElement(VoiceErrorBanner, {
      state: state({ phase: 'error', mode: 'hold', errorCode: 'connection_lost' }),
      onDismiss: noop,
    }),
  );
  assert.equal(html, '');
});

test('VoiceErrorBanner SSR: renders nothing outside the error phase', () => {
  const html = renderToStaticMarkup(
    React.createElement(VoiceErrorBanner, {
      state: state({ phase: 'recording', mode: 'tap' }),
      onDismiss: noop,
    }),
  );
  assert.equal(html, '');
});

test('voiceErrorCopyKey: error classes route through the protocol mapping', () => {
  // v1: the UI carries the behaviour CLASS, not the raw gateway code.
  assert.equal(voiceErrorCopyKey('server:quota'), 'mobile.chat.voice.errorServer.quota');
  assert.equal(voiceErrorCopyKey('server:session_cap'), 'mobile.chat.voice.errorServer.sessionCap');
  assert.equal(voiceErrorCopyKey('server:unauthorized'), 'mobile.chat.voice.errorServer.unauthorized');
  assert.equal(voiceErrorCopyKey('server:provider'), 'mobile.chat.voice.errorServer.upstream');
  assert.equal(voiceErrorCopyKey('server:warp_core_breach'), 'mobile.chat.voice.errorServer.generic');
  assert.equal(voiceErrorCopyKey('mic_denied'), 'mobile.chat.voice.error.mic_denied');
});

// ---------------------------------------------------------------------------
// i18n zh/en parity for all voice keys
// ---------------------------------------------------------------------------

const VOICE_I18N_KEYS = [
  'mobile.chat.voice.start',
  'mobile.chat.voice.stop',
  'mobile.chat.voice.errorDismiss',
  'mobile.chat.voice.error.unsupported',
  'mobile.chat.voice.error.mic_denied',
  'mobile.chat.voice.error.mic_unavailable',
  'mobile.chat.voice.error.audio_context_failed',
  'mobile.chat.voice.error.mic_timeout',
  'mobile.chat.voice.error.connect_timeout',
  'mobile.chat.voice.error.connection_lost',
  'mobile.chat.voice.error.interrupted',
  'mobile.chat.voice.errorServer.unauthorized',
  'mobile.chat.voice.errorServer.quota',
  'mobile.chat.voice.errorServer.sessionCap',
  'mobile.chat.voice.errorServer.upstream',
  'mobile.chat.voice.errorServer.generic',
  'mobile.chat.voice.listening',
  'mobile.chat.voice.listeningPlaceholder',
  'mobile.chat.voice.holdReleaseToSend',
  'mobile.chat.voice.holdSwipeToCancel',
  'mobile.chat.voice.releaseToCancel',
  'mobile.chat.voice.cancelHint',
  'mobile.chat.voice.cancelSwipeHint',
  'mobile.chat.voice.recognizing',
  'mobile.chat.voice.recognizingHint',
  'mobile.chat.voice.putIntoDraft',
  'mobile.chat.voice.hintTooShort',
  'mobile.chat.voice.hintNoSpeech',
  'mobile.chat.voice.hintKeptInDraft',
];

test('every voice i18n key exists and is non-empty in BOTH zh and en', () => {
  for (const language of ['zh', 'en'] as const) {
    mobileI18n.setLanguage(language);
    for (const key of VOICE_I18N_KEYS) {
      const value = mobileI18n.t(key);
      assert.ok(value && value.length > 0, `${language} missing copy for ${key}`);
      assert.ok(!value.includes(key), `${language}: ${key} renders its own key (missing translation)`);
    }
  }
  mobileI18n.setLanguage('zh');
});

// ---------------------------------------------------------------------------
// ChatScreen wiring (source assertions — repo convention for handler contracts)
// ---------------------------------------------------------------------------

test('ChatScreen wires hold-to-send: final text bypasses the composer and goes to chat.send', () => {
  const source = readSource('../src/mobile/app/screens/ChatScreen.tsx');
  assert.match(source, /import \{ useVoiceInput \} from '\.\.\/voice\/useVoiceInput';/);
  assert.match(source, /import \{ VoiceButton, VoiceErrorBanner \} from '\.\.\/voice\/VoiceButton';/);
  assert.match(source, /import \{ sendVoiceMessage, type HoldCancelReason \} from '\.\.\/voice\/holdToSend';/);
  assert.match(source, /const voice = useVoiceInput\(/, 'hook instantiated');
  assert.match(source, /getDraftAndCaret: \(\) =>/, 'draft+caret seam wired');
  assert.match(source, /onFinalText: \(text\) =>/, 'final transcript seam wired');
  assert.match(source, /sendVoiceMessage\(chat, text, \{ blocked: composerBlocked \}\)/, 'new-message hand-off');
  assert.match(source, /pendingCaretRef\.current = caret/, 'caret restore plumbing reused');
  assert.match(source, /<VoiceErrorBanner state=\{voice\.state\} onDismiss=\{voice\.dismissError\} \/>/);
  assert.match(source, /onStartHold=\{voice\.startHold\}/);
  assert.match(source, /onEndHold=\{voice\.endHold\}/);
  assert.match(source, /onCancelHold=\{voice\.cancelHold\}/);
  assert.match(source, /onSalvage=\{voice\.commitToDraft\}/);
  assert.match(source, /onHoldCancelled=\{handleVoiceHoldCancelled\}/);
  assert.match(source, /data-testid="voice-hint"/);
});

// ---------------------------------------------------------------------------
// Worklet processor source contract
// ---------------------------------------------------------------------------

test('pcm-capture-processor registers "pcm-capture" and copies frames before posting', () => {
  const source = readSource('../src/mobile/app/voice/pcm-capture-processor.js');
  assert.match(source, /registerProcessor\('pcm-capture'/);
  assert.match(source, /input\[0\]\.slice\(0\)/, 'frames are copied (implementation reuses buffers)');
  assert.match(source, /postMessage/, 'frames reach the main thread');
});
