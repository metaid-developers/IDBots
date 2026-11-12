import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import ChatScreen from '../src/mobile/app/screens/ChatScreen.tsx';
import { createMobileMockBridge } from '../src/mobile/bridge/mockBridge.ts';
import { mobileI18n, t } from '../src/mobile/i18n.ts';
import type { CoworkSessionDetail } from '../src/mobile/bridge/types.ts';
import type { useChat } from '../src/mobile/app/hooks/useChat.ts';
import {
  deriveLiveQuotaExhausted,
  deriveQuotaExhaustedFromDetail,
  quotaKindFromErrorText,
} from '../src/mobile/app/hooks/useChat.ts';
import { LLM_QUOTA_EXHAUSTED_CODE } from '../src/mobile/app/quotaCodes.ts';
import { projectChatMessages } from '../src/mobile/app/chatProjection.ts';

/**
 * REQ-E-12 / F-8+F-9 quota-exhausted UX: when a tenant turn dies on the
 * relay's 429 free_quota_exhausted (or the C4 quota_exhausted), the phone
 * must NOT fail silently — it shows the recharge card. These tests pin the
 * legs of the fix:
 *
 *   1. error-code pass-through recognition — quotaKindFromErrorText reads
 *      the relay machine code, deriveQuotaExhaustedFromDetail re-derives the
 *      card from a reopened session detail (the runner persists the terminal
 *      `Error: …` system row and flips the session to status 'error');
 *   2. structured-first live detection — deriveLiveQuotaExhausted declares a
 *      quota death from the machine code on the cowork:stream:error frame;
 *      both legacy relay codes use the unified ME purchase surface;
 *   3. the mock bridge's quota scenario mirrors the REAL contract (REQ-A-25:
 *      metadata.errorCode rides cowork:stream:error, never the completion
 *      frame) — an end-to-end mock assertion;
 *   4. ChatScreen renders the unified ME plan/top-up card and the inline
 *      error notice instead of a bare/silent failure;
 *   5. a string-fallback MISS (unknown terminal error) keeps the raw system
 *      error row out of the bubble body: the projection renders the localized
 *      turnFailed one-liner as the main copy, with a bounded raw reason line
 *      underneath (2026-11-11 diagnosability fix) — never the raw row itself.
 */

type Chat = ReturnType<typeof useChat>;

function chatFixture(overrides: Partial<Chat> = {}): Chat {
  return {
    messages: [],
    activityMessages: [],
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

function fixture(
  status: string,
  messages: Array<{ type: string; content: string }>,
): Parameters<typeof deriveQuotaExhaustedFromDetail>[0] {
  return {
    status,
    messages: messages.map((message, index) => ({
      id: `m${index + 1}`,
      type: message.type,
      content: message.content,
      timestamp: 0,
    })),
  } as unknown as CoworkSessionDetail;
}

const FREE_ERROR = 'Error: DSH turn failed: 免费额度已用完（IDBots-Free 体验额度耗尽）（错误代码：free_quota_exhausted）';
const PURCHASED_ERROR = 'Error: DSH turn failed: 已购额度耗尽（错误代码：quota_exhausted）';
const OTHER_ERROR = 'Error: DSH turn failed: model request terminated (transport failure)';

test('quotaKindFromErrorText separates the two relay codes', () => {
  assert.equal(quotaKindFromErrorText(FREE_ERROR), 'me');
  assert.equal(quotaKindFromErrorText('...quota_exhausted...'), 'me');
  // quota_exhausted is a substring of free_quota_exhausted — the free
  // variant must still report 'me'.
  assert.equal(quotaKindFromErrorText('free_quota_exhausted'), 'me');
  assert.equal(quotaKindFromErrorText(OTHER_ERROR), null);
  assert.equal(quotaKindFromErrorText(undefined), null);
  assert.equal(quotaKindFromErrorText(42), null);
});

test('deriveQuotaExhaustedFromDetail follows the live-state rule', () => {
  // Free-quota death on an errored session → card, free copy.
  assert.deepEqual(
    deriveQuotaExhaustedFromDetail(fixture('error', [
      { type: 'user', content: '帮我写个文档' },
      { type: 'system', content: FREE_ERROR },
    ])),
    { exhausted: true, kind: 'me' },
  );
  // C4 purchased-pool death → card, purchased copy.
  assert.deepEqual(
    deriveQuotaExhaustedFromDetail(fixture('error', [
      { type: 'user', content: '继续' },
      { type: 'system', content: PURCHASED_ERROR },
    ])),
    { exhausted: true, kind: 'me' },
  );
  // Not an error session (the retry flipped it to running) → no card.
  assert.deepEqual(
    deriveQuotaExhaustedFromDetail(fixture('running', [
      { type: 'system', content: FREE_ERROR },
    ])),
    { exhausted: false, kind: null },
  );
  // A non-quota failure leaves the card to the inline notice.
  assert.deepEqual(
    deriveQuotaExhaustedFromDetail(fixture('error', [
      { type: 'system', content: OTHER_ERROR },
    ])),
    { exhausted: false, kind: null },
  );
  // An older quota error superseded by a newer non-quota failure → no card.
  assert.deepEqual(
    deriveQuotaExhaustedFromDetail(fixture('error', [
      { type: 'system', content: FREE_ERROR },
      { type: 'user', content: '再试一次' },
      { type: 'system', content: OTHER_ERROR },
    ])),
    { exhausted: false, kind: null },
  );
  // A newer quota error after an older non-quota failure → card.
  assert.deepEqual(
    deriveQuotaExhaustedFromDetail(fixture('error', [
      { type: 'system', content: OTHER_ERROR },
      { type: 'system', content: FREE_ERROR },
    ])),
    { exhausted: true, kind: 'me' },
  );
  // Quota text inside a non-system row never counts.
  assert.deepEqual(
    deriveQuotaExhaustedFromDetail(fixture('error', [
      { type: 'assistant', content: '错误代码：free_quota_exhausted' },
    ])),
    { exhausted: false, kind: null },
  );
  // Degenerate shapes: no messages, no session.
  assert.deepEqual(deriveQuotaExhaustedFromDetail(fixture('error', [])), { exhausted: false, kind: null });
  assert.deepEqual(deriveQuotaExhaustedFromDetail(null), { exhausted: false, kind: null });
});

test('structured code drives live detection; the text only refines the card copy', () => {
  const persistedNone = { exhausted: false, kind: null } as const;
  // STRUCTURED: the frame code alone declares the quota death even when the
  // upstream copy changed beyond any recognizable text — no regex needed.
  assert.deepEqual(
    deriveLiveQuotaExhausted(
      { status: 'error' },
      { code: LLM_QUOTA_EXHAUSTED_CODE, text: 'DSH turn failed: (upstream copy changed beyond recognition)' },
      persistedNone,
    ),
    { exhausted: true, kind: 'me' },
  );
  // Structured + a recognizable relay code in the text → the code picks the copy.
  assert.deepEqual(
    deriveLiveQuotaExhausted(
      { status: 'error' },
      { code: LLM_QUOTA_EXHAUSTED_CODE, text: 'DSH turn failed: ... quota_exhausted ...' },
      persistedNone,
    ),
    { exhausted: true, kind: 'me' },
  );
  // Structured declaration wins over a stale persisted result, but the
  // persisted kind refinement survives when the text carries no relay code
  // (the ?? chain: text code → persisted kind → 'me').
  assert.deepEqual(
    deriveLiveQuotaExhausted(
      { status: 'error' },
      { code: LLM_QUOTA_EXHAUSTED_CODE, text: 'no relay code here' },
      { exhausted: true, kind: 'me' },
    ),
    { exhausted: true, kind: 'me' },
  );
  // NO structured code → the persisted string-fallback result passes through
  // unchanged (restore/resync pathway); the live text is never regexed.
  assert.deepEqual(
    deriveLiveQuotaExhausted(
      { status: 'error' },
      { code: null, text: 'Error: DSH turn failed: free_quota_exhausted' },
      { exhausted: true, kind: 'me' },
    ),
    { exhausted: true, kind: 'me' },
  );
  // No code + unknown text + nothing persisted → no card (the miss leaves
  // the row to the localized diagnostics pathway, not a raw surface).
  assert.deepEqual(
    deriveLiveQuotaExhausted(
      { status: 'error' },
      { code: null, text: 'DSH turn failed: mystery' },
      persistedNone,
    ),
    { exhausted: false, kind: null },
  );
  // Not an error session → no card even with the machine code present.
  assert.deepEqual(
    deriveLiveQuotaExhausted(
      { status: 'running' },
      { code: LLM_QUOTA_EXHAUSTED_CODE, text: 'free_quota_exhausted' },
      persistedNone,
    ),
    { exhausted: false, kind: null },
  );
});

test('a string-fallback miss renders the localized one-liner, not the raw error row', () => {
  mobileI18n.setLanguage('zh');

  // Unknown terminal error: no diagnostic metadata, no relay code anywhere.
  const unknownViews = projectChatMessages([
    {
      id: 'e1',
      type: 'system',
      content: 'Error: DSH turn failed: (mystery upstream body with no machine code)',
      timestamp: 1,
    },
  ] as never);
  assert.equal(unknownViews.length, 1);
  assert.equal(unknownViews[0]?.role, 'error');
  assert.equal(unknownViews[0]?.diagnostic, 'turnFailed');
  assert.equal(unknownViews[0]?.text, '', 'diagnostic views carry no raw copy');

  const markup = renderToStaticMarkup(
    <ChatScreen chat={chatFixture({ messages: unknownViews })} bots={[]} onOpenRecharge={() => undefined} />,
  );
  assert.ok(markup.includes('error-bubble'), 'the failure still surfaces as an error bubble');
  const friendlyAt = markup.indexOf(t('mobile.chat.diagnostic.turnFailed'));
  const reasonAt = markup.indexOf('data-testid="chat-diagnostic-reason"');
  const rawAt = markup.indexOf('mystery upstream body');
  assert.ok(friendlyAt >= 0, 'the localized one-liner renders as the main copy');
  // 2026-11-11: the raw cause is no longer discarded — it rides a dedicated,
  // bounded reason line UNDER the friendly copy (the owner could not diagnose
  // a repeated failure from the one-liner alone).
  assert.ok(reasonAt > friendlyAt, 'the bounded reason line renders under the friendly copy');
  assert.ok(rawAt > reasonAt, 'the raw excerpt only appears inside the reason line');

  // The recognized quota row keeps its raw transcript record (code visible).
  const quotaViews = projectChatMessages([
    { id: 'e2', type: 'system', content: FREE_ERROR, timestamp: 1 },
  ] as never);
  assert.equal(quotaViews.length, 1);
  assert.equal(quotaViews[0]?.diagnostic, null);
  assert.ok(quotaViews[0]?.text.includes('free_quota_exhausted'), 'quota rows keep the machine code visible');

  // Diagnostic-metadata errors still render their own localized one-liner.
  const rateLimitViews = projectChatMessages([
    { id: 'e3', type: 'system', content: 'Error: 429', timestamp: 1, metadata: { sdkRateLimit: { retryAfterMs: 1000 } } },
  ] as never);
  assert.equal(rateLimitViews[0]?.diagnostic, 'rateLimit');
});

test('mock end-to-end: quota turn → stream:error frame → reopened session re-derives the card', async (t) => {
  const bridge = createMobileMockBridge({ streamTokenIntervalMs: 1, systemLocale: 'en-US' });
  t.after(() => bridge.destroy());
  const api = bridge.electron;

  const frames: Array<{ sessionId: string; error: string; metadata?: { errorCode?: string } }> = [];
  const off = api.cowork.onStreamError((payload: { sessionId: string; error: string; metadata?: { errorCode?: string } }) => frames.push(payload));

  const started = await api.cowork.startSession({ prompt: 'what is my quota' });
  assert.equal(started.success, true);
  const deadline = Date.now() + 3000;
  while (frames.length === 0) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the quota stream error');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  // Live frame (what useChat.onStreamError keys off): machine code on the
  // ERROR frame, and the relay code inside the text picks the copy.
  assert.equal(frames[0].sessionId, started.session.id);
  assert.equal(frames[0].metadata?.errorCode, 'LLM_QUOTA_EXHAUSTED');
  assert.equal(quotaKindFromErrorText(frames[0].error), 'me');

  // Reopen path (what useChat.openSession / applyResync derive): the
  // persisted detail re-derives the same card state.
  const fetched = await api.cowork.getSession(started.session.id);
  assert.ok(fetched?.success && fetched.session);
  assert.deepEqual(deriveQuotaExhaustedFromDetail(fetched.session), { exhausted: true, kind: 'me' });
  off();
});

test('ChatScreen renders the unified ME plan and top-up prompt', () => {
  mobileI18n.setLanguage('zh');

  const withCard = renderToStaticMarkup(
    <ChatScreen
      chat={chatFixture({ quotaExhausted: true, quotaKind: 'me' })}
      bots={[]}
      onOpenRecharge={() => undefined}
    />,
  );
  assert.ok(withCard.includes('quota-card'), 'quota card test id present');
  assert.ok(withCard.includes(t('mobile.chat.quotaTitleMe')), 'unified ME title rendered');
  assert.ok(withCard.includes(t('mobile.chat.quotaBodyMe')), 'spendable-ME body rendered');
  assert.ok(withCard.includes('去充值或升级套餐'), 'combined plan and top-up action rendered');
  assert.ok(!withCard.includes('已购额度已用完'), 'retired purchased-quota copy is not rendered');

  const healthy = renderToStaticMarkup(
    <ChatScreen chat={chatFixture()} bots={[]} onOpenRecharge={() => undefined} />,
  );
  assert.ok(!healthy.includes('quota-card'), 'no card on a healthy session');
});

test('ChatScreen renders terminal error rows as an inline notice instead of dropping them', () => {
  mobileI18n.setLanguage('zh');

  const markup = renderToStaticMarkup(
    <ChatScreen
      chat={chatFixture({
        messages: [
          { id: 'u1', role: 'user', text: '帮我写个文档', streaming: false },
          { id: 'e1', role: 'error', text: FREE_ERROR, streaming: false },
        ],
      })}
      bots={[]}
      onOpenRecharge={() => undefined}
    />,
  );
  assert.ok(markup.includes('error-bubble'), 'error notice test id present');
  assert.ok(markup.includes('free_quota_exhausted'), 'the relay machine code is visible in the transcript');
});

test('ChatScreen shows Bot activity instead of mechanical submission copy', () => {
  mobileI18n.setLanguage('en');
  const html = renderToStaticMarkup(
    <ChatScreen
      chat={chatFixture({
        turnPhase: 'steering',
        attempts: [{
          submissionId: 'attempt-1',
          kind: 'submit',
          sessionId: 'session-1',
          text: 'Follow up',
          draftToken: 'session-1',
          draftText: 'Follow up',
          draftAttachments: [],
          status: 'sending',
          error: null,
          createdAt: 0,
          startOptions: null,
        }],
      })}
      bots={[]}
      onOpenRecharge={() => undefined}
    />,
  );
  assert.ok(html.includes('assistant-status-shimmer'), 'desktop Bot activity indicator is reused');
  assert.ok(html.includes('Understanding your follow-up'), 'natural activity copy is rendered');
  assert.ok(!html.includes('Sending and waiting for tenant confirmation'), 'mechanical submission copy is removed');
  assert.ok(!html.includes('Sending your follow-up'), 'transport-oriented follow-up copy is removed');
});
