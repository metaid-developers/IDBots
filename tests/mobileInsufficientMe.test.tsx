import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ChatScreen from '../src/mobile/app/screens/ChatScreen.tsx';
import {
  deriveLiveQuotaExhausted,
  deriveQuotaExhaustedFromDetail,
} from '../src/mobile/app/hooks/useChat.ts';
import { INSUFFICIENT_ME_CODE, insufficientMeFromErrorText } from '../src/mobile/app/quotaCodes.ts';
import { mobileI18n, t } from '../src/mobile/i18n.ts';
import type { useChat } from '../src/mobile/app/hooks/useChat.ts';

/**
 * S9 section 6: an INSUFFICIENT_ME death must route to the plan / top-up path.
 * The structured code wins; the persisted terminal Error row is the only
 * payload that falls back to text.
 */

type Chat = ReturnType<typeof useChat>;

function chatFixture(kind: 'me' | 'free'): Chat {
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
    quotaExhausted: true,
    quotaKind: kind,
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
  } as Chat;
}

test('structured INSUFFICIENT_ME declares the ME quota kind', () => {
  assert.deepEqual(
    deriveLiveQuotaExhausted(
      { status: 'error' },
      { code: INSUFFICIENT_ME_CODE, text: 'turn failed' },
      { exhausted: false, kind: null },
    ),
    { exhausted: true, kind: 'me' },
  );
});

test('persisted terminal error row falls back to the ME text marker', () => {
  const session = {
    status: 'error' as const,
    messages: [{ type: 'system', content: 'Error: INSUFFICIENT_ME (balance 0)' }],
  };
  assert.deepEqual(deriveQuotaExhaustedFromDetail(session as never), { exhausted: true, kind: 'me' });
  assert.equal(insufficientMeFromErrorText(session.messages[0].content), true);
  assert.equal(insufficientMeFromErrorText('Error: free_quota_exhausted'), false);
});

test('chat quota card for ME shows the plan / top-up copy and action', () => {
  mobileI18n.setLanguage('en');
  const html = renderToStaticMarkup(
    <ChatScreen chat={chatFixture('me')} bots={[]} onOpenRecharge={() => undefined} rechargeAllowed />,
  );
  assert.match(html, /data-testid="quota-card"/);
  assert.ok(html.includes(t('mobile.chat.quotaTitleMe')));
  assert.ok(html.includes(t('mobile.chat.quotaBodyMe')));
  assert.ok(html.includes(t('mobile.chat.quotaMeAction')));
  assert.ok(!html.includes('persistent balance are used up'));
});
