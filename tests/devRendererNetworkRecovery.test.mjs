import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const indexHtml = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');

function extractRecoveryScript() {
  const match = indexHtml.match(
    /<script id="idbots-dev-network-recovery">([\s\S]*?)<\/script>/
  );
  assert.ok(match, 'index.html must include the dev network recovery bootstrap');
  return match[1];
}

function createHarness() {
  const listeners = new Map();
  let reloadCount = 0;
  let now = 1_000_000;
  const scheduled = [];
  const sessionStorage = new Map();

  const window = {
    location: {
      protocol: 'http:',
      hostname: 'localhost',
      reload: () => {
        reloadCount += 1;
      },
    },
    navigator: {
      onLine: true,
    },
    sessionStorage: {
      getItem: (key) => sessionStorage.get(key) ?? null,
      setItem: (key, value) => sessionStorage.set(key, String(value)),
    },
    addEventListener: (type, listener) => {
      const items = listeners.get(type) ?? [];
      items.push(listener);
      listeners.set(type, items);
    },
  };

  const context = {
    window,
    location: window.location,
    navigator: window.navigator,
    sessionStorage: window.sessionStorage,
    Date: {
      now: () => now,
    },
    setTimeout: (callback, delay) => {
      scheduled.push({ callback, delay });
      return scheduled.length;
    },
    clearTimeout: () => {},
    console: {
      warn: () => {},
      error: () => {},
    },
  };

  vm.runInNewContext(extractRecoveryScript(), context);

  return {
    dispatch(type, event) {
      for (const listener of listeners.get(type) ?? []) {
        listener(event);
      }
    },
    runTimers() {
      while (scheduled.length > 0) {
        const item = scheduled.shift();
        item.callback();
      }
    },
    setOnline(value) {
      window.navigator.onLine = value;
    },
    advance(ms) {
      now += ms;
    },
    get reloadCount() {
      return reloadCount;
    },
  };
}

test('dev network recovery bootstrap runs before Vite module graph', () => {
  const recoveryIndex = indexHtml.indexOf('idbots-dev-network-recovery');
  const moduleIndex = indexHtml.indexOf('src="/src/renderer/main.tsx"');

  assert.notEqual(recoveryIndex, -1);
  assert.notEqual(moduleIndex, -1);
  assert.equal(recoveryIndex < moduleIndex, true);
});

test('dev network recovery reloads after a module request hits ERR_NETWORK_CHANGED', () => {
  const harness = createHarness();

  harness.dispatch('unhandledrejection', {
    reason: new TypeError(
      'Failed to fetch dynamically imported module: http://localhost:5175/src/renderer/components/skills/SkillsManager.tsx net::ERR_NETWORK_CHANGED'
    ),
  });

  harness.runTimers();

  assert.equal(harness.reloadCount, 1);
});

test('dev network recovery waits for online before reloading when offline', () => {
  const harness = createHarness();
  harness.setOnline(false);

  harness.dispatch('error', {
    message: 'Importing a module script failed.',
    filename: 'http://localhost:5175/src/renderer/components/gigSquare/GigSquareView.tsx',
  });
  harness.runTimers();
  assert.equal(harness.reloadCount, 0);

  harness.setOnline(true);
  harness.dispatch('online', {});
  harness.runTimers();

  assert.equal(harness.reloadCount, 1);
});
