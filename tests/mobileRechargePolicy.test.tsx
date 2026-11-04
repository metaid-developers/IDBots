import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { isRechargeAllowed } from '../src/mobile/native/rechargePolicy.ts';
import ChatScreen from '../src/mobile/app/screens/ChatScreen.tsx';
import MeScreen from '../src/mobile/app/screens/MeScreen.tsx';
import { mobileI18n, t } from '../src/mobile/i18n.ts';
import type { useChat } from '../src/mobile/app/hooks/useChat.ts';

type Chat = ReturnType<typeof useChat>;

function chatFixture(): Chat {
  return {
    messages: [],
    sessions: [],
    sessionId: null,
    sessionTitle: null,
    metabotId: null,
    isStreaming: false,
    permission: null,
    toolCalls: [],
    quotaExhausted: true,
    quotaKind: 'free',
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

test('recharge policy hides only the iOS Capacitor shell', () => {
  assert.equal(isRechargeAllowed({ os: 'ios', shell: 'capacitor' }), false);
  assert.equal(isRechargeAllowed({ os: 'android', shell: 'capacitor' }), true);
  assert.equal(isRechargeAllowed({ os: 'ios', shell: 'pwa' }), true);
  assert.equal(isRechargeAllowed({ os: 'ios', shell: 'browser' }), true);
  assert.equal(isRechargeAllowed({ os: 'web', shell: 'browser' }), true);
  assert.equal(isRechargeAllowed(undefined), true);
  assert.equal(isRechargeAllowed({ os: 'ios', shell: 'unknown' } as never), true);
});

test('ChatScreen hides only its recharge action when native iOS policy disallows it', () => {
  mobileI18n.setLanguage('en');
  const hidden = renderToStaticMarkup(
    <ChatScreen chat={chatFixture()} bots={[]} onOpenRecharge={() => undefined} rechargeAllowed={false} />,
  );
  const rechargeButton = `>${t('mobile.chat.quotaRecharge')}</button>`;
  assert.ok(hidden.includes('quota-card'));
  assert.ok(!hidden.includes(rechargeButton));
  assert.ok(hidden.includes(t('mobile.chat.quotaDismiss')));

  const visible = renderToStaticMarkup(
    <ChatScreen chat={chatFixture()} bots={[]} onOpenRecharge={() => undefined} rechargeAllowed />,
  );
  assert.ok(visible.includes(rechargeButton));
});

test('MeScreen shows the S9 points home: free tier sees the top-up lock, no cashier button', () => {
  mobileI18n.setLanguage('en');
  const html = renderToStaticMarkup(
    <MeScreen canPurchase onOpenPurchase={() => undefined} />,
  );
  assert.match(html, /data-testid="me-points-hero"/);
  assert.match(html, /data-testid="me-topup-locked"/);
  assert.doesNotMatch(html, /data-testid="me-page-traffic"/);
  assert.doesNotMatch(html, /data-testid="balance-card"/);
  // The old traffic recharge/redeem entry pair is retired with the quota UI.
  assert.ok(!html.includes(t('mobile.me.rechargeEntry')));
});

test('iOS policy: the purchase surface is display-only in the capacitor iOS shell', () => {
  mobileI18n.setLanguage('en');
  // Free tier: the hero never renders a cashier button (see test above).
  // Purchasability itself is decided by the policy helper, used by the shell
  // to keep both overlays closed on iOS.
  assert.equal(isRechargeAllowed({ os: 'ios', shell: 'capacitor' }), false);
  assert.equal(isRechargeAllowed({ os: 'android', shell: 'capacitor' }), true);
});

