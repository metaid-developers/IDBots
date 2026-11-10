import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PANEL_LOCATOR_OVERFLOW_THRESHOLD_PX,
  buildPanelLocatorRows,
  buildPanelLocatorTicks,
  isPanelLocatorOverflow,
  panelLocatorPreviewLines,
  panelLocatorPreviewTop,
  panelLocatorScrollForHandle,
  panelLocatorScrollForRow,
  panelLocatorThumbFor,
  panelLocatorTickIndexAtFraction,
  type PanelLocatorRowBox,
} from '../src/renderer/features/botBrowser/panelMessageLocator';

// Message locator rail math (office purity pass #2 ③): overflow gate, the
// document-true tick map, the two thumb directions, click jumps, hover
// resolution and preview text stripping. Every expectation below is a hand-
// computable fraction over a 400px-content fixture so the numbers pin the
// exact contract, not just monotonic behavior.

// Three boxes tiled over 400px of scroll content (offsets include the gaps
// the transcript's space-y margins produce).
const BOXES: PanelLocatorRowBox[] = [
  { id: 'a', offsetTop: 0, offsetHeight: 100 },
  { id: 'b', offsetTop: 100, offsetHeight: 150 },
  { id: 'c', offsetTop: 250, offsetHeight: 150 },
];

test('overflow gate: threshold, degenerate and NaN inputs stay rail-less', () => {
  assert.equal(PANEL_LOCATOR_OVERFLOW_THRESHOLD_PX, 4);
  assert.equal(isPanelLocatorOverflow(400, 400), false, 'no scroll room, no rail');
  assert.equal(isPanelLocatorOverflow(403, 400), false, 'below the anti-jitter threshold');
  assert.equal(isPanelLocatorOverflow(404, 400), true, 'at the threshold the rail appears');
  assert.equal(isPanelLocatorOverflow(4000, 400), true);
  assert.equal(isPanelLocatorOverflow(400, 500), false, 'negative room is no overflow');
  assert.equal(isPanelLocatorOverflow(Number.NaN, 400), false);
  assert.equal(isPanelLocatorOverflow(400, Number.NaN), false);
  assert.equal(isPanelLocatorOverflow(Number.POSITIVE_INFINITY, 400), false);
});

test('ticks tile the rail in exact document proportion, sorted by offset', () => {
  const ticks = buildPanelLocatorTicks(BOXES, 400);
  assert.deepEqual(ticks.map((tick) => tick.id), ['a', 'b', 'c']);
  assert.ok(Math.abs(ticks[0].start - 0) < 1e-12);
  assert.ok(Math.abs(ticks[0].height - 0.25) < 1e-12);
  assert.ok(Math.abs(ticks[1].start - 0.25) < 1e-12);
  assert.ok(Math.abs(ticks[1].height - 0.375) < 1e-12);
  assert.ok(Math.abs(ticks[2].start - 0.625) < 1e-12);
  assert.ok(Math.abs(ticks[2].height - 0.375) < 1e-12);
});

test('unsorted input is ordered by offsetTop; last box clamps at the rail end', () => {
  const shuffled = [BOXES[2], BOXES[0], BOXES[1]];
  const ticks = buildPanelLocatorTicks(shuffled, 400);
  assert.deepEqual(ticks.map((tick) => tick.id), ['a', 'b', 'c']);
  // A box running past the content end may not push a tick past 100%.
  const overhanging = buildPanelLocatorTicks([{ id: 'x', offsetTop: 300, offsetHeight: 300 }], 400);
  assert.equal(overhanging.length, 1);
  assert.ok(Math.abs(overhanging[0].start - 0.75) < 1e-12);
  assert.ok(Math.abs(overhanging[0].height - 0.25) < 1e-12, 'height clamps to the remaining rail');
});

test('degenerate content heights produce an empty tick map', () => {
  assert.deepEqual(buildPanelLocatorTicks(BOXES, 0), []);
  assert.deepEqual(buildPanelLocatorTicks(BOXES, -1), []);
  assert.deepEqual(buildPanelLocatorTicks(BOXES, Number.NaN), []);
  assert.deepEqual(buildPanelLocatorTicks([], 400), []);
});

test('ticks carry the user/assistant flag from the supplied id map', () => {
  const ticks = buildPanelLocatorTicks(BOXES, 400, new Map([['a', true], ['b', false]]));
  assert.equal(ticks[0].isUser, true);
  assert.equal(ticks[1].isUser, false);
  assert.equal(ticks[2].isUser, false, 'missing id defaults to assistant');
});

test('thumb covers the visible fraction and clamps at both ends', () => {
  const mid = panelLocatorThumbFor(100, 400, 100);
  assert.ok(Math.abs(mid.size - 0.25) < 1e-12);
  assert.ok(Math.abs(mid.start - 0.25) < 1e-12);

  const end = panelLocatorThumbFor(10_000, 400, 100);
  assert.ok(Math.abs(end.start - 0.75) < 1e-12, 'start clamps to 1 - size');
  const top = panelLocatorThumbFor(-50, 400, 100);
  assert.equal(top.start, 0);

  const idle = panelLocatorThumbFor(0, 100, 100);
  assert.deepEqual(idle, { start: 0, size: 1 }, 'nothing to scroll: full-height thumb');
  assert.deepEqual(panelLocatorThumbFor(0, 0, 0), { start: 0, size: 1 });
  assert.deepEqual(panelLocatorThumbFor(Number.NaN, 400, 100), { start: 0, size: 1 });
});

test('drag mapping anchors the thumb center and clamps to the scroll range', () => {
  // Halfway down a 400px rail: scrollTop = 0.5*400 - 100/2 = 150.
  assert.equal(panelLocatorScrollForHandle(200, 400, 400, 100), 150);
  // Rail top: negative anchor clamps to 0.
  assert.equal(panelLocatorScrollForHandle(0, 400, 400, 100), 0);
  // Rail bottom: 400 - 50 = 350 exceeds maxScroll 300 → 300.
  assert.equal(panelLocatorScrollForHandle(400, 400, 400, 100), 300);
  assert.equal(panelLocatorScrollForHandle(200, 0, 400, 100), 0, 'zero rail never scrolls');
  assert.equal(panelLocatorScrollForHandle(200, 400, 100, 100), 0, 'no overflow, no scroll');
});

test('tick clicks jump to the row top with a lead, clamped to the range', () => {
  assert.equal(panelLocatorScrollForRow(300, 400, 100), 292, 'row top minus the 8px lead');
  assert.equal(panelLocatorScrollForRow(5, 400, 100), 0, 'rows near the top clamp to 0');
  assert.equal(panelLocatorScrollForRow(2000, 400, 100), 300, 'end rows clamp to max scroll');
  assert.equal(panelLocatorScrollForRow(Number.NaN, 400, 100), 0);
});

test('hover resolution: coverage is "last tick with start <= fraction"', () => {
  const ticks = buildPanelLocatorTicks(BOXES, 400);
  assert.equal(panelLocatorTickIndexAtFraction(ticks, 0.1), 0, 'inside a');
  assert.equal(panelLocatorTickIndexAtFraction(ticks, 0.25), 1, 'seam resolves to the lower message');
  assert.equal(panelLocatorTickIndexAtFraction(ticks, 0.9), 2, 'inside c');
  assert.equal(panelLocatorTickIndexAtFraction(ticks, 1), 2, 'rail end resolves to the last tick');
  assert.equal(panelLocatorTickIndexAtFraction(ticks, -0.5), 0, 'negative clamps into the first tick');
  assert.equal(panelLocatorTickIndexAtFraction([], 0.5), -1);
  assert.equal(panelLocatorTickIndexAtFraction(ticks, Number.NaN), -1);
});

test('preview lines strip attachment markers, markdown images and blanks', () => {
  const content = [
    '附件路径: /tmp/a.png',
    '',
    '你好呀',
    '第二行正文',
    '![图片](http://example.com/x.png)',
    '第三行正文',
  ].join('\n');
  assert.deepEqual(panelLocatorPreviewLines(content), ['你好呀', '第二行正文']);
  assert.deepEqual(
    panelLocatorPreviewLines(content, 3),
    ['你好呀', '第二行正文', '第三行正文'],
    'maxLines lifts the cut',
  );
  // The marker grammar also covers the English composer spellings.
  assert.deepEqual(panelLocatorPreviewLines('input file: /tmp/b.png\nreal text'), ['real text']);
  assert.deepEqual(panelLocatorPreviewLines('attachment path: /tmp/c.png\ntext'), ['text']);
  assert.deepEqual(
    panelLocatorPreviewLines('附件路径: /tmp/a.png\n\n![x](y.png)'),
    [],
    'all bookkeeping, no conversation text',
  );
  assert.deepEqual(panelLocatorPreviewLines(''), []);
  assert.deepEqual(panelLocatorPreviewLines('   \n  '), []);
});

test('preview card is centered on the pointer and clamped inside the rail', () => {
  assert.equal(panelLocatorPreviewTop(100, 64, 400), 68, 'centered: 100 - 32');
  assert.equal(panelLocatorPreviewTop(2, 64, 400), 6, 'top clamp');
  assert.equal(panelLocatorPreviewTop(390, 64, 400), 330, 'bottom clamp: rail - card - margin');
  assert.equal(panelLocatorPreviewTop(30, 64, 60), 6, 'rail shorter than the card pins at the top');
  assert.equal(panelLocatorPreviewTop(30, 64, 0), 6, 'degenerate rail still returns a finite top');
});

test('rows map visible messages to sender labels and plain content', () => {
  const rows = buildPanelLocatorRows(
    [
      { id: 'u1', type: 'user', content: 'hello' },
      { id: 'a1', type: 'assistant', content: 'hi there' },
      { id: 'a2', type: 'assistant' },
    ],
    { botName: 'Monday', userLabel: '你' },
  );
  assert.deepEqual(
    rows,
    [
      { id: 'u1', isUser: true, sender: '你', content: 'hello' },
      { id: 'a1', isUser: false, sender: 'Monday', content: 'hi there' },
      { id: 'a2', isUser: false, sender: 'Monday', content: '' },
    ],
  );
  const noBot = buildPanelLocatorRows([{ id: 'a3', type: 'assistant', content: 'x' }], { botName: null, userLabel: 'You' });
  assert.equal(noBot[0].sender, '', 'unknown bot degrades to an empty sender');
});
