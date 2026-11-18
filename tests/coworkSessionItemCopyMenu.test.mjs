import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const itemSource = readFileSync(
  new URL('../src/renderer/components/cowork/CoworkSessionItem.tsx', import.meta.url),
  'utf8',
);
const i18nSource = readFileSync(
  new URL('../src/renderer/services/i18n.ts', import.meta.url),
  'utf8',
);

test('CoworkSessionItem wires a copy session id menu action', () => {
  assert.match(
    itemSource,
    /import\s+\{[^}]*copyCoworkSessionLinkToClipboard[^}]*\}\s+from\s+['"]\.\/coworkSessionLink\.js['"]/s,
  );
  assert.match(itemSource, /\bcopyCoworkSessionLinkToClipboard\b/);
  assert.match(itemSource, /\bi18nService\.t\(['"]coworkCopySessionId['"]\)/);
  assert.match(
    itemSource,
    /import\s+\{[^}]*ClipboardDocumentIcon[^}]*\}\s+from\s+['"]@heroicons\/react\/24\/outline['"]/s,
  );
  assert.match(itemSource, /\bClipboardDocumentIcon\b/);
  assert.match(itemSource, /key:\s*['"]copy-session-id['"]/);
});

test('i18n defines the copy session id label in Chinese and English', () => {
  assert.match(i18nSource, /coworkCopySessionId:\s*['"]复制Session ID['"]/);
  assert.match(i18nSource, /coworkCopySessionId:\s*['"]Copy Session ID['"]/);
});

test('Studio history rows still surface death-state labels (cw-636ddce2)', () => {
  // Studio rows keep the visited-page context instead of the everyday status
  // word, but a dead session must be visible in the Studio list too —
  // session cw-636ddce2 (2026-11-19) died inside Studio with zero indication
  // while the same row in BotWorks showed 已停止.
  assert.match(itemSource, /DEATH_STATUS_LABEL_STATES/);
  assert.match(
    itemSource,
    /!showBrowserContext \|\| DEATH_STATUS_LABEL_STATES\.has\(session\.status\)/,
    'the meta-line gate must render error-family and stopped labels in Studio history too',
  );
  assert.match(
    itemSource,
    /new Set<CoworkSessionStatus>\(\['error', 'error_retried', 'stopped'\]\)/,
    'death states are exactly error / error_retried / stopped — idle stays label-less in Studio',
  );
});
