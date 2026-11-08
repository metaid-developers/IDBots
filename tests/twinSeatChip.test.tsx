import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TwinSeatChip, {
  type TwinSeatChipBot,
} from '../src/renderer/features/botBrowser/TwinSeatChip';
import { i18nService } from '../src/renderer/services/i18n';

// Render-layer coverage for the Bot Internet footer chip (owner ruling
// 2026-11-08): the draft state is an appointment control whose menu lists the
// whole roster with the acting Twin disabled + badged; a live session keeps a
// display-only identity chip. No real roster is touched.

const twin: TwinSeatChipBot = { id: 1, name: 'Alice', avatar: null, metabot_type: 'twin', role: 'Twin' };
const worker: TwinSeatChipBot = { id: 2, name: 'Bob', avatar: null, metabot_type: 'worker', role: 'Builder' };
const idle: TwinSeatChipBot = { id: 3, name: 'Carol', avatar: null, metabot_type: 'worker' };
const roster = [twin, worker, idle];

const noop = () => {};

function renderChip(overrides: Partial<React.ComponentProps<typeof TwinSeatChip>> = {}): string {
  return renderToStaticMarkup(
    <TwinSeatChip
      chipMetabot={twin}
      roster={roster}
      live={false}
      busy={false}
      menuOpen={false}
      onToggleMenu={noop}
      onAppoint={noop}
      {...overrides}
    />,
  );
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test('draft chip renders the acting Twin once and is the appointment trigger', () => {
  const html = renderChip();

  assert.match(html, /aria-haspopup="menu"/);
  assert.match(html, /aria-expanded="false"/);
  assert.equal(
    countOccurrences(html, 'Alice'),
    1,
    'the identity block already renders the name; the chip must not repeat it',
  );
  assert.match(html, /data-slot="metabot-twin-badge"/);
  assert.doesNotMatch(html, /role="menu"/);
  assert.ok(html.includes(i18nService.t('botInternetTwinSeatChip')));
});

test('open seat menu lists every bot and disables the acting Twin with a badge', () => {
  const html = renderChip({ menuOpen: true });

  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /role="menu"/);
  assert.equal(countOccurrences(html, 'role="menuitem"'), roster.length);
  for (const bot of roster) {
    assert.ok(html.includes(bot.name), `menu should list ${bot.name}`);
  }
  // Only the acting Twin row is disabled; the other rows stay appointable.
  const disabledRows = html.match(/<button[^>]*role="menuitem"[^>]*disabled=""[^>]*>/g) ?? [];
  assert.equal(disabledRows.length, 1, 'exactly the acting Twin row is disabled');
  assert.equal(
    countOccurrences(html, 'data-slot="metabot-twin-badge"'),
    2,
    'the acting Twin is badged on the chip and again on its menu row',
  );
  assert.ok(html.includes(i18nService.t('botInternetTwinSeatTitle')));
  assert.ok(html.includes(i18nService.t('botInternetTwinSeatHint')));
});

test('a live session renders a display-only chip with no menu trigger', () => {
  const html = renderChip({ live: true, menuOpen: true });

  assert.doesNotMatch(html, /<button/);
  assert.doesNotMatch(html, /role="menu"/);
  assert.doesNotMatch(html, /aria-haspopup/);
  assert.ok(html.includes('Alice'));
  assert.match(html, /data-slot="metabot-twin-badge"/);
});

test('a busy appointment disables the seat trigger', () => {
  const html = renderChip({ busy: true });

  assert.match(html, /<button[^>]*disabled=""[^>]*aria-haspopup="menu"/);
});
