// Weekly quota reset countdown precision (days + hours beyond 24h).
//
// Run: npx tsx --test tests/meResetCountdown.test.ts

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { meResetParts as desktopResetParts } from '../src/renderer/components/me/mePointsStore.ts';
import { meResetParts as mobileResetParts } from '../src/mobile/app/me/mePointsStore.ts';

const read = (rel: string): string => fs.readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', rel),
  'utf8',
);

test('reset countdown units: soon when past, whole hours inside 24h, days+hours beyond', () => {
  const now = Date.now();
  for (const parts of [desktopResetParts, mobileResetParts]) {
    assert.deepEqual(parts(0), null);
    assert.deepEqual(parts(null as never), null);
    assert.deepEqual(parts(now - 1_000), { unit: 'soon', n: 0 });
    assert.deepEqual(parts(now + 11 * 3_600_000), { unit: 'hours', n: 11 });
    assert.deepEqual(parts(now + 30 * 60_000), { unit: 'hours', n: 1 });
    // New user at registration: ~7 days minus a few seconds -> 6d 23h
    assert.deepEqual(parts(now + (7 * 86_400 - 15) * 1000), { unit: 'days', n: 6, hours: 23 });
    // Exact 7d+30m boundary -> 7d 0h
    assert.deepEqual(parts(now + (7 * 86_400 + 1800) * 1000), { unit: 'days', n: 7, hours: 0 });
  }
});

test('drift guard: desktop and mobile meResetParts agree across representative timestamps', () => {
  const now = Date.now();
  for (const ts of [0, now - 5_000, now + 45 * 60_000, now + 11 * 3_600_000, now + 167 * 3_600_000 + 60_000]) {
    assert.deepEqual(desktopResetParts(ts), mobileResetParts(ts));
  }
});

test('desktop and mobile surfaces wire the days+hours reset copy', () => {
  assert.match(read('src/renderer/components/me/IdbotsPlanCard.tsx'), /mePlanResetInDaysHours/);
  assert.match(read('src/renderer/components/me/MeBalanceOverviewCard.tsx'), /mePanelResetInDaysHours/);
  assert.match(read('src/renderer/components/me/MeBalanceBadge.tsx'), /mePanelResetInDaysHours/);
  assert.match(read('src/renderer/features/userProfile/MeCreditsPanel.tsx'), /meResetInDaysHours/);
  assert.match(read('src/mobile/app/components/MePointsHero.tsx'), /mobile\.me\.points\.resetDaysHours/);
  assert.match(read('src/mobile/app/screens/me/UsageCreditsPage.tsx'), /mobile\.me\.points\.resetDaysHours/);
});

test('days+hours reset copy exists in both locales across desktop, userProfile and mobile', () => {
  const desktop = read('src/renderer/services/i18n.ts');
  for (const key of ['mePanelResetInDaysHours', 'mePlanResetInDaysHours']) {
    const first = desktop.indexOf(`${key}: '`);
    assert.ok(first > 0, `desktop zh key missing: ${key}`);
    assert.ok(desktop.indexOf(`${key}: '`, first + 1) > 0, `desktop en key missing: ${key}`);
  }
  const userProfile = read('src/renderer/features/userProfile/i18n.ts');
  assert.match(userProfile, /meResetInDaysHours: '\{n\} 天 \{h\} 小时后重置'/);
  assert.match(userProfile, /meResetInDaysHours: 'Resets in \{n\}d \{h\}h'/);
  const mobile = read('src/mobile/i18n.ts');
  const firstMobile = mobile.indexOf("'mobile.me.points.resetDaysHours'");
  assert.ok(firstMobile > 0, 'mobile zh key missing: mobile.me.points.resetDaysHours');
  assert.ok(mobile.indexOf("'mobile.me.points.resetDaysHours'", firstMobile + 1) > 0, 'mobile en key missing: mobile.me.points.resetDaysHours');
});
