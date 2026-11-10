// Mobile chat terminal-failure diagnostics (2026-11-11).
//
// The owner kept hitting the same dead end on http://localhost:5176/app/:
// "本轮执行失败，请稍后重试。" with no clue whether the turn died on the
// network, auth, quota or the bot runtime. The friendly sentence stays the
// bubble's main copy; these tests pin the NEW bounded reason line and the
// "copy diagnostics" payload underneath it:
//
//   1. a non-quota terminal error still projects as `turnFailed`, and its
//      `diagnosticReason` is the first line, whitespace-collapsed and capped
//      at DIAGNOSTIC_REASON_MAX_CHARS (<= 120) — never `text`, so the bubble
//      body keeps the localized one-liner;
//   2. blank/hostile error bodies fall back to a recognizable identifier
//      (errno name / HTTP status) instead of an empty line;
//   3. the clipboard payload carries timestamp, session id (when known),
//      diagnostic kind and the FULL raw error (not the excerpt);
//   4. ChatScreen SSR renders the reason line + copy affordance inside the
//      same error bubble, and the excerpt stays capped;
//   5. quota rows are untouched: raw machine code visible, no reason line.
//
// Harness note (same convention as mobileQuotaExhausted.test.tsx): renderer
// assertions are server-rendered; handler wiring is asserted by markup.
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import ChatScreen from '../src/mobile/app/screens/ChatScreen.tsx';
import {
  DIAGNOSTIC_REASON_MAX_CHARS,
  extractTurnFailureReason,
  formatDiagnosticCopy,
  projectChatMessages,
} from '../src/mobile/app/chatProjection.ts';
import { mobileI18n, t } from '../src/mobile/i18n.ts';
import type { CoworkMessage } from '../src/renderer/types/cowork.ts';
import type { useChat } from '../src/mobile/app/hooks/useChat.ts';

type Chat = ReturnType<typeof useChat>;

function message(
  id: string,
  type: CoworkMessage['type'],
  content: string,
  metadata?: CoworkMessage['metadata'],
): CoworkMessage {
  return { id, type, content, timestamp: 1, ...(metadata ? { metadata } : {}) };
}

function chatFixture(overrides: Partial<Chat> = {}): Chat {
  return {
    messages: [],
    sessions: [],
    sessionId: null,
    sessionTitle: null,
    metabotId: null,
    isStreaming: false,
    permission: null,
    toolCalls: [],
    quotaExhausted: false,
    quotaKind: null,
    setMetabotId: () => undefined,
    reloadSessions: async () => undefined,
    openSession: async () => undefined,
    newChat: () => undefined,
    send: async () => undefined,
    stop: async () => undefined,
    respondPermission: async () => undefined,
    dismissPermission: () => undefined,
    dismissQuota: () => undefined,
    applyResync: () => undefined,
    getOpenSessionId: () => null,
    getStreamingMessage: () => null,
    ...overrides,
  };
}

const LONG_ERROR = `Error: upstream rejected the turn: ${'x'.repeat(300)}`;

test('non-quota terminal error stays turnFailed and carries a capped first-line reason', () => {
  const views = projectChatMessages([
    message('e1', 'system', 'Error: DSH turn failed: socket hang up'),
    message('e2', 'system', LONG_ERROR),
    message('e3', 'system', 'Error: connect failed\n    at Socket.<anonymous> (node:net:1:1)'),
  ]);

  assert.deepEqual(views.map((view) => view.diagnostic), ['turnFailed', 'turnFailed', 'turnFailed']);
  assert.deepEqual(views.map((view) => view.text), ['', '', ''], 'bubble bodies keep the localized one-liner');

  assert.equal(views[0]?.diagnosticReason, 'Error: DSH turn failed: socket hang up');

  const longReason = views[1]?.diagnosticReason ?? '';
  assert.ok(longReason.length <= DIAGNOSTIC_REASON_MAX_CHARS, `reason must be <= ${DIAGNOSTIC_REASON_MAX_CHARS} chars, got ${longReason.length}`);
  assert.equal(longReason, `${LONG_ERROR.slice(0, DIAGNOSTIC_REASON_MAX_CHARS - 1)}…`);

  assert.equal(views[2]?.diagnosticReason, 'Error: connect failed', 'only the first line surfaces');
});

test('blank first line falls back to a recognizable error identifier', () => {
  // A leading blank line then the real failure: the token is the actionable bit.
  assert.equal(extractTurnFailureReason('\n  \nECONNREFUSED 127.0.0.1:5176', null), 'ECONNREFUSED');
  assert.equal(extractTurnFailureReason('\n\nupstream said HTTP 503', null), 'HTTP 503');
  // metadata.error is the only source (persisted rows may store text there).
  assert.equal(
    extractTurnFailureReason('', 'UNAUTHORIZED from relay'),
    'UNAUTHORIZED from relay',
  );
  // Nothing readable at all: no invented reason.
  assert.equal(extractTurnFailureReason('', undefined), null);
  assert.equal(extractTurnFailureReason('   \n  ', null), null);
});

test('copy payload carries time, session id, diagnostic kind and the FULL raw error', () => {
  const [view] = projectChatMessages([message('e4', 'system', LONG_ERROR)]);
  assert.ok(view);
  const copy = formatDiagnosticCopy(view, 'sess-123');
  assert.ok(copy.includes('time: 1970-01-01T00:00:00.001Z'), 'timestamp is the message timestamp');
  assert.ok(copy.includes('session: sess-123'));
  assert.ok(copy.includes('diagnostic: turnFailed'));
  assert.ok(copy.includes(LONG_ERROR), 'clipboard keeps the full raw text, not the 120-char excerpt');

  // No session known -> the line is omitted, everything else survives.
  const withoutSession = formatDiagnosticCopy(view, null);
  assert.ok(!withoutSession.includes('session:'));
  assert.ok(withoutSession.includes('diagnostic: turnFailed'));
});

test('ChatScreen renders the friendly copy, the capped reason line and the copy affordance', () => {
  mobileI18n.setLanguage('zh');
  const views = projectChatMessages([message('e5', 'system', LONG_ERROR)]);
  const markup = renderToStaticMarkup(
    <ChatScreen chat={chatFixture({ messages: views, sessionId: 'sess-1' })} bots={[]} onOpenRecharge={() => undefined} />,
  );
  const friendlyAt = markup.indexOf(t('mobile.chat.diagnostic.turnFailed'));
  const reasonAt = markup.indexOf('data-testid="chat-diagnostic-reason"');
  const copyAt = markup.indexOf('data-testid="chat-diagnostic-copy"');

  assert.ok(markup.includes('error-bubble'), 'the failure renders as an error bubble');
  assert.ok(friendlyAt >= 0, 'the friendly one-liner is still the main copy');
  assert.ok(reasonAt > friendlyAt, 'the reason line sits under the friendly copy');
  assert.ok(copyAt > reasonAt, 'the copy affordance follows the reason line');
  assert.ok(markup.includes(t('mobile.chat.diagnostic.reasonLabel')));
  assert.ok(markup.includes(t('mobile.chat.diagnostic.copy')));
  assert.ok(!markup.includes('x'.repeat(DIAGNOSTIC_REASON_MAX_CHARS)), 'the excerpt is capped in the bubble');
});

test('quota rows are untouched: raw machine code visible, no reason line', () => {
  const views = projectChatMessages([
    message('q1', 'system', 'Error: DSH turn failed: free_quota_exhausted'),
    message('q2', 'system', 'Error: DSH turn failed: quota_exhausted'),
  ]);
  for (const view of views) {
    assert.equal(view.diagnostic, null);
    assert.equal(view.diagnosticReason, null);
    assert.ok(view.text.startsWith('Error: DSH turn failed:'), 'quota rows keep the raw transcript record');
  }
  assert.ok(views[0]?.text.includes('free_quota_exhausted'));
  assert.ok(views[1]?.text.includes('quota_exhausted'));
});
