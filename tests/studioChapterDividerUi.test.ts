// Studio chapter divider card (Phase 2 slice 5): the close-flow's divider
// system message (metadata.sessionChapterDivider) renders as a centered
// full-width strip — book icon, 第 N 章 · title, close-reason chip, stored
// bilingual note — instead of falling through the system-row filter (which
// hides every non-failure system row). Static wiring pins, house style.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const panelSource = readFileSync(join(here, '../src/renderer/features/botBrowser/BotBrowserCoworkPanel.tsx'), 'utf8');
const i18nSource = readFileSync(join(here, '../src/renderer/services/i18n.ts'), 'utf8');

test('the chapter divider message passes the system-row visibility filter', () => {
  assert.ok(
    panelSource.includes("?.sessionChapterDivider"),
    'BotBrowserCoworkPanel: the system filter must admit chapter divider rows',
  );
  assert.ok(
    /message\.type === 'system'\) \{\s*\n\s*return isPanelTurnFailureMessage\(message\)\s*\n\s*\|\| Boolean\(\(message\.metadata as Record<string, unknown> \| undefined\)\?\.sessionChapterDivider\);/.test(panelSource),
    'BotBrowserCoworkPanel: the filter keeps turn-failure cards AND chapter dividers, nothing else',
  );
});

test('the divider renders as a centered strip with label, reason chip, and the stored note', () => {
  assert.ok(
    panelSource.includes("i18nService.t('studioChapterDividerLabel')"),
    'the label renders through i18n with {index}/{title} interpolation',
  );
  assert.ok(
    panelSource.includes("'studioChapterReasonTaskBoundary'")
      && panelSource.includes("'studioChapterReasonBudget'")
      && panelSource.includes("'studioChapterReasonManual'"),
    'all three close reasons map to i18n chips',
  );
  assert.ok(
    panelSource.includes('{message.content}'),
    'the stored bilingual close note renders as the body',
  );
  // Untitled chapters fall back to the i18n placeholder.
  assert.ok(
    panelSource.includes("studioChapterUntitled"),
    'an empty title falls back to the Untitled placeholder',
  );
});

test('the divider i18n keys exist in both languages', () => {
  const zhBlock = i18nSource.slice(i18nSource.indexOf("studioChapterClose: '收拢本章"), i18nSource.indexOf("studioChapterClose: '收拢本章") + 500);
  const enBlock = i18nSource.slice(i18nSource.indexOf("studioChapterClose: 'Close chapter"), i18nSource.indexOf("studioChapterClose: 'Close chapter") + 500);
  for (const key of ['studioChapterDividerLabel', 'studioChapterUntitled', 'studioChapterReasonManual', 'studioChapterReasonTaskBoundary', 'studioChapterReasonBudget']) {
    assert.ok(zhBlock.includes(`${key}:`), `zh i18n carries ${key}`);
    assert.ok(enBlock.includes(`${key}:`), `en i18n carries ${key}`);
  }
});
