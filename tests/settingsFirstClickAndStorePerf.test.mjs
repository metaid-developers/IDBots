import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const read = (relativePath) =>
  fs.readFileSync(path.join(repoRoot, relativePath), 'utf8').replace(/\r\n/g, '\n');

test('macOS BrowserWindow enables acceptFirstMouse so unfocused first clicks activate controls immediately', () => {
  const mainSource = read('src/main/main.ts');
  // SUPERSEDED (mini-lights ruling 2026-11-14): the darwin branch dropped
  // 'hiddenInset' + trafficLightPosition — the native lights' size is
  // system-pinned, so main.ts falls back to the plain 'hidden' style and
  // removes the native buttons after creation; the renderer draws WeChat-
  // scale 8px dots (MacWindowLights). acceptFirstMouse is retained, which
  // is this test's original intent.
  assert.match(
    mainSource,
    /\.\.\.\(isMac\s*\?\s*\{[^{}]*?titleBarStyle:\s*'hidden'\s*as\s*const,\s*acceptFirstMouse:\s*true,/,
  );
  assert.match(
    mainSource,
    /if \(isMac && typeof win\.setWindowButtonVisibility === 'function'\)\s*\{\s*win\.setWindowButtonVisibility\(false\);\s*\}/,
  );
});

test('Redux store disables dev-only recursive serializableCheck and immutableCheck middleware', () => {
  const storeSource = read('src/renderer/store/index.ts');
  assert.match(storeSource, /serializableCheck:\s*false/);
  assert.match(storeSource, /immutableCheck:\s*false/);
});

test('Settings modal preloads on idle, renders an immediate Suspense shell, lazy-loads heavy tabs, and marks backdrop non-draggable', () => {
  const appSource = read('src/renderer/App.tsx');
  assert.match(appSource, /const loadSettingsModule = \(\) => import\('\.\/components\/Settings'\);/);
  assert.match(appSource, /requestIdleCallback/);
  assert.doesNotMatch(appSource, /\{showSettings && \(\s*<Suspense fallback=\{null\}>/);
  assert.equal((appSource.match(/<SettingsLoadingShell onClose=\{handleCloseSettings\} \/>/g) ?? []).length, 2);

  const settingsSource = read('src/renderer/components/Settings.tsx');
  assert.match(settingsSource, /className="non-draggable fixed inset-0 z-50 modal-backdrop flex items-center justify-center"/);
  assert.match(settingsSource, /const IMSettings = React\.lazy\(\(\) => import\('\.\/im\/IMSettings'\)\);/);
  assert.match(settingsSource, /const MemorySettings = React\.lazy\(\(\) => import\('\.\/settings\/MemorySettings'\)\);/);
  assert.match(settingsSource, /const SkillMcpManager = React\.lazy\(\(\) => import\('\.\/skills\/SkillMcpManager'\)\);/);
});
