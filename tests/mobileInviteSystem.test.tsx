import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  isMeExpiredInviteTrial,
  isMeSubscribed,
  isMeTrialSubscription,
  meActivePlanId,
  meActiveTierKey,
  meTrialDaysUntilHibernation,
  patchMeStoreForTests,
  resetMeStoreForTests,
  type MobileMeInviteStatus,
  type MobileMePlan,
  type MobileMeSubscription,
} from '../src/mobile/app/me/mePointsStore.ts';
import {
  InvitePage,
  buildInviteShareUrl,
  countUsableInviteCodes,
  selectPrimaryInviteCode,
  sortInviteCodes,
} from '../src/mobile/app/screens/me/InvitePage.tsx';
import ChatScreen from '../src/mobile/app/screens/ChatScreen.tsx';
import TasksScreen from '../src/mobile/app/screens/TasksScreen.tsx';
import { BotAutomationSection } from '../src/mobile/app/automation/BotAutomationSection.tsx';
import { mobileI18n } from '../src/mobile/i18n.ts';
import type { useChat } from '../src/mobile/app/hooks/useChat.ts';
import type { MobileMetabot } from '../src/mobile/bridge/types.ts';

const PLANS: MobileMePlan[] = [
  {
    planId: 'me_standard',
    tier: 'standard',
    name: 'ID.Pupil',
    nameEn: 'ID.Pupil',
    priceCny: 29,
    weeklyMeMilli: 8_000_000,
    monthlyBonusMilli: 0,
  },
  {
    planId: 'me_pro',
    tier: 'pro',
    name: 'ID.Student',
    nameEn: 'ID.Student',
    priceCny: 99,
    weeklyMeMilli: 35_000_000,
    monthlyBonusMilli: 0,
  },
];

test('trial helpers & anti-arbitrage: active invite_trial never blocks paid Pupil subscription as downgrade', () => {
  const nowMs = 1_780_000_000_000;
  const activeTrial: MobileMeSubscription = {
    statusText: 'active',
    raw: {
      status: 'active',
      subscribedPlanId: 'me_pro',
      sourceType: 'invite_trial',
      isTrial: true,
      periodEnd: Math.floor((nowMs + 10 * 86_400_000) / 1000),
    },
  };
  assert.equal(isMeSubscribed(activeTrial), true);
  assert.equal(isMeTrialSubscription(activeTrial), true);
  assert.equal(isMeExpiredInviteTrial(activeTrial, nowMs), false);
  assert.equal(meTrialDaysUntilHibernation(activeTrial, nowMs), null);
  assert.equal(meActivePlanId(activeTrial), 'me_pro');
  // Anti-arbitrage pin: active invite_trial yields '' tier key so MeTierCards / MePurchaseScreen
  // treat every real paid tier (including ID.Pupil me_standard) as purchasable, not a downgrade.
  assert.equal(meActiveTierKey(activeTrial), '');

  const paidPro: MobileMeSubscription = {
    statusText: 'active',
    raw: {
      status: 'active',
      subscribedPlanId: 'me_pro',
      tier: 'pro',
      sourceType: 'order',
      isTrial: false,
      periodEnd: Math.floor((nowMs + 25 * 86_400_000) / 1000),
    },
  };
  assert.equal(isMeTrialSubscription(paidPro), false);
  assert.equal(meActiveTierKey(paidPro), 'pro');
  assert.equal(PLANS.find((p) => p.planId === meActivePlanId(paidPro))?.tier, 'pro');
});

test('trial expiry & 7-day hibernation countdown distinguish invite_trial from paid expiry', () => {
  const nowMs = 1_780_000_000_000;
  const expiredTwoDaysAgo: MobileMeSubscription = {
    statusText: 'expired',
    raw: {
      status: 'expired',
      subscribedPlanId: 'me_pro',
      sourceType: 'invite_trial',
      isTrial: true,
      periodEnd: Math.floor((nowMs - 2 * 86_400_000) / 1000),
    },
  };
  assert.equal(isMeSubscribed(expiredTwoDaysAgo), false);
  assert.equal(meActivePlanId(expiredTwoDaysAgo), '');
  assert.equal(isMeExpiredInviteTrial(expiredTwoDaysAgo, nowMs), true);
  assert.equal(meTrialDaysUntilHibernation(expiredTwoDaysAgo, nowMs), 5);

  const expiredNineDaysAgo: MobileMeSubscription = {
    statusText: 'expired',
    raw: {
      status: 'expired',
      sourceType: 'invite_trial',
      periodEnd: Math.floor((nowMs - 9 * 86_400_000) / 1000),
    },
  };
  assert.equal(isMeExpiredInviteTrial(expiredNineDaysAgo, nowMs), true);
  assert.equal(meTrialDaysUntilHibernation(expiredNineDaysAgo, nowMs), 0);

  const expiredPaidOrder: MobileMeSubscription = {
    statusText: 'expired',
    raw: {
      status: 'expired',
      sourceType: 'order',
      isTrial: false,
      periodEnd: Math.floor((nowMs - 2 * 86_400_000) / 1000),
    },
  };
  assert.equal(isMeExpiredInviteTrial(expiredPaidOrder, nowMs), false);
});

test('invite URL & code selection helpers prioritize active unused codes', () => {
  assert.equal(buildInviteShareUrl('IDB-7K9M-X4'), 'https://idbots.world/?invite=IDB-7K9M-X4');
  const codes: MobileMeInviteStatus['codes'] = [
    { code: 'IDB-USED-1', status: 1, maxUses: 1, usedCount: 1, activatedCount: 1, createdAt: 200, invitees: [] },
    { code: 'IDB-OPEN-2', status: 1, maxUses: 1, usedCount: 0, activatedCount: 0, createdAt: 100, invitees: [] },
  ];
  assert.equal(selectPrimaryInviteCode(codes)?.code, 'IDB-OPEN-2');
  assert.equal(countUsableInviteCodes(codes), 1);
});

test('InvitePage SSR: eligible view shows code, plan+days perk without cash price, refill CTA, and history', () => {
  const prevLang = mobileI18n.getLanguage();
  const statusFixture: MobileMeInviteStatus = {
    identityAddress: 'mvc1owner',
    issueEnabled: true,
    eligible: true,
    eligibleReason: 'paid_subscriber',
    progress: {
      accountAgeDays: 14,
      requiredAgeDays: 7,
      totalSpentMilli: 8_000_000,
      requiredSpentMilli: 5_000_000,
      paidBypassEnabled: true,
      hasPaidSubscription: true,
      isTrialSubscription: false,
    },
    totalQuota: 2,
    usedQuota: 1,
    remainingQuota: 1,
    defaultGrant: {
      planId: 'me_pro',
      planName: 'ID.Student',
      planNameEn: 'ID.Student',
      periodDays: 14,
    },
    codes: [
      {
        code: 'IDB-7K9M-X4',
        status: 1,
        maxUses: 1,
        usedCount: 0,
        activatedCount: 1,
        createdAt: 1_780_000_000_000,
        invitees: [
          {
            status: 2,
            phoneMasked: '+86 139****8899',
            reservedAt: 1_780_000_000_000,
            activatedAt: 1_780_000_060_000,
            rewardGranted: true,
          },
        ],
      },
    ],
    refill: {
      availableCount: 1,
      earnedTotal: 1,
      usedTotal: 0,
    },
  };
  try {
    mobileI18n.setLanguage('zh');
    patchMeStoreForTests({ inviteStatus: statusFixture, inviteLoading: false });
    const html = renderToStaticMarkup(
      React.createElement(InvitePage, { onBack: () => undefined, onOpenSubscribe: () => undefined }),
    );
    assert.match(html, /data-testid="invite-code-card"/);
    assert.match(html, /IDB-7K9M-X4/);
    assert.match(html, /data-testid="invite-quota-summary"/);
    assert.match(html, /data-testid="invite-generate-next-btn"/);
    assert.match(html, /14 天 ID\.Student/);
    assert.doesNotMatch(html, /100\s*元|¥\s*100/, 'must never mention ¥100 cash value');
    assert.match(html, /data-testid="invite-claim-refill-open"/);
    assert.match(html, /data-testid="invite-history-card"/);
    assert.match(html, /\+86 139\*\*\*\*8899/);
  } finally {
    resetMeStoreForTests();
    mobileI18n.setLanguage(prevLang);
  }
});

test('InvitePage SSR: multi-code quota shows generate-next regardless of unused codes and lists all codes', () => {
  const prevLang = mobileI18n.getLanguage();
  const multiCodeFixture: MobileMeInviteStatus = {
    identityAddress: 'mvc1owner5',
    issueEnabled: true,
    eligible: true,
    eligibleReason: 'extra_quota',
    progress: {
      accountAgeDays: 14,
      requiredAgeDays: 7,
      totalSpentMilli: 8_000_000,
      requiredSpentMilli: 5_000_000,
      paidBypassEnabled: true,
      hasPaidSubscription: true,
      isTrialSubscription: false,
    },
    totalQuota: 5,
    usedQuota: 2,
    remainingQuota: 3,
    defaultGrant: {
      planId: 'me_pro',
      planName: 'ID.Student',
      planNameEn: 'ID.Student',
      periodDays: 14,
    },
    codes: [
      {
        code: 'IDB-USED-01',
        status: 1,
        maxUses: 1,
        usedCount: 1,
        activatedCount: 1,
        createdAt: 1_780_000_000_000,
        invitees: [],
      },
      {
        code: 'IDB-OPEN-02',
        status: 1,
        maxUses: 1,
        usedCount: 0,
        activatedCount: 0,
        createdAt: 1_780_000_100_000,
        invitees: [],
      },
      {
        code: 'IDB-OPEN-03',
        status: 1,
        maxUses: 1,
        usedCount: 0,
        activatedCount: 0,
        createdAt: 1_780_000_200_000,
        invitees: [],
      },
    ],
    refill: {
      availableCount: 0,
      earnedTotal: 1,
      usedTotal: 1,
    },
  };
  try {
    const sorted = sortInviteCodes(multiCodeFixture.codes);
    assert.deepEqual(
      sorted.map((c) => c.code),
      ['IDB-OPEN-03', 'IDB-OPEN-02', 'IDB-USED-01'],
    );

    mobileI18n.setLanguage('zh');
    patchMeStoreForTests({ inviteStatus: multiCodeFixture, inviteLoading: false });
    const zhHtml = renderToStaticMarkup(
      React.createElement(InvitePage, { onBack: () => undefined, onOpenSubscribe: () => undefined }),
    );
    assert.match(zhHtml, /共 5 个名额 · 待分享 2 · 可生成 3/);
    assert.match(zhHtml, /data-testid="invite-generate-next-btn"/);
    assert.match(zhHtml, /再生成 1 个邀请码（剩余 3）/);
    assert.match(zhHtml, /data-testid="invite-code-list"/);
    assert.match(zhHtml, /data-testid="invite-code-item-IDB-OPEN-03"/);
    assert.match(zhHtml, /data-testid="invite-code-item-IDB-OPEN-02"/);
    assert.match(zhHtml, /data-testid="invite-code-item-IDB-USED-01"/);
    assert.match(zhHtml, /data-testid="invite-list-copy-IDB-OPEN-02"/);
    assert.match(zhHtml, /data-testid="invite-list-link-IDB-OPEN-02"/);
    assert.match(zhHtml, /data-testid="invite-list-poster-IDB-OPEN-02"/);

    mobileI18n.setLanguage('en');
    const enHtml = renderToStaticMarkup(
      React.createElement(InvitePage, { onBack: () => undefined, onOpenSubscribe: () => undefined }),
    );
    assert.match(enHtml, /5 total · 2 ready · 3 ungenerated/);
    assert.match(enHtml, /Generate another code \(3 left\)/);
    assert.match(enHtml, /All invite codes \(3\)/);
  } finally {
    resetMeStoreForTests();
    mobileI18n.setLanguage(prevLang);
  }
});

test('InvitePage SSR: locked trial user sees dual-track progress, anti-arbitrage trial hint, and subscribe CTA', () => {
  const prevLang = mobileI18n.getLanguage();
  const lockedTrialFixture: MobileMeInviteStatus = {
    identityAddress: 'mvc1trial',
    issueEnabled: true,
    eligible: false,
    eligibleReason: '',
    progress: {
      accountAgeDays: 3,
      requiredAgeDays: 7,
      totalSpentMilli: 2_100_000,
      requiredSpentMilli: 5_000_000,
      paidBypassEnabled: true,
      hasPaidSubscription: false,
      isTrialSubscription: true,
    },
    totalQuota: 0,
    usedQuota: 0,
    remainingQuota: 0,
    defaultGrant: {
      planId: 'me_pro',
      planName: 'ID.Student',
      planNameEn: 'ID.Student',
      periodDays: 14,
    },
    codes: [],
    refill: { availableCount: 0, earnedTotal: 0, usedTotal: 0 },
  };
  try {
    mobileI18n.setLanguage('zh');
    patchMeStoreForTests({ inviteStatus: lockedTrialFixture, inviteLoading: false });
    const html = renderToStaticMarkup(
      React.createElement(InvitePage, { onBack: () => undefined, onOpenSubscribe: () => undefined }),
    );
    assert.match(html, /data-testid="invite-locked-card"/);
    assert.match(html, /3 \/ 7 天/);
    assert.match(html, /2,100 \/ 5,000 ME/);
    assert.match(html, /体验期套餐不直接解锁邀请码/);
    assert.match(html, /data-testid="invite-locked-subscribe"/);
  } finally {
    resetMeStoreForTests();
    mobileI18n.setLanguage(prevLang);
  }
});

test('Trial-expired gate Variant A: ChatScreen, TasksScreen, and BotAutomationSection block turns while keeping history readable', () => {
  const prevLang = mobileI18n.getLanguage();
  const expiredSub: MobileMeSubscription = {
    statusText: 'expired',
    raw: {
      status: 'expired',
      sourceType: 'invite_trial',
      isTrial: true,
      periodEnd: Math.floor((Date.now() - 2 * 86_400_000) / 1000),
    },
  };
  type Chat = ReturnType<typeof useChat>;
  const chatMock: Chat = {
    messages: [{ id: 'm1', role: 'assistant', text: 'History message still readable', streaming: false }],
    activityMessages: [],
    sessions: [],
    sessionId: 's1',
    sessionTitle: 'Past Session',
    metabotId: 1,
    isStreaming: false,
    permission: null,
    pendingPermissionCount: 0,
    toolCalls: [],
    quotaExhausted: false,
    quotaKind: null,
    setMetabotId: () => undefined,
    reloadSessions: async () => undefined,
    openSession: async () => true,
    newChat: () => undefined,
    send: async () => undefined,
    stop: async () => undefined,
    respondPermission: async () => undefined,
    dismissPermission: () => undefined,
    dismissQuota: () => undefined,
    applyResync: () => undefined,
    getOpenSessionId: () => 's1',
    getStreamingMessage: () => null,
  } as unknown as Chat;

  const botFixture: MobileMetabot = {
    id: 1,
    name: 'Nova',
    role: 'Twin',
    metabot_type: 'twin',
    enabled: true,
    chain_sync_state: 'synced',
  } as unknown as MobileMetabot;

  try {
    mobileI18n.setLanguage('zh');
    patchMeStoreForTests({ subscription: expiredSub });

    const chatHtml = renderToStaticMarkup(
      React.createElement(ChatScreen, {
        chat: chatMock,
        bots: [],
        onOpenRecharge: () => undefined,
        onOpenSubscribe: () => undefined,
      }),
    );
    assert.match(chatHtml, /History message still readable/);
    assert.match(chatHtml, /data-testid="chat-trial-expired-bar"/);
    assert.match(chatHtml, /data-testid="chat-trial-subscribe-cta"/);
    assert.doesNotMatch(chatHtml, /data-testid="chat-composer-input"/);

    const tasksHtml = renderToStaticMarkup(
      React.createElement(TasksScreen, {
        twinMetabotId: 1,
        twinName: 'Nova',
        onOpenSession: async () => true,
        onOpenSubscribe: () => undefined,
      }),
    );
    assert.match(tasksHtml, /data-testid="tasks-trial-expired-bar"/);
    assert.match(tasksHtml, /data-testid="tasks-trial-subscribe-cta"/);
    assert.match(tasksHtml, /<button[^>]*disabled=""[^>]*data-testid="task-center-create"/);

    const autoHtml = renderToStaticMarkup(
      React.createElement(BotAutomationSection, {
        bot: botFixture,
        actions: {
          setBotEnabled: async () => ({ state: 'synced' }),
          syncBot: async () => ({ state: 'synced' }),
          resumeBot: async () => ({ state: 'synced' }),
        },
        onOpenSubscribe: () => undefined,
      }),
    );
    assert.match(autoHtml, /data-testid="automation-trial-expired-bar"/);
    assert.match(autoHtml, /<button[^>]*disabled=""[^>]*data-testid="bot-surf-run-now"/);
  } finally {
    resetMeStoreForTests();
    mobileI18n.setLanguage(prevLang);
  }
});
