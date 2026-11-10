import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

// The office-face approval strip (twin relay seat, owner ruling 2026-11-10):
// anything that needs the owner's ruling is brought INTO the office — the
// shell carries ONE visible seat per prompt. While the Bot Browser pane is
// visible the global corner overlay stands down, and the strip answers with
// the overlay's own respond path and countdown hook. These guards pin that
// wiring, not the styling.

const repoRoot = path.resolve(import.meta.dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

const stripSource = read('src/renderer/features/botBrowser/TwinApprovalStrip.tsx');
const appSource = read('src/renderer/App.tsx');
const i18nSource = read('src/renderer/services/i18n.ts');

test('strip reads the same global pendingPermissions the corner overlay seats', () => {
  assert.match(stripSource, /state\.cowork\.pendingPermissions/);
  assert.match(stripSource, /buildAllowResult/);
  assert.match(stripSource, /respondToPermission/);
});

test('strip never runs its own watchdog timer — countdown is the overlay hook', () => {
  assert.match(stripSource, /usePermissionCountdown/);
  assert.doesNotMatch(stripSource, /setInterval|setTimeout/);
});

test('office face: overlay stands down while the browser pane is visible', () => {
  assert.match(appSource, /!botBrowserShell\.isBrowserPaneVisible && \(\s*<CoworkPermissionOverlay/);
  assert.match(appSource, /<TwinApprovalStrip \/>/);
});

test('going to the workshop is an explicit deep link, not navigation by default', () => {
  assert.match(stripSource, /cowork:viewSession/);
});

test('risk buckets stay a closed four-word vocabulary, bilingual', () => {
  for (const key of [
    'twinApprovalRiskDelete',
    'twinApprovalRiskMoney',
    'twinApprovalRiskPublish',
    'twinApprovalRiskNormal',
  ]) {
    assert.match(stripSource, new RegExp(key));
    const occurrences = i18nSource.split(key).length - 1;
    assert.ok(occurrences >= 2, `${key} must exist in both zh and en dictionaries (found ${occurrences})`);
  }
});

test('strip is absent when nothing awaits a ruling — no permanent furniture', () => {
  assert.match(stripSource, /if \(pendingPermissions\.length === 0\) return null;/);
});
