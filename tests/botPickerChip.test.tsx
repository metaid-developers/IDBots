import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import BotPickerChip, {
  BotPickerMenuRow,
  type BotPickerChipBot,
} from '../src/renderer/features/botBrowser/BotPickerChip';
import { bindSeatMenuOutsideDismiss } from '../src/renderer/features/botBrowser/seatMenuDismiss';
import { i18nService } from '../src/renderer/services/i18n';

// Behavior coverage for the Studio surface-header bot picker (owner ruling
// 2026-11-11; v3 close wiring same day): the draft state is a PURE selection
// control whose menu lists the whole roster with every row enabled — picking
// a bot only decides which bot runs the next conversation, it never writes
// metabot_type or appoints a Twin (that stays owned by the My Bots editor).
// The chip is draft-only since the v3 close wiring: a live session's header
// identity is the read-only CoworkSurfaceIdentityBadge, covered by
// surfaceIdentityBadge.test.tsx. An open menu closes on an outside pointer
// but not on a menu row, which still runs its selection. No real roster is
// touched.

const twin: BotPickerChipBot = { id: 1, name: 'Alice', avatar: null, metabot_type: 'twin', role: 'Twin' };
const worker: BotPickerChipBot = { id: 2, name: 'Bob', avatar: null, metabot_type: 'worker', role: 'Builder' };
const idle: BotPickerChipBot = { id: 3, name: 'Carol', avatar: null, metabot_type: 'worker' };
const roster = [twin, worker, idle];

const noop = () => {};

function renderChip(overrides: Partial<React.ComponentProps<typeof BotPickerChip>> = {}): string {
  return renderToStaticMarkup(
    <BotPickerChip
      chipMetabot={twin}
      roster={roster}
      menuOpen={false}
      onToggleMenu={noop}
      onDismissMenu={noop}
      onSelect={noop}
      {...overrides}
    />,
  );
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** Minimal document stand-in: only the pointerdown channel the menu uses. */
function createFakePointerDocument() {
  const listeners = new Set<(event: Event) => void>();
  return {
    addEventListener(type: string, listener: (event: Event) => void) {
      if (type === 'pointerdown') listeners.add(listener);
    },
    removeEventListener(type: string, listener: (event: Event) => void) {
      if (type === 'pointerdown') listeners.delete(listener);
    },
    pointerDown(target: unknown) {
      for (const listener of [...listeners]) listener({ target } as unknown as Event);
    },
    get pointerDownListenerCount() {
      return listeners.size;
    },
  };
}

function fakeContainer(...inside: unknown[]): Element {
  return { contains: (node: unknown) => inside.includes(node) } as unknown as Element;
}

test('draft chip renders the selected bot once and is the picker trigger', () => {
  const html = renderChip();

  assert.match(html, /aria-haspopup="menu"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /data-slot="bot-picker-container"/);
  assert.match(html, /h-8 w-8[^"]*rounded-full/);
  assert.match(html, /gap-2/);
  assert.match(html, /text-sm font-medium/);
  assert.equal(
    countOccurrences(html, 'Alice'),
    1,
    'the identity block already renders the name; the chip must not repeat it',
  );
  assert.match(html, /data-slot="metabot-twin-badge"/);
  assert.doesNotMatch(html, /role="menu"/);
  assert.ok(html.includes(i18nService.t('botInternetBotPickerChip')));
});

test('compact picker supports history-specific copy and avatar sizing', () => {
  const html = renderChip({
    size: 'compact',
    ariaLabel: 'Filter session history by bot',
    menuHint: 'Only filters history',
    menuOpen: true,
  });
  assert.match(html, /h-5 w-5 rounded-md/);
  assert.match(html, /h-7 gap-1.5/);
  assert.ok(html.includes('aria-label="Filter session history by bot"'));
  assert.ok(html.includes('Only filters history'));
  assert.doesNotMatch(html, new RegExp(i18nService.t('botInternetBotPickerHint')));
});

test('open picker menu lists every bot with no disabled rows', () => {
  const html = renderChip({ menuOpen: true, chipMetabot: worker });

  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /role="menu"/);
  assert.match(html, /data-slot="bot-picker-menu"/);
  assert.equal(countOccurrences(html, 'role="menuitem"'), roster.length);
  for (const bot of roster) {
    assert.ok(html.includes(bot.name), `menu should list ${bot.name}`);
  }
  // A pure selection: NO row may be disabled, not even the Twin — picking a
  // worker must never be an appointment with gates, it is just a choice.
  const disabledRows = html.match(/<button[^>]*role="menuitem"[^>]*disabled/g) ?? [];
  assert.equal(disabledRows.length, 0, 'every roster row stays selectable');
  // Exactly the currently picked bot is highlighted.
  assert.equal(
    countOccurrences(html, 'aria-selected="true"'),
    1,
    'exactly the picked bot row is marked selected',
  );
  assert.ok(html.includes('aria-selected="false"'), 'the other rows are explicitly unselected');
  // The Twin is badged on its menu row; the chip itself only carries the
  // badge when the picked bot IS the Twin.
  assert.equal(
    countOccurrences(html, 'data-slot="metabot-twin-badge"'),
    1,
    'with a worker picked, only the Twin menu row is badged',
  );
  const twinPickedHtml = renderChip({ menuOpen: true, chipMetabot: twin });
  assert.equal(
    countOccurrences(twinPickedHtml, 'data-slot="metabot-twin-badge"'),
    2,
    'with the Twin picked, the chip and its menu row are both badged',
  );
  assert.ok(html.includes(i18nService.t('botInternetBotPickerTitle')));
  assert.ok(html.includes(i18nService.t('botInternetBotPickerHint')));
});

test('supersession (v3 close wiring): the chip has NO live form — live identity is the badge', () => {
  // The 18:21 layout kept a display-only live branch on this chip; the v3
  // close wiring moved that role to CoworkSurfaceIdentityBadge (see
  // surfaceIdentityBadge.test.tsx), so the chip is draft-only and `live` is
  // no longer a prop (type-enforced — passing it here would not compile).
  // The chip ALWAYS renders the picker trigger, even with a menu open:
  const html = renderChip({ menuOpen: true });
  assert.match(html, /aria-haspopup="menu"/);
  assert.match(html, /role="menu"/);
});

test('open menu + pointer outside the chip container => menu closes', () => {
  const fakeDocument = createFakePointerDocument();
  const trigger = { name: 'trigger' };
  const menuRow = { name: 'menu-row' };
  let open = true;

  const off = bindSeatMenuOutsideDismiss({
    container: () => fakeContainer(trigger, menuRow),
    onDismiss: () => {
      open = false;
    },
    doc: fakeDocument,
  });

  assert.equal(fakeDocument.pointerDownListenerCount, 1, 'bound while the menu is open');
  fakeDocument.pointerDown(trigger);
  assert.equal(open, true, 'a pointer on the trigger chip is inside the container');

  fakeDocument.pointerDown({ name: 'transcript' });
  assert.equal(open, false, 'a pointer anywhere outside the chip closes the menu');

  off();
  assert.equal(fakeDocument.pointerDownListenerCount, 0, 'unbind removes the listener');
});

test('open menu + pointer inside a row => no dismiss, and the row still selects', () => {
  const fakeDocument = createFakePointerDocument();
  const rowNode = { name: 'menu-row' };
  let dismissals = 0;

  const off = bindSeatMenuOutsideDismiss({
    container: () => fakeContainer(rowNode),
    onDismiss: () => {
      dismissals += 1;
    },
    doc: fakeDocument,
  });

  fakeDocument.pointerDown(rowNode);
  assert.equal(dismissals, 0, 'a row click must not be swallowed by outside-dismiss');

  const picked: BotPickerChipBot[] = [];
  const row = BotPickerMenuRow({
    metabot: worker,
    isSelected: false,
    onSelect: (bot) => picked.push(bot),
  });
  assert.ok(row, 'the row renders');
  assert.equal(row.props.disabled, undefined, 'no row is ever disabled — selection is pure');
  row.props.onClick();
  assert.deepEqual(picked, [worker], 'clicking a row picks exactly that bot');

  const twinRow = BotPickerMenuRow({ metabot: twin, isSelected: false, onSelect: noop });
  assert.ok(twinRow);
  assert.equal(twinRow.props.disabled, undefined, 'the Twin row is selectable like any other');

  const selectedRow = BotPickerMenuRow({ metabot: worker, isSelected: true, onSelect: noop });
  assert.ok(selectedRow);
  assert.equal(selectedRow.props['aria-selected'], true, 'the picked row is marked selected');

  off();
});
