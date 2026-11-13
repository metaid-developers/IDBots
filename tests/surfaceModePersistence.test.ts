import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SURFACE_MODE_KV_KEY,
  normalizeStoredSurfaceMode,
  resolveInitialSurfaceMode,
} from '../src/renderer/features/botBrowser/surfaceModePersistence';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('normalizeStoredSurfaceMode accepts only home and browser', () => {
  assert.equal(normalizeStoredSurfaceMode('home'), 'home');
  assert.equal(normalizeStoredSurfaceMode('browser'), 'browser');
  assert.equal(normalizeStoredSurfaceMode(null), null);
  assert.equal(normalizeStoredSurfaceMode(undefined), null);
  assert.equal(normalizeStoredSurfaceMode(''), null);
  assert.equal(normalizeStoredSurfaceMode('studio'), null);
});

test('explicit localStorage surface mode wins across restarts (BotWorks stays BotWorks, Studio stays Studio)', () => {
  const botWorks = resolveInitialSurfaceMode({
    localStorageValue: 'home',
    kvStoreValue: 'home',
    currentVersion: '1.0.11-rc.1',
    firstInstallVersion: '1.0.11-rc.1',
    hasExistingBots: true,
    hasPersistedSessionId: true,
    onboardingEnterPending: false,
    needsWelcomeFlow: false,
  });
  assert.equal(botWorks.mode, 'home');
  assert.equal(botWorks.persistToLocalStorage, false);
  assert.equal(botWorks.persistToKvStore, false);

  const studio = resolveInitialSurfaceMode({
    localStorageValue: 'browser',
    kvStoreValue: null,
    currentVersion: '1.0.11-rc.1',
    firstInstallVersion: '1.0.10',
    hasExistingBots: true,
    hasPersistedSessionId: false,
    onboardingEnterPending: false,
    needsWelcomeFlow: false,
  });
  assert.equal(studio.mode, 'browser');
  assert.equal(studio.persistToLocalStorage, false);
  assert.equal(studio.persistToKvStore, true);
});

test('SQLite kv mirror rescues a missing localStorage slot after an abrupt exit', () => {
  const recovered = resolveInitialSurfaceMode({
    localStorageValue: null,
    kvStoreValue: 'home',
    currentVersion: '1.0.11-rc.1',
    firstInstallVersion: '1.0.11-rc.1',
    hasExistingBots: true,
    hasPersistedSessionId: false,
    onboardingEnterPending: false,
    needsWelcomeFlow: false,
  });
  assert.equal(recovered.mode, 'home');
  assert.equal(recovered.persistToLocalStorage, true);
  assert.equal(recovered.persistToKvStore, false);
});

test('brand-new user (fresh install, no prior history) defaults to Studio (browser)', () => {
  const freshOnboarding = resolveInitialSurfaceMode({
    localStorageValue: null,
    kvStoreValue: null,
    currentVersion: '1.0.11-rc.1',
    firstInstallVersion: '1.0.11-rc.1',
    hasExistingBots: false,
    hasPersistedSessionId: false,
    onboardingEnterPending: false,
    needsWelcomeFlow: true,
  });
  assert.equal(freshOnboarding.mode, 'browser');
  assert.equal(freshOnboarding.isUpgradingExistingUser, false);
  assert.equal(freshOnboarding.persistToLocalStorage, false);
  assert.equal(freshOnboarding.persistToKvStore, false);

  const freshMidEnter = resolveInitialSurfaceMode({
    localStorageValue: null,
    kvStoreValue: null,
    currentVersion: '1.0.11-rc.1',
    firstInstallVersion: '1.0.11-rc.1',
    hasExistingBots: true,
    hasPersistedSessionId: false,
    onboardingEnterPending: true,
    needsWelcomeFlow: true,
  });
  assert.equal(freshMidEnter.mode, 'browser');
  assert.equal(freshMidEnter.isUpgradingExistingUser, false);
});

test('upgrading legacy user with no saved surface mode defaults to BotWorks (home) and persists it', () => {
  const fromLegacyVersion = resolveInitialSurfaceMode({
    localStorageValue: null,
    kvStoreValue: null,
    currentVersion: '1.0.11-rc.1',
    firstInstallVersion: '1.0.10',
    hasExistingBots: true,
    hasPersistedSessionId: false,
    onboardingEnterPending: false,
    needsWelcomeFlow: false,
  });
  assert.equal(fromLegacyVersion.mode, 'home');
  assert.equal(fromLegacyVersion.isUpgradingExistingUser, true);
  assert.equal(fromLegacyVersion.persistToLocalStorage, true);
  assert.equal(fromLegacyVersion.persistToKvStore, true);

  // Even when upgrading from a pre-persistence RC sharing the same version string,
  // existing bots without a stored surface mode land on BotWorks.
  const fromSameVersionWithBots = resolveInitialSurfaceMode({
    localStorageValue: null,
    kvStoreValue: null,
    currentVersion: '1.0.11-rc.1',
    firstInstallVersion: '1.0.11-rc.1',
    hasExistingBots: true,
    hasPersistedSessionId: false,
    onboardingEnterPending: false,
    needsWelcomeFlow: false,
  });
  assert.equal(fromSameVersionWithBots.mode, 'home');
  assert.equal(fromSameVersionWithBots.isUpgradingExistingUser, true);
  assert.equal(fromSameVersionWithBots.persistToLocalStorage, true);
  assert.equal(fromSameVersionWithBots.persistToKvStore, true);
});

test('useBotBrowserShell, App, and main.ts wire surface persistence and shutdown flush', () => {
  const shellSource = read('src/renderer/features/botBrowser/useBotBrowserShell.ts');
  const appSource = read('src/renderer/App.tsx');
  const mainSource = read('src/main/main.ts');

  assert.equal(SURFACE_MODE_KV_KEY, 'botBrowser.surfaceMode');
  assert.match(shellSource, /persistSurfaceModeToKvStore/);
  assert.match(shellSource, /applyStartupSurfaceMode/);
  assert.match(appSource, /resolveInitialSurfaceMode\(/);
  assert.match(appSource, /applyStartupSurfaceModeRef\.current\?\.\(resolvedSurface\)/);
  assert.match(mainSource, /session\.defaultSession\?\.flushStorageData\(\)/);
});
