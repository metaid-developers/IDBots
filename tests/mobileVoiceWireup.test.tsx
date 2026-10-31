// Voice input UI wiring tests (voice P0, subtask #10).
//
// Harness note (repo convention, see tests/mobileEmojiPicker.test.tsx):
// renderer tests here are server-rendered (no DOM/jsdom), so handler wiring
// on the ChatScreen is pinned with source assertions while the button and
// the error banner are rendered via SSR. Also pins the zh/en i18n voice-key
// parity and the worklet processor source contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { VoiceButton, VoiceErrorBanner, voiceErrorCopyKey } from '../src/mobile/app/voice/VoiceButton.tsx';
import { VOICE_UI_INITIAL, type VoiceUiState } from '../src/mobile/app/voice/voiceButtonState.ts';
import { mobileI18n } from '../src/mobile/i18n.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const readSource = (relative: string): string =>
  fs.readFileSync(path.join(here, relative), 'utf-8');

// SSR copy assertions assume the zh dictionary (Node infers the language from
// the process env, which can be en) — pin it explicitly for this file.
mobileI18n.setLanguage('zh');

const state = (overrides: Partial<VoiceUiState>): VoiceUiState => ({ ...VOICE_UI_INITIAL, ...overrides });

// ---------------------------------------------------------------------------
// VoiceButton SSR
// ---------------------------------------------------------------------------

test('VoiceButton SSR: idle shows the mic affordance with the right testid/aria', () => {
  const html = renderToStaticMarkup(
    React.createElement(VoiceButton, { state: VOICE_UI_INITIAL, elapsedSec: 0, onStart: () => {}, onStop: () => {} }),
  );
  assert.match(html, /data-testid="voice-btn-idle"/);
  assert.match(html, /aria-pressed="false"/);
  assert.match(html, /语音输入/, 'zh locale default in tests');
});

test('VoiceButton SSR: recording shows stop affordance, aria-pressed, and elapsed badge', () => {
  const html = renderToStaticMarkup(
    React.createElement(VoiceButton, { state: state({ phase: 'recording' }), elapsedSec: 42, onStart: () => {}, onStop: () => {} }),
  );
  assert.match(html, /data-testid="voice-btn-recording"/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /data-testid="voice-elapsed"/);
  assert.match(html, /42s/);
  assert.match(html, /结束语音/);
});

test('VoiceButton SSR: error phase keeps the button visible for re-entry', () => {
  const html = renderToStaticMarkup(
    React.createElement(VoiceButton, { state: state({ phase: 'error', errorCode: 'mic_denied' }), elapsedSec: 0, onStart: () => {}, onStop: () => {} }),
  );
  assert.match(html, /data-testid="voice-btn-error"/);
});

// ---------------------------------------------------------------------------
// VoiceErrorBanner SSR
// ---------------------------------------------------------------------------

test('VoiceErrorBanner SSR: renders role=alert with the mapped copy and dismiss', () => {
  const html = renderToStaticMarkup(
    React.createElement(VoiceErrorBanner, { state: state({ phase: 'error', errorCode: 'connection_lost' }), onDismiss: () => {} }),
  );
  assert.match(html, /role="alert"/);
  assert.match(html, /data-testid="voice-error"/);
  assert.match(html, /语音连接中断，已保留已识别的文字。/);
  assert.match(html, /data-testid="voice-error-dismiss"/);
});

test('VoiceErrorBanner SSR: renders nothing outside the error phase', () => {
  const html = renderToStaticMarkup(
    React.createElement(VoiceErrorBanner, { state: state({ phase: 'recording' }), onDismiss: () => {} }),
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

test('ChatScreen wires the voice hook, the button, and the error banner', () => {
  const source = readSource('../src/mobile/app/screens/ChatScreen.tsx');
  assert.match(source, /import \{ useVoiceInput \} from '\.\.\/voice\/useVoiceInput';/);
  assert.match(source, /import \{ VoiceButton, VoiceErrorBanner \} from '\.\.\/voice\/VoiceButton';/);
  assert.match(source, /const voice = useVoiceInput\(/, 'hook instantiated');
  assert.match(source, /getDraftAndCaret: \(\) =>/, 'draft+caret seam wired');
  assert.match(source, /onDraftReplace: \(text, caret\) =>/, 'draft replace seam wired');
  assert.match(source, /pendingCaretRef\.current = caret/, 'caret restore plumbing reused');
  assert.match(source, /<VoiceErrorBanner state=\{voice\.state\} onDismiss=\{voice\.dismissError\} \/>/);
  assert.match(source, /<VoiceButton state=\{voice\.state\} elapsedSec=\{voice\.elapsedSec\} onStart=\{voice\.start\} onStop=\{voice\.stop\} \/>/);
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
