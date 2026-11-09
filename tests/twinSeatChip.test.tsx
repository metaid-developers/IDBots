import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import TwinSeatChip, {
  TwinSeatMenuRow,
  type TwinSeatChipBot,
} from '../src/renderer/features/botBrowser/TwinSeatChip';
import { bindSeatMenuOutsideDismiss } from '../src/renderer/features/botBrowser/seatMenuDismiss';
import { i18nService } from '../src/renderer/services/i18n';

// Behavior coverage for the Bot Internet footer chip (owner ruling
// 2026-11-08 + the outside-click UX gap owner found on the dev screen): the
// draft state is an appointment control whose menu lists the whole roster with
// the acting Twin disabled + badged; a live session keeps a display-only
// identity chip; an open menu closes on an outside pointer but not on a menu
// row, which still starts its appointment. No real roster is touched.

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
      onDismissMenu={noop}
      onAppoint={noop}
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

test('draft chip renders the acting Twin once and is the appointment trigger', () => {
  const html = renderChip();

  assert.match(html, /aria-haspopup="menu"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /data-slot="twin-seat-container"/);
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
  assert.match(html, /data-slot="twin-seat-menu"/);
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

test('open menu + pointer inside a row => no dismiss, and the row still appoints', () => {
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

  const appointed: TwinSeatChipBot[] = [];
  const row = TwinSeatMenuRow({
    metabot: worker,
    isActing: false,
    busy: false,
    onAppoint: (bot) => appointed.push(bot),
  });
  assert.ok(row, 'the row renders');
  assert.equal(row.props.disabled, false);
  row.props.onClick();
  assert.deepEqual(appointed, [worker], 'clicking a non-acting row starts exactly that appointment');

  const actingRow = TwinSeatMenuRow({ metabot: twin, isActing: true, busy: false, onAppoint: noop });
  assert.ok(actingRow);
  assert.equal(actingRow.props.disabled, true, 'the acting Twin row stays informational');
  const busyRow = TwinSeatMenuRow({ metabot: idle, isActing: false, busy: true, onAppoint: noop });
  assert.ok(busyRow);
  assert.equal(busyRow.props.disabled, true, 'no row may start a second appointment while busy');

  off();
});
