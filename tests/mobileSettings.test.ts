import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createMobileMockBridge } from '../src/mobile/bridge/mockBridge.ts';
import {
  applyThemeMode,
  getThemeMode,
  loadSettings,
  setLanguage,
  setThemeMode,
} from '../src/mobile/app/services/settings.ts';
import { mobileI18n } from '../src/mobile/i18n.ts';
import { buildStyles } from '../src/mobile/login/loginStyles.ts';
import { initLoginTheme, LOGIN_PAGE_BG, readStoredThemeMode } from '../src/mobile/login/theme.ts';
import { normalizeThemeMode, resolveIsDark, THEME_MIRROR_STORAGE_KEY } from '../src/mobile/themeMirror.ts';

function installBridge(t: test.TestContext) {
  const bridge = createMobileMockBridge({ systemLocale: 'en-US' });
  Object.assign(globalThis, {
    window: {
      electron: bridge.electron,
      matchMedia: () => ({ matches: false, addEventListener: () => undefined }),
    },
    document: {
      documentElement: { classList: { toggle: () => undefined } },
    },
  });
  applyThemeMode('system');
  mobileI18n.setLanguage('en');
  t.after(() => bridge.destroy());
  return bridge.electron;
}

test('mobile language/theme writes are field-scoped and confirmed without clobbering provider/bootstrap config', async (t) => {
  const api = installBridge(t);
  await api.store.set('app_config', {
    language: 'en',
    language_initialized: true,
    theme: 'system',
    bootstrap: { workspace: '/data/workspace' },
    providers: {
      'metaid-free': {
        enabled: true,
        apiKey: 'fixture-relay-key',
        baseUrl: 'https://relay.fixture',
        apiFormat: 'openai',
        models: [{ id: 'model-a' }],
      },
    },
  });

  await setLanguage('zh');
  await setThemeMode('dark');

  const saved = await api.store.get('app_config');
  assert.equal(saved.language, 'zh');
  assert.equal(saved.theme, 'dark');
  assert.equal(saved.language_initialized, true);
  assert.deepEqual(saved.bootstrap, { workspace: '/data/workspace' });
  assert.equal(saved.providers['metaid-free'].apiKey, 'fixture-relay-key');
  assert.equal(saved.providers['metaid-free'].baseUrl, 'https://relay.fixture');
  assert.equal(mobileI18n.getLanguage(), 'zh');
  assert.equal(getThemeMode(), 'dark');
});

test('mobile settings do not report local success when persistence fails', async (t) => {
  const api = installBridge(t);
  await api.store.set('app_config', { language: 'en', theme: 'system' });
  api.store.set = async () => {
    throw new Error('fixture offline');
  };

  await assert.rejects(setLanguage('zh'), /fixture offline/);
  await assert.rejects(setThemeMode('dark'), /fixture offline/);
  assert.equal(mobileI18n.getLanguage(), 'en');
  assert.equal(getThemeMode(), 'system');
});

test('mobile settings require a matching readback before applying locally', async (t) => {
  const api = installBridge(t);
  await api.store.set('app_config', { language: 'en', theme: 'system' });
  api.store.get = async () => ({ language: 'en', theme: 'system' });

  await assert.rejects(setThemeMode('dark'), /could not be confirmed/);
  assert.equal(getThemeMode(), 'system');
});

test('mock cowork memory config persists allowed global fields and preserves the rest', async (t) => {
  const api = installBridge(t);
  const before = await api.cowork.getConfig();
  assert.equal(before.success, true);

  const saved = await api.cowork.setConfig({ memoryEnabled: false, memoryLlmJudgeEnabled: true });
  assert.equal(saved.success, true);
  const after = await api.cowork.getConfig();
  assert.equal(after.config.memoryEnabled, false);
  assert.equal(after.config.memoryLlmJudgeEnabled, true);
  assert.equal(after.config.memoryImplicitUpdateEnabled, before.config.memoryImplicitUpdateEnabled);
  assert.equal(after.config.workingDirectory, before.config.workingDirectory);
});

// ---------------------------------------------------------------------------
// Theme preference mirror (app R-store → localStorage → login bundle)
// ---------------------------------------------------------------------------

/** localStorage stub backed by a map so mirror writes are observable. */
function localStorageStub(backing: Map<string, string>) {
  return {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => {
      backing.set(key, value);
    },
  };
}

/** installBridge + an in-memory localStorage on the window stub. */
function installBridgeWithStorage(t: test.TestContext) {
  const bridge = createMobileMockBridge({ systemLocale: 'en-US' });
  const backing = new Map<string, string>();
  Object.assign(globalThis, {
    window: {
      electron: bridge.electron,
      matchMedia: () => ({ matches: false, addEventListener: () => undefined }),
      localStorage: localStorageStub(backing),
    },
    document: {
      documentElement: { classList: { toggle: () => undefined } },
    },
  });
  applyThemeMode('system');
  mobileI18n.setLanguage('en');
  t.after(() => bridge.destroy());
  return { electron: bridge.electron, backing };
}

test('confirmed theme changes mirror into the login-bundle localStorage key; failed writes never do', async (t) => {
  const { electron, backing } = installBridgeWithStorage(t);
  await electron.store.set('app_config', { language: 'en', theme: 'system' });

  await setThemeMode('dark');
  assert.equal(backing.get(THEME_MIRROR_STORAGE_KEY), 'dark');

  // The mirror is written only after the R-store write AND readback confirm;
  // a failed persistence leaves the previous mirrored value in place.
  electron.store.set = async () => {
    throw new Error('fixture offline');
  };
  await assert.rejects(setThemeMode('light'), /fixture offline/);
  assert.equal(backing.get(THEME_MIRROR_STORAGE_KEY), 'dark');
});

test('loadSettings mirrors the hydrated theme; failed hydration never clobbers the mirror', async (t) => {
  const { electron, backing } = installBridgeWithStorage(t);
  await electron.store.set('app_config', { theme: 'dark' });
  await loadSettings();
  assert.equal(getThemeMode(), 'dark');
  assert.equal(backing.get(THEME_MIRROR_STORAGE_KEY), 'dark');

  // Offline relaunch: hydration falls back to system WITHOUT overwriting the
  // last known-good mirror the login bundle relies on.
  electron.store.get = async () => {
    throw new Error('bridge gone');
  };
  await loadSettings();
  assert.equal(getThemeMode(), 'system');
  assert.equal(backing.get(THEME_MIRROR_STORAGE_KEY), 'dark');
});

test('login theme resolution: mirror normalization, system fallback, and the dark matrix', () => {
  assert.equal(normalizeThemeMode('dark'), 'dark');
  assert.equal(normalizeThemeMode('bogus'), 'system');
  assert.equal(normalizeThemeMode(undefined), 'system');

  assert.equal(resolveIsDark('dark', false), true);
  assert.equal(resolveIsDark('light', true), false);
  assert.equal(resolveIsDark('system', false), false);
  assert.equal(resolveIsDark('system', true), true);

  const backing = new Map<string, string>();
  backing.set(THEME_MIRROR_STORAGE_KEY, 'dark');
  assert.equal(readStoredThemeMode(localStorageStub(backing)), 'dark');
  backing.set(THEME_MIRROR_STORAGE_KEY, 'bogus');
  assert.equal(readStoredThemeMode(localStorageStub(backing)), 'system');
  // No storage (or unavailable): fall back to the app default. A window stub
  // without localStorage keeps this deterministic regardless of test order.
  Object.assign(globalThis, {
    window: { electron: undefined, matchMedia: () => ({ matches: false, addEventListener: () => undefined }) },
  });
  assert.equal(readStoredThemeMode(null), 'system');
});

test('initLoginTheme applies the mirror pre-paint and tracks the OS scheme live', (t) => {
  // Minimal DOM stub: record classList toggles, inline styles, and the
  // injected theme-color meta instead of asserting on a real document.
  const toggled: boolean[] = [];
  const rootStyle: Record<string, string> = {};
  const metaAttrs: Record<string, string> = {};
  const media: { matches: boolean; listener?: () => void } = { matches: false };
  const backing = new Map<string, string>();
  backing.set(THEME_MIRROR_STORAGE_KEY, 'dark');
  Object.assign(globalThis, {
    window: {
      electron: undefined,
      matchMedia: () => ({
        get matches() {
          return media.matches;
        },
        addEventListener: (_type: string, listener: () => void) => {
          media.listener = listener;
        },
      }),
    },
    document: {
      documentElement: {
        classList: { toggle: (_name: string, force: boolean) => toggled.push(force) },
        style: rootStyle,
      },
      querySelector: () => null,
      createElement: () => ({
        setAttribute: (name: string, value: string) => {
          metaAttrs[name] = value;
        },
      }),
      head: { appendChild: () => undefined },
    },
  });
  t.after(() => {
    media.listener = undefined;
  });

  const theme = initLoginTheme({ storage: localStorageStub(backing) });
  // Pre-paint application from the stored mirror (dark) is synchronous.
  assert.equal(theme.getMode(), 'dark');
  assert.equal(theme.isDark(), true);
  assert.deepEqual(toggled, [true]);
  assert.equal(rootStyle.colorScheme, 'dark');
  assert.equal(rootStyle.backgroundColor, LOGIN_PAGE_BG.dark);
  assert.equal(metaAttrs.content, LOGIN_PAGE_BG.dark);

  // System mode: resolution flips live when the OS scheme changes.
  backing.set(THEME_MIRROR_STORAGE_KEY, 'system');
  const system = initLoginTheme({ storage: localStorageStub(backing) });
  assert.equal(system.getMode(), 'system');
  assert.equal(system.isDark(), false);
  const events: boolean[] = [];
  const unsubscribe = system.subscribe(() => events.push(system.isDark()));
  media.matches = true;
  media.listener?.();
  assert.equal(system.isDark(), true);
  assert.deepEqual(events, [true]);
  assert.equal(rootStyle.backgroundColor, LOGIN_PAGE_BG.dark);
  unsubscribe();
  media.matches = false;
  media.listener?.();
  assert.equal(system.isDark(), false);
  assert.deepEqual(events, [true]);
});

test('login palette matches the app theme tokens in both schemes', () => {
  const dark = buildStyles(true);
  const light = buildStyles(false);
  assert.equal(dark.page.backgroundColor, LOGIN_PAGE_BG.dark);
  assert.equal(light.page.backgroundColor, LOGIN_PAGE_BG.light);
  assert.equal(dark.page.color, '#F4F3EF');
  assert.equal(light.page.color, '#242425');
  assert.notEqual(dark.input.backgroundColor, light.input.backgroundColor);
  assert.notEqual(dark.error.color, light.error.color);
  // Brand yellow (#ffdc51, --color-primary) is theme-invariant by design.
  assert.equal(dark.button.backgroundColor, '#ffdc51');
  assert.equal(light.button.backgroundColor, '#ffdc51');
  assert.equal(dark.logo.imageRendering, 'pixelated');
});

test('login main.tsx ships no hardcoded color literals (palette lives in loginStyles.ts)', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = readFileSync(path.join(here, '../src/mobile/login/main.tsx'), 'utf8');
  assert.deepEqual(source.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [], []);
});

test('login index.html resolves the same mirror key and palette as the app module', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const html = readFileSync(path.join(here, '../src/mobile/login/index.html'), 'utf8');
  assert.ok(html.includes(THEME_MIRROR_STORAGE_KEY));
  assert.ok(html.includes(LOGIN_PAGE_BG.dark));
  assert.ok(html.includes(LOGIN_PAGE_BG.light));
  // The static light-only theme-color meta is gone; the inline script injects it.
  assert.ok(!html.includes('meta name="theme-color" content="#F5F7F9"'));
});
