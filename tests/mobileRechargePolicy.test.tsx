import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { isRechargeAllowed } from '../src/mobile/native/rechargePolicy.ts';
import ChatScreen from '../src/mobile/app/screens/ChatScreen.tsx';
import MeScreen from '../src/mobile/app/screens/MeScreen.tsx';
import { TrafficPage } from '../src/mobile/app/screens/me/TrafficPage.tsx';
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

test('MeScreen hides recharge but preserves redeem and the rest of the account screen', () => {
  mobileI18n.setLanguage('en');
  const hidden = renderToStaticMarkup(<MeScreen onOpenRecharge={() => undefined} rechargeAllowed={false} />);
  assert.ok(!hidden.includes(t('mobile.me.rechargeEntry')));
  assert.ok(hidden.includes(t('mobile.me.redeemEntry')));
  assert.ok(hidden.includes(t('mobile.me.balanceTitle')));
  assert.ok(hidden.includes(t('mobile.me.accountTitle')));

  const visible = renderToStaticMarkup(<MeScreen onOpenRecharge={() => undefined} rechargeAllowed />);
  assert.ok(visible.includes(t('mobile.me.rechargeEntry')));
  assert.ok(visible.includes(t('mobile.me.redeemEntry')));
});

test('TrafficPage hides its recharge entry when native iOS policy disallows it, keeps redeem and the rest of the page', () => {
  mobileI18n.setLanguage('en');
  const rechargeButton = `>${t('mobile.me.rechargeEntry')}</button>`;
  const hidden = renderToStaticMarkup(
    <TrafficPage onBack={() => undefined} onOpenRecharge={() => undefined} rechargeAllowed={false} />,
  );
  assert.ok(hidden.includes('me-page-traffic'));
  assert.ok(!hidden.includes(rechargeButton));
  assert.ok(hidden.includes(t('mobile.me.redeemEntry')));
  assert.ok(hidden.includes(t('mobile.me.traffic.freeGrantClaim')));
  assert.ok(hidden.includes(t('mobile.me.traffic.ledgerTitle')));

  // Legacy call shape (no rechargeAllowed prop) and explicit true keep the
  // button — the non-iOS render is byte-for-byte unchanged.
  const legacyVisible = renderToStaticMarkup(
    <TrafficPage onBack={() => undefined} onOpenRecharge={() => undefined} />,
  );
  assert.ok(legacyVisible.includes(rechargeButton));

  const visible = renderToStaticMarkup(
    <TrafficPage onBack={() => undefined} onOpenRecharge={() => undefined} rechargeAllowed />,
  );
  assert.ok(visible.includes(rechargeButton));
  assert.ok(visible.includes(t('mobile.me.redeemEntry')));
});
