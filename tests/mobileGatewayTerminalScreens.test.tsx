import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  TenantUnavailableScreen,
  TooManyDevicesScreen,
  VersionMismatchScreen,
  exitTooManyDevices,
} from '../src/mobile/app/components/GatewayTerminalScreens.tsx';
import { mobileI18n, t } from '../src/mobile/i18n.ts';

/**
 * 4009 too-many-devices exit (REQ-E-2 C2 close code 4009): the screen must
 * explain what happened (device limit reached, another device's sign-out
 * frees a slot) and offer a working path back — logout via the HTTP control
 * plane (the gateway client has no logout/session RPC) then a hard navigate
 * to /login. The 4013 and version-mismatch screens must stay unchanged
 * (no exit button).
 */

test('exitTooManyDevices signs out then navigates to /login', async () => {
  const order: string[] = [];
  await exitTooManyDevices({
    doLogout: async () => {
      order.push('logout');
    },
    navigate: (url) => {
      order.push(`navigate:${url}`);
    },
  });
  assert.deepEqual(order, ['logout', 'navigate:/login']);
});

test('exitTooManyDevices still navigates when the control plane fails', async () => {
  const navigated: string[] = [];
  await exitTooManyDevices({
    doLogout: async () => {
      throw new Error('HTTP_503');
    },
    navigate: (url) => {
      navigated.push(url);
    },
  });
  assert.deepEqual(navigated, ['/login']);
});

test('TooManyDevicesScreen renders explanation and an enabled exit button in zh and en', () => {
  for (const language of ['zh', 'en'] as const) {
    mobileI18n.setLanguage(language);
    const markup = renderToStaticMarkup(<TooManyDevicesScreen />);
    assert.ok(markup.includes('data-testid="gateway-too-many-devices"'), `${language}: screen testid`);
    assert.ok(markup.includes(t('mobile.gateway.tooManyDevicesTitle')), `${language}: title copy`);
    assert.ok(markup.includes(t('mobile.gateway.tooManyDevicesBody')), `${language}: body copy`);
    assert.ok(
      markup.includes('data-testid="gateway-too-many-devices-exit"'),
      `${language}: exit button testid`,
    );
    assert.ok(
      markup.includes(`>${t('mobile.gateway.tooManyDevicesAction')}</button>`),
      `${language}: exit button label`,
    );
    assert.ok(!markup.includes('disabled="'), `${language}: exit button starts enabled`);
    // The body must explain the remedy (slot freed by signing out elsewhere).
    assert.ok(
      t('mobile.gateway.tooManyDevicesBody').length > 0,
      `${language}: body copy non-empty`,
    );
  }
});

test('other terminal screens stay exit-free (4013, version mismatch)', () => {
  mobileI18n.setLanguage('en');
  const tenant = renderToStaticMarkup(<TenantUnavailableScreen />);
  assert.ok(tenant.includes('data-testid="gateway-tenant-unavailable"'));
  assert.ok(!tenant.includes('<button'), '4013 screen must not gain a button');
  assert.ok(!tenant.includes('too-many-devices-exit'));

  const mismatch = renderToStaticMarkup(
    <VersionMismatchScreen mismatch={{ expected: 2, actual: 1 }} />,
  );
  assert.ok(mismatch.includes('data-testid="gateway-version-mismatch"'));
  assert.ok(!mismatch.includes('<button'), 'version-mismatch screen must not gain a button');
  assert.ok(!mismatch.includes('too-many-devices-exit'));
});
