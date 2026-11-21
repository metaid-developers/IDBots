import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { UPDATE_HEARTBEAT_INTERVAL_MS, UPDATE_POLL_INTERVAL_MS } from '../src/renderer/services/appUpdate.ts';
import {
  AUTO_CHECK_UPDATES_STORAGE_KEY,
  loadAutoCheckUpdates,
  saveAutoCheckUpdates,
} from '../src/renderer/services/updatePreferences.ts';
import { startAppUpdatePolling } from '../src/renderer/services/appUpdatePolling.ts';
import {
  resolveFoundUpdateAction,
  runAppUpdateCheck,
} from '../src/renderer/services/appUpdateCheck.ts';
import {
  formatUpdateStatus,
  resolveUpdateStatus,
  selectChangeLogPreview,
  shouldShowUpdateDot,
} from '../src/renderer/services/softwareUpdateStatus.ts';

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

function installFakeLocalStorage() {
  const store = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => {
        store.set(key, String(value));
      },
    },
  };
  return {
    store,
    restore: () => {
      delete globalThis.window;
    },
  };
}

const foundInfo = {
  latestVersion: '9.9.9',
  date: '2026-11-21',
  changeLog: {
    zh: { title: '更新内容', content: ['示例'] },
    en: { title: 'Changes', content: ['Example'] },
  },
  url: 'https://example.test/IDBots-9.9.9',
};

const baseCheckOptions = {
  silentWorkInFlight: false,
  mockUpdateMode: false,
  getCurrentVersion: async () => '1.0.0',
  downloadedVersion: null,
};

test('the auto-check preference defaults to ON and round-trips OFF/ON', () => {
  const fake = installFakeLocalStorage();
  try {
    assert.equal(AUTO_CHECK_UPDATES_STORAGE_KEY, 'idbots.autoCheckUpdates');
    // Never set → default ON: existing installs keep their behaviour.
    assert.equal(loadAutoCheckUpdates(), true);

    saveAutoCheckUpdates(false);
    assert.equal(fake.store.get(AUTO_CHECK_UPDATES_STORAGE_KEY), '0');
    assert.equal(loadAutoCheckUpdates(), false);

    saveAutoCheckUpdates(true);
    assert.equal(loadAutoCheckUpdates(), true);
  } finally {
    fake.restore();
  }
});

test('switch OFF registers no first check, no heartbeat and no visibility listener', () => {
  let intervalRegistrations = 0;
  let listenerRegistrations = 0;
  let checks = 0;

  const handle = startAppUpdatePolling({
    enabled: false,
    check: () => {
      checks += 1;
    },
    setIntervalFn: () => {
      intervalRegistrations += 1;
      return 1;
    },
    clearIntervalFn: () => {},
    documentRef: {
      visibilityState: 'visible',
      addEventListener: () => {
        listenerRegistrations += 1;
      },
      removeEventListener: () => {},
    },
  });

  assert.equal(handle, null, 'a disabled poller has no handle to stop');
  assert.equal(checks, 0, 'no immediate check while the switch is OFF');
  assert.equal(intervalRegistrations, 0, 'no 30-minute heartbeat while OFF');
  assert.equal(listenerRegistrations, 0, 'no visibilitychange listener while OFF');
});

test('switch ON registers the first check, the 30-minute heartbeat and the visibility re-check', async () => {
  let intervalCallback = null;
  let intervalMs = null;
  let visibilityListener = null;
  let checks = 0;
  let clock = 1_000_000;

  const documentRef = {
    visibilityState: 'visible',
    addEventListener: (type, callback) => {
      if (type === 'visibilitychange') visibilityListener = callback;
    },
    removeEventListener: (type, callback) => {
      if (type === 'visibilitychange' && visibilityListener === callback) visibilityListener = null;
    },
  };

  const handle = startAppUpdatePolling({
    enabled: true,
    check: () => {
      checks += 1;
    },
    now: () => clock,
    setIntervalFn: (callback, ms) => {
      intervalCallback = callback;
      intervalMs = ms;
      return 7;
    },
    clearIntervalFn: () => {},
    documentRef,
  });

  assert.ok(handle);
  assert.equal(checks, 1, 'ON checks immediately once');
  assert.equal(intervalMs, UPDATE_HEARTBEAT_INTERVAL_MS, 'heartbeat keeps the 30-minute cadence');
  assert.ok(visibilityListener, 'ON registers the visibilitychange listener');

  clock += 60_000;
  intervalCallback();
  await Promise.resolve();
  assert.equal(checks, 1, 'a heartbeat inside the poll throttle does not re-check');

  clock += UPDATE_POLL_INTERVAL_MS;
  intervalCallback();
  await Promise.resolve();
  assert.equal(checks, 2, 'a heartbeat after the poll interval does re-check');

  documentRef.visibilityState = 'hidden';
  clock += UPDATE_POLL_INTERVAL_MS;
  visibilityListener();
  await Promise.resolve();
  assert.equal(checks, 2, 'becoming hidden never checks');

  documentRef.visibilityState = 'visible';
  visibilityListener();
  await Promise.resolve();
  assert.equal(checks, 3, 'becoming visible re-checks through the same throttle');

  handle.stop();
  documentRef.visibilityState = 'visible';
  clock += UPDATE_POLL_INTERVAL_MS;
  visibilityListener?.();
  intervalCallback();
  await Promise.resolve();
  assert.equal(checks, 3, 'a stopped poller never checks again');
});

test('stop clears the heartbeat and removes the visibility listener (idempotent)', () => {
  const cleared = [];
  let removed = 0;
  const documentRef = {
    visibilityState: 'visible',
    addEventListener: () => {},
    removeEventListener: () => {
      removed += 1;
    },
  };

  const handle = startAppUpdatePolling({
    enabled: true,
    check: () => {},
    setIntervalFn: () => 42,
    clearIntervalFn: (id) => cleared.push(id),
    documentRef,
  });

  handle.stop();
  assert.deepEqual(cleared, [42]);
  assert.equal(removed, 1);

  handle.stop();
  assert.deepEqual(cleared, [42], 'stop is idempotent');
  assert.equal(removed, 1);
});

test('the check path reuses the shared check request and reports up-to-date', async () => {
  let requestedVersion = null;
  let noUpdateCalls = 0;

  const result = await runAppUpdateCheck({
    ...baseCheckOptions,
    autoCheckEnabled: true,
    checkForUpdate: async (version) => {
      requestedVersion = version;
      return null;
    },
    onFound: () => {
      assert.fail('no update must not reach onFound');
    },
    onNoUpdate: () => {
      noUpdateCalls += 1;
    },
  });

  assert.deepEqual(result, { outcome: 'up-to-date' });
  assert.equal(requestedVersion, '1.0.0');
  assert.equal(noUpdateCalls, 1);
});

test('auto-check OFF offers a found update (prompt) instead of downloading it', async () => {
  let action = null;

  const result = await runAppUpdateCheck({
    ...baseCheckOptions,
    autoCheckEnabled: false,
    checkForUpdate: async () => foundInfo,
    onFound: (_info, nextAction) => {
      action = nextAction;
    },
    onNoUpdate: () => {},
  });

  assert.deepEqual(result, { outcome: 'update-found', latestVersion: '9.9.9' });
  assert.equal(action, 'prompt');
  assert.equal(resolveFoundUpdateAction(false), 'prompt');
});

test('auto-check ON keeps the existing silent-download behaviour', async () => {
  let action = null;

  await runAppUpdateCheck({
    ...baseCheckOptions,
    autoCheckEnabled: true,
    checkForUpdate: async () => foundInfo,
    onFound: (_info, nextAction) => {
      action = nextAction;
    },
    onNoUpdate: () => {},
  });

  assert.equal(action, 'silent-download');
  assert.equal(resolveFoundUpdateAction(true), 'silent-download');
});

test('an already-downloaded version is reported without starting a second download', async () => {
  const result = await runAppUpdateCheck({
    ...baseCheckOptions,
    autoCheckEnabled: true,
    downloadedVersion: '9.9.9',
    checkForUpdate: async () => foundInfo,
    onFound: () => {
      assert.fail('an already downloaded version must not re-enter the download path');
    },
    onNoUpdate: () => {},
  });

  assert.deepEqual(result, { outcome: 'update-found', latestVersion: '9.9.9' });
});

test('silent work in flight and mock mode skip the check entirely', async () => {
  const checkThatMustNotRun = async () => {
    assert.fail('the check request must not be issued');
  };

  const silent = await runAppUpdateCheck({
    ...baseCheckOptions,
    autoCheckEnabled: true,
    silentWorkInFlight: true,
    checkForUpdate: checkThatMustNotRun,
    onFound: () => {},
    onNoUpdate: () => {},
  });
  assert.deepEqual(silent, { outcome: 'skipped', reason: 'busy' });

  const mock = await runAppUpdateCheck({
    ...baseCheckOptions,
    autoCheckEnabled: false,
    mockUpdateMode: true,
    checkForUpdate: checkThatMustNotRun,
    onFound: () => {},
    onNoUpdate: () => {},
  });
  assert.deepEqual(mock, { outcome: 'skipped', reason: 'mock' });
});

test('a failed check is reported as error without throwing', async () => {
  let observed = null;
  const result = await runAppUpdateCheck({
    ...baseCheckOptions,
    autoCheckEnabled: true,
    checkForUpdate: async () => {
      throw new Error('network down');
    },
    onFound: () => {},
    onNoUpdate: () => {},
    onError: (error) => {
      observed = error;
    },
  });

  assert.deepEqual(result, { outcome: 'error' });
  assert.ok(observed instanceof Error);
});

test('App/Settings wiring: switch gates the poller, manual button shares checkForAppUpdate', () => {
  const app = read('src/renderer/App.tsx');
  const settings = read('src/renderer/components/Settings.tsx');
  const railModule = read('src/renderer/components/update/RailUpdateModule.tsx');
  const railStatus = read('src/renderer/services/softwareUpdateStatus.ts');
  const modal = read('src/renderer/components/update/AppUpdateModal.tsx');
  const polling = read('src/renderer/services/appUpdatePolling.ts');
  const i18n = read('src/renderer/services/i18n.ts');

  // The loop lives in appUpdatePolling and is gated by the persisted switch;
  // the old in-component timer is gone from App.
  assert.match(polling, /if \(!options\.enabled\) return null;/);
  assert.match(app, /startAppUpdatePolling\(\{/);
  assert.match(app, /enabled: autoCheckUpdates,/);
  assert.match(app, /loadAutoCheckUpdates\(\)/);
  assert.match(app, /saveAutoCheckUpdates\(enabled\)/);
  assert.doesNotMatch(app, /UPDATE_HEARTBEAT_INTERVAL_MS/);
  assert.doesNotMatch(app, /UPDATE_POLL_INTERVAL_MS/);

  // The manual action (sub-panel) reuses the same checkForAppUpdate path.
  assert.match(app, /checkForUpdate: checkForAppUpdate,/);
  assert.match(app, /const handleCheckForUpdate = useCallback\(/);
  assert.match(railModule, /onCheckForUpdate\(\)/);
  assert.match(railModule, /i18nService\.t\('checkForUpdates'\)/);
  assert.match(railModule, /i18nService\.t\('checkingForUpdates'\)/);
  assert.match(railStatus, /updateCheckInProgress/);

  // Switch OFF never silent-downloads: the found update only opens the prompt.
  assert.match(app, /if \(action === 'silent-download'\) \{\s*void startSilentDownload\(nextUpdate\);/);
  assert.match(app, /setUpdateModalState\('prompt'\)/);
  assert.match(modal, /modalState === 'prompt'/);
  assert.match(modal, /updatePromptNow/);
  assert.match(modal, /updatePromptLater/);

  // The version-block popover owns the visible switch; General only prints status.
  assert.match(railModule, /role="switch"[\s\S]{0,600}aria-checked=\{autoCheckUpdates\}/);
  assert.match(railModule, /onToggleAutoCheckUpdates\(!autoCheckUpdates\)/);

  // Both UI languages carry every new string.
  for (const key of [
    'autoCheckUpdates',
    'autoCheckUpdatesDescription',
    'checkForUpdates',
    'checkingForUpdates',
    'updateCheckUpToDate',
    'updateCheckFoundSilent',
    'updateCheckFoundPrompt',
    'updateCheckFailed',
    'updateCheckInProgress',
    'updatePromptTitle',
    'updatePromptMessage',
    'updatePromptNow',
    'updatePromptLater',
  ]) {
    const occurrences = i18n.split(`${key}:`).length - 1;
    assert.ok(occurrences >= 2, `i18n key ${key} should exist in both zh and en dictionaries`);
  }
});

// ---- final topology: version block is the one control surface (17:46) ----

const baseStatus = {
  phase: 'idle',
  downloadPercent: null,
  latestVersion: null,
  silentDownloadFailed: false,
  lastCheck: null,
};

test('update status prioritises background work over the plain "found" line', () => {
  assert.deepEqual(resolveUpdateStatus({ ...baseStatus, silentDownloadFailed: true }), { kind: 'failed' });
  assert.deepEqual(
    resolveUpdateStatus({ ...baseStatus, phase: 'downloading', latestVersion: '1.1.3', downloadPercent: 42 }),
    { kind: 'downloading', version: '1.1.3', percent: 42 },
  );
  assert.equal(resolveUpdateStatus({ ...baseStatus, phase: 'applying', latestVersion: '1.1.3' }).kind, 'installing');
  assert.equal(resolveUpdateStatus({ ...baseStatus, phase: 'ready', latestVersion: '1.1.3' }).kind, 'ready');
  assert.equal(resolveUpdateStatus({ ...baseStatus, phase: 'restartReady', latestVersion: '1.1.3' }).kind, 'restart-ready');
});

test('update status falls back to found → last check → not checked', () => {
  assert.deepEqual(
    resolveUpdateStatus({ ...baseStatus, latestVersion: '1.1.3' }),
    { kind: 'found', version: '1.1.3' },
  );
  assert.equal(resolveUpdateStatus({ ...baseStatus, lastCheck: { outcome: 'up-to-date' } }).kind, 'up-to-date');
  assert.equal(resolveUpdateStatus({ ...baseStatus, lastCheck: { outcome: 'error' } }).kind, 'check-failed');
  assert.equal(resolveUpdateStatus({ ...baseStatus, lastCheck: { outcome: 'skipped', reason: 'busy' } }).kind, 'busy');
  assert.equal(resolveUpdateStatus(baseStatus).kind, 'unknown');
});

test('the status sentence is one implementation for the row and the popover', () => {
  const t = (key) => `T:${key}`;
  assert.equal(formatUpdateStatus({ kind: 'found', version: '1.1.3' }, '1.1.2', t), 'T:softwareUpdateAvailable');
  assert.equal(formatUpdateStatus({ kind: 'up-to-date' }, '1.1.2', t), 'T:softwareUpdateUpToDate');
  assert.equal(formatUpdateStatus({ kind: 'unknown' }, '1.1.2', t), 'T:softwareUpdateNotChecked');
  assert.equal(formatUpdateStatus({ kind: 'failed' }, '1.1.2', t), 'T:updateDownloadFailedTitle');
  const zh = { softwareUpdateAvailable: '有可用更新 {version}', softwareUpdateUpToDate: '已是最新版本 {version}' };
  const zhT = (key) => zh[key] ?? key;
  assert.equal(formatUpdateStatus({ kind: 'found', version: '1.1.3' }, '1.1.2', zhT), '有可用更新 1.1.3');
  assert.equal(formatUpdateStatus({ kind: 'up-to-date' }, '1.1.2', zhT), '已是最新版本 1.1.2');
});

test('whats-new preview shows 3 items and expands to the rest', () => {
  assert.deepEqual(selectChangeLogPreview(['a', 'b', 'c', 'd', 'e'], 3), { visible: ['a', 'b', 'c'], hiddenCount: 2 });
  assert.deepEqual(selectChangeLogPreview(['a', 'b'], 3), { visible: ['a', 'b'], hiddenCount: 0 });
  assert.deepEqual(selectChangeLogPreview(['a', '', '  ', 'b', 'c', 'd'], 3), { visible: ['a', 'b', 'c'], hiddenCount: 1 });
});

test('version-block dot is bound to update availability (red first, green after)', () => {
  assert.equal(shouldShowUpdateDot({ latestVersion: '1.1.3', phase: 'idle', silentDownloadFailed: false }), true);
  assert.equal(shouldShowUpdateDot({ latestVersion: '1.1.3', phase: 'downloading', silentDownloadFailed: false }), true);
  assert.equal(shouldShowUpdateDot({ latestVersion: '1.1.3', phase: 'ready', silentDownloadFailed: false }), true);
  assert.equal(shouldShowUpdateDot({ latestVersion: '1.1.3', phase: 'restartReady', silentDownloadFailed: false }), true);
  assert.equal(shouldShowUpdateDot({ latestVersion: '1.1.3', phase: 'applying', silentDownloadFailed: false }), false);
  assert.equal(shouldShowUpdateDot({ latestVersion: null, phase: 'idle', silentDownloadFailed: false }), false);
});

test('General list has ZERO update content (owner ruling 17:47)', () => {
  const settings = read('src/renderer/components/Settings.tsx');
  const app = read('src/renderer/App.tsx');

  // Nothing update-related may appear inside Settings any more.
  for (const banned of [
    /softwareUpdate/i,
    /software-update/i,
    /checkForUpdates/,
    /updateStatus/,
    /formatUpdateStatus/,
    /onOpenRailUpdate/,
    /自动检查/,
    /软件更新/,
  ]) {
    assert.doesNotMatch(settings, banned, `Settings must not mention ${banned}`);
  }

  // The one control surface is reachable only from the rail block.
  assert.doesNotMatch(app, /onOpenRailUpdate|handleOpenRailUpdateFromSettings/);
  assert.doesNotMatch(app, /updateStatus=\{updateStatus\}/);
});

test('the version block is the ONLY control surface', () => {
  const module = read('src/renderer/components/update/RailUpdateModule.tsx');
  const app = read('src/renderer/App.tsx');
  const rail = read('src/renderer/components/layout/WorkspaceRail.tsx');

  assert.match(module, /data-slot="rail-update-module"/);
  assert.match(module, /data-slot="rail-update-version"/);
  assert.match(module, /data-slot="rail-update-dot"/);
  assert.match(module, /data-slot="rail-update-panel"/);
  assert.match(module, /data-slot="rail-update-status"/);
  assert.match(module, /data-slot="rail-update-highlights"/);
  assert.match(module, /data-slot="rail-update-check"/);
  assert.match(module, /data-slot="rail-update-auto-toggle"/);
  assert.match(module, /data-slot="rail-update-now"/);
  assert.match(module, /role="dialog"/);
  assert.match(module, /selectChangeLogPreview\(allHighlights, 3\)/);

  // Both rail faces mount the same node; open state is App-owned.
  assert.equal(app.split('updateModule={railUpdateModule}').length - 1, 2);
  assert.match(app, /const \[railUpdatePopoverOpen, setRailUpdatePopoverOpen\] = useState\(false\)/);
  assert.match(app, /open=\{railUpdatePopoverOpen\}/);
  assert.match(rail, /updateModule\?: React\.ReactNode;/);
  assert.match(rail, /\{updateModule\}/);
  assert.doesNotMatch(rail, /settingsUpdateDot/);
});

test('one state source feeds row + popover; the badge keeps process states only', () => {
  const app = read('src/renderer/App.tsx');
  const settings = read('src/renderer/components/Settings.tsx');
  const module = read('src/renderer/components/update/RailUpdateModule.tsx');

  assert.match(app, /resolveUpdateStatus\(\{/);
  assert.match(app, /shouldShowUpdateDot\(\{/);
  assert.match(app, /status=\{updateStatus\}/);
  assert.equal(app.split('status={updateStatus}').length - 1, 1); // the rail module node
  assert.equal(app.split('autoCheckUpdates={autoCheckUpdates}').length - 1, 1); // one rail module node
  assert.match(module, /onToggleAutoCheckUpdates\(!autoCheckUpdates\)/);
  assert.match(app, /updatePhase !== 'idle' \|\| silentDownloadFailed/);
});

test('the 17:25 file set converges: version block restored, old service name gone', () => {
  assert.equal(fs.existsSync(path.join(repoRoot, 'src/renderer/components/update/RailUpdateModule.tsx')), true);
  assert.equal(fs.existsSync(path.join(repoRoot, 'src/renderer/services/appUpdateRail.ts')), false);
  assert.equal(fs.existsSync(path.join(repoRoot, 'src/renderer/components/settings/SoftwareUpdatePanel.tsx')), false);
  assert.match(read('src/renderer/App.tsx'), /const railUpdateModule = \(/);
  assert.doesNotMatch(read('src/renderer/services/i18n.ts'), /railUpdate/);
});

test('i18n carries the software-update strings in both languages', () => {
  const i18n = read('src/renderer/services/i18n.ts');
  for (const key of [
    'softwareUpdate',
    'softwareUpdateUpToDate',
    'softwareUpdateAvailable',
    'softwareUpdateNotChecked',
    'softwareUpdateNow',
    'softwareUpdateAutoTitle',
    'softwareUpdateAutoDescription',
    'softwareUpdateDotLabel',
    'softwareUpdateHighlights',
    'softwareUpdateShowAll',
    'softwareUpdateShowLess',
  ]) {
    const occurrences = i18n.split(`${key}:`).length - 1;
    assert.ok(occurrences >= 2, `i18n key ${key} should exist in both zh and en dictionaries`);
  }
});
