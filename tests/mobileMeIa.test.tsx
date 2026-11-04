import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import MeScreen from '../src/mobile/app/screens/MeScreen.tsx';
import {
  ME_ENTRIES,
  ME_ENTRY_GROUPS,
  meEntriesForGroup,
} from '../src/mobile/app/screens/me/registry.ts';
import { ProfilePage } from '../src/mobile/app/screens/me/ProfilePage.tsx';
import { UsageCreditsPage } from '../src/mobile/app/screens/me/UsageCreditsPage.tsx';
import { BotsPage } from '../src/mobile/app/screens/me/BotsPage.tsx';
import { BotEditPage } from '../src/mobile/app/screens/me/BotEditPage.tsx';
import { SkillsPage } from '../src/mobile/app/screens/me/SkillsPage.tsx';
import { MemoryPage } from '../src/mobile/app/screens/me/MemoryPage.tsx';
import { GeneralPage } from '../src/mobile/app/screens/me/GeneralPage.tsx';
import { AccountDeleteSheet, AccountPage } from '../src/mobile/app/screens/me/AccountPage.tsx';
import { WeixinBindPage, classifyWeixinPoll } from '../src/mobile/app/screens/me/WeixinBindPage.tsx';
import { AboutPage } from '../src/mobile/app/screens/me/AboutPage.tsx';
import { mobileI18n } from '../src/mobile/i18n.ts';
import type { MobileUserIdentity } from '../src/mobile/app/hooks/useIdentity.ts';

/**
 * A6 settings IA rework (IA-PLAN v1): structural (SSR) pins for the entry
 * registry and every secondary page shell. Live-data behavior (summaries,
 * navigation, back/dirty flow) is covered by the Playwright suite
 * (e2e/mobile/me-ia.spec.ts) — renderToStaticMarkup never runs effects.
 */

test('registry: eight list entries in three groups, profile rides the card', () => {
  assert.deepEqual(
    ME_ENTRIES.map((entry) => entry.id),
    ['bots', 'weixinBind', 'usage', 'skills', 'memory', 'general', 'account', 'about'],
  );
  assert.deepEqual(ME_ENTRY_GROUPS.map((group) => group.group), ['bots', 'general', 'account']);
  // The bots group renders without a heading (My Bots + WeChat bot rows on top).
  assert.equal(ME_ENTRY_GROUPS[0].titleKey, null);
  assert.deepEqual(meEntriesForGroup('bots').map((entry) => entry.id), ['bots', 'weixinBind']);
  assert.deepEqual(meEntriesForGroup('general').map((entry) => entry.id), ['usage', 'skills', 'memory', 'general']);
  assert.deepEqual(meEntriesForGroup('account').map((entry) => entry.id), ['account', 'about']);
  // profile is NOT a registry row (card entry, IA-PLAN §2.1); the retired
  // traffic route is gone from the navigation surface (S9 §3 下线清单).
  assert.equal(ME_ENTRIES.some((entry) => entry.id === 'profile'), false);
  assert.equal(ME_ENTRIES.some((entry) => entry.id === 'traffic'), false);
  // Every entry carries a unique testid + title key; danger is reserved and unused.
  const testIds = new Set(ME_ENTRIES.map((entry) => entry.testId));
  assert.equal(testIds.size, ME_ENTRIES.length);
  for (const entry of ME_ENTRIES) {
    assert.match(entry.titleKey, /^mobile\.me\./);
    assert.notEqual(entry.danger, true);
  }
});

test('primary page renders user card, ME points hero and the registry rows', () => {
  const html = renderToStaticMarkup(React.createElement(MeScreen, {
    canPurchase: true,
    onOpenPurchase: () => undefined,
  }));
  assert.match(html, /data-testid="user-card"/);
  assert.match(html, /data-testid="me-points-hero"/);
  assert.match(html, /data-testid="me-balance-chip"/);
  assert.match(html, /data-testid="me-topup-locked"/);
  // The old traffic/quota balance card is retired (S9 §3).
  assert.doesNotMatch(html, /data-testid="balance-card"/);
  for (const entry of ME_ENTRIES) {
    assert.match(html, new RegExp(`data-testid="${entry.testId}"`), entry.testId);
  }
  assert.match(html, /data-testid="me-group-bots"/);
  assert.match(html, /data-testid="me-group-general"/);
  assert.match(html, /data-testid="me-group-account"/);
  // Old flat sections are gone from the primary page.
  assert.doesNotMatch(html, /data-testid="bot-create"/);
});

const identityFixture: MobileUserIdentity = {
  id: 1,
  path: "m/44'/10001'/0'/0/0",
  mvc_address: 'mvc1abcdef',
  btc_address: 'btc1',
  doge_address: 'doge1',
  public_key: 'pk',
  chat_public_key: 'ck',
  chat_public_key_pin_id: null,
  metaid: 'metaid-1',
  globalmetaid: 'idq1abcdefghij',
  name: 'Owner',
  avatar: null,
  subsidy_state: 'claimed',
  subsidy_error: null,
  name_pin_id: null,
  avatar_pin_id: null,
  sync_state: 'synced',
  sync_error: null,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
};

test('profile page: explicit save disabled while clean, identity rows, sync ok', () => {
  const html = renderToStaticMarkup(
    React.createElement(ProfilePage, { identity: identityFixture, onBack: () => undefined }),
  );
  assert.match(html, /data-testid="me-page-profile"/);
  assert.match(html, /data-testid="profile-name"/);
  assert.match(html, /value="Owner"/);
  // Save starts disabled (clean form) — IA-PLAN §2.5 rule 1.
  assert.match(html, /data-testid="profile-save"[^>]*disabled/);
  assert.match(html, /idq1abcdefghij/);
  assert.match(html, /mvc1abcdef/);
  // Healthy sync: retry buttons must NOT render (IA-PLAN §4.3).
  assert.match(html, /data-sync-ok="yes"/);
  assert.doesNotMatch(html, /data-testid="profile-retry-sync"/);
});

test('profile page: abnormal sync renders retry actions and the error text', () => {
  const abnormal: MobileUserIdentity = {
    ...identityFixture,
    sync_state: 'partial',
    sync_error: 'mock sync error',
  };
  const html = renderToStaticMarkup(
    React.createElement(ProfilePage, { identity: abnormal, onBack: () => undefined }),
  );
  assert.match(html, /data-sync-ok="no"/);
  assert.match(html, /data-testid="profile-retry-sync"/);
  assert.match(html, /data-testid="profile-retry-subsidy"/);
  assert.match(html, /mock sync error/);
});

test('usage & credits page: balance, ledger, orders, rates and compliance sections', () => {
  const html = renderToStaticMarkup(
    React.createElement(UsageCreditsPage, { onBack: () => undefined }),
  );
  assert.match(html, /data-testid="me-page-usage"/);
  assert.match(html, /data-testid="usage-history"/);
  assert.match(html, /data-testid="usage-orders"/);
  assert.match(html, /data-testid="usage-rates"/);
  assert.match(html, /data-testid="usage-compliance"/);
  // The retired traffic surface must not reappear anywhere on this page.
  assert.doesNotMatch(html, /data-testid="me-page-traffic"/);
  assert.doesNotMatch(html, /data-testid="traffic-ledger-empty"/);
});

test('bots page renders the create action and list shell; bot edit page shells', () => {
  const bots = renderToStaticMarkup(
    React.createElement(BotsPage, { onBack: () => undefined, onOpenEdit: () => undefined }),
  );
  assert.match(bots, /data-testid="me-page-bots"/);
  assert.match(bots, /data-testid="bot-create"/);
  // SSR renders the loading state (effects never run); the empty state is an
  // effect-era view covered by e2e.
  assert.match(bots, /Loading/);

  const edit = renderToStaticMarkup(
    React.createElement(BotEditPage, { botId: null, onBack: () => undefined, onSaved: () => undefined }),
  );
  assert.match(edit, /data-testid="me-page-bot-edit"/);
});

test('remaining secondary pages render their shells', () => {
  assert.match(
    renderToStaticMarkup(React.createElement(SkillsPage, { onBack: () => undefined })),
    /data-testid="me-page-skills"/,
  );
  assert.match(
    renderToStaticMarkup(React.createElement(SkillsPage, { onBack: () => undefined })),
    /data-testid="skills-empty"/,
  );
  assert.match(
    renderToStaticMarkup(React.createElement(MemoryPage, { onBack: () => undefined })),
    /data-testid="me-page-memory"/,
  );
  assert.match(
    renderToStaticMarkup(React.createElement(MemoryPage, { onBack: () => undefined })),
    /data-testid="memory-row-memoryEnabled"/,
  );
  assert.match(
    renderToStaticMarkup(React.createElement(GeneralPage, { onBack: () => undefined })),
    /data-testid="me-page-general"/,
  );
  assert.match(
    renderToStaticMarkup(React.createElement(AccountPage, { onBack: () => undefined })),
    /data-testid="account-logout"/,
  );
  assert.match(
    renderToStaticMarkup(React.createElement(AccountPage, { onBack: () => undefined })),
    /data-testid="account-delete"/,
  );
  const about = renderToStaticMarkup(React.createElement(AboutPage, { onBack: () => undefined }));
  assert.match(about, /data-testid="about-link-terms"/);
  assert.match(about, /data-testid="about-link-privacy"/);
  assert.match(about, /data-testid="about-link-custody"/);
});

// --- WeChat bot binding page -------------------------------------------------

test('weixin bind page: mock environments render the unavailable note, never a bind button', () => {
  // SSR has no bridge (and the mock bridge has no `im` facade either), so the
  // page must degrade instead of throwing.
  const html = renderToStaticMarkup(React.createElement(WeixinBindPage, { onBack: () => undefined }));
  assert.match(html, /data-testid="weixin-bind-unavailable"/);
  assert.doesNotMatch(html, /data-testid="weixin-bind-start"/);
});

test('weixin bind poll classifier: connected wins, pending reads as waiting, quiet pending-free reads as expired', () => {
  assert.equal(classifyWeixinPoll({ loginState: 'idle', loginPending: false, connected: true }, null), 'connected');
  assert.equal(classifyWeixinPoll({ loginState: 'wait', loginPending: true, connected: false }, null), 'waiting');
  assert.equal(classifyWeixinPoll({ loginState: 'scanned', loginPending: true, connected: false }, null), 'scanned');
  // Confirm+start lag: credentials exist before `connected` flips true.
  assert.equal(classifyWeixinPoll({ loginState: 'idle', loginPending: false, connected: false }, true), 'connected');
  // Terminal states clear pendingQr: quiet + no credentials = the QR died.
  assert.equal(classifyWeixinPoll({ loginState: 'idle', loginPending: false, connected: false }, null), 'expired');
});

// --- account deletion typed-confirmation gate --------------------------------
//
// The delete sheet only renders after a tap, which SSR cannot produce, so the
// sheet body is factored into the presentational AccountDeleteSheet and pinned
// here directly (repo test stack is SSR-only, no jsdom). Language is set
// explicitly per test and restored — mobileI18n is a process-wide singleton.

type DeleteSheetProps = Parameters<typeof AccountDeleteSheet>[0];

function renderDeleteSheet(confirmText: string, overrides: Partial<DeleteSheetProps> = {}): string {
  return renderToStaticMarkup(
    React.createElement(AccountDeleteSheet, {
      busy: false,
      done: false,
      reason: '',
      confirmText,
      onReasonChange: () => undefined,
      onConfirmTextChange: () => undefined,
      onCancel: () => undefined,
      onConfirm: () => undefined,
      ...overrides,
    }),
  );
}

// The static-markup attribute form is ` disabled=""`; a bare /disabled/ would
// vacuously match the tailwind class token `disabled:opacity-40` in class="…".
const DISABLED_ATTR = /\sdisabled="/;

function confirmButtonTag(html: string): string {
  const match = html.match(/<button[^>]*data-testid="account-delete-confirm"[^>]*>/);
  assert.ok(match, 'the delete confirm button must render');
  return match[0];
}

test('delete sheet (zh): gate locked initially, prompt shows the exact phrase 「删除」', () => {
  const previous = mobileI18n.getLanguage();
  try {
    mobileI18n.setLanguage('zh');
    const closed = renderDeleteSheet('');
    assert.match(confirmButtonTag(closed), DISABLED_ATTR);
    assert.match(closed, /data-testid="account-delete-confirm-prompt"/);
    assert.match(closed, /输入「删除」以确认删除。/);
    assert.match(closed, /data-testid="account-delete-confirm-input"/);
    assert.match(closed, /data-confirm-phrase="删除"/);
    // The optional reason field still renders below the gate.
    assert.match(closed, /删除原因（可选）/);
  } finally {
    mobileI18n.setLanguage(previous);
  }
});

test('delete sheet (zh): only the exact phrase unlocks the confirm button', () => {
  const previous = mobileI18n.getLanguage();
  try {
    mobileI18n.setLanguage('zh');
    assert.doesNotMatch(confirmButtonTag(renderDeleteSheet('删除')), DISABLED_ATTR);
    assert.match(confirmButtonTag(renderDeleteSheet('删除 ')), DISABLED_ATTR); // trailing space
    assert.match(confirmButtonTag(renderDeleteSheet(' 删除')), DISABLED_ATTR); // leading space
    assert.match(confirmButtonTag(renderDeleteSheet('删除删')), DISABLED_ATTR); // wrong text
    // busy keeps the button locked even with a satisfied gate.
    assert.match(confirmButtonTag(renderDeleteSheet('删除', { busy: true })), DISABLED_ATTR);
  } finally {
    mobileI18n.setLanguage(previous);
  }
});

test('delete sheet (en): gate is exact and case-sensitive around "DELETE"', () => {
  const previous = mobileI18n.getLanguage();
  try {
    mobileI18n.setLanguage('en');
    const closed = renderDeleteSheet('');
    assert.match(confirmButtonTag(closed), DISABLED_ATTR);
    assert.match(closed, /data-testid="account-delete-confirm-prompt"/);
    assert.match(closed, /Type .*DELETE.* to confirm deletion\./);
    assert.match(closed, /data-confirm-phrase="DELETE"/);
    assert.doesNotMatch(confirmButtonTag(renderDeleteSheet('DELETE')), DISABLED_ATTR);
    assert.match(confirmButtonTag(renderDeleteSheet('Delete')), DISABLED_ATTR); // case mismatch
    assert.match(confirmButtonTag(renderDeleteSheet('DELETE ')), DISABLED_ATTR); // trailing space
  } finally {
    mobileI18n.setLanguage(previous);
  }
});

test('delete sheet wiring: gate resets on sheet open; deletion call sequence untouched', () => {
  const source = readFileSync(
    new URL('../src/mobile/app/screens/me/AccountPage.tsx', import.meta.url),
    'utf8',
  );
  // Opening the delete sheet resets the typed confirmation (fail closed next time).
  assert.match(source, /setConfirmText\(''\)/);
  // The confirm button is gated on the typed phrase (in addition to busy).
  assert.match(source, /disabled=\{props\.busy \|\| !gateSatisfied\}/);
  // The deletion request call sequence is unchanged (reason still trimmed/optional).
  assert.match(source, /requestAccountDeletion\(reason\.trim\(\) \|\| undefined\)/);
  // Cancel still just closes the sheet — no deletion side effects on the cancel path.
  assert.match(source, /onCancel=\{\(\) => setSheet\(null\)\}/);
});
