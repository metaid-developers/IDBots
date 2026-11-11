import test from 'node:test';
import assert from 'node:assert/strict';

import {
  dampedSidebarDelta,
  easeOutCubic,
  startSidebarResizeSession,
  type SidebarResizeEndInfo,
  type SidebarResizeSessionOptions,
} from '../src/renderer/utils/sidebarResizeSession';
import {
  clampSidebarWidth,
  maxSidebarWidthForWindow,
  SIDEBAR_WIDTH_MIN,
} from '../src/renderer/utils/sidebarWidth';

/**
 * Behavioral guard for the seam drag state machine.
 *
 * The owner-visible failure these tests pin: the column used to follow the
 * pointer with NO button held — a drag session that never received its
 * mouseup (released outside the window, right-click context menu, or a fast
 * click that outran the React effect that subscribed the document listeners)
 * stayed "held" forever, and every later mousemove resized the column.
 *
 * The two acceptance cases are the first two below:
 *   · mousemove after mouseup must not change the width
 *   · mousemove without the primary button must not change the width
 * The rest cover the other exit paths that used to be able to strand it.
 */

type Listener = (event: {
  type: string;
  clientX?: number;
  buttons?: number;
  key?: string;
}) => void;

/** Minimal document/window stand-in: add/remove/dispatch + listener census. */
class MockEventTarget {
  private listeners = new Map<string, Listener[]>();
  visibilityState: 'visible' | 'hidden' = 'visible';

  addEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: Listener): void {
    const list = this.listeners.get(type) ?? [];
    this.listeners.set(type, list.filter((entry) => entry !== listener));
  }

  dispatch(type: string, event: { clientX?: number; buttons?: number; key?: string } = {}): void {
    const payload = { type, ...event };
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(payload);
  }

  count(type: string): number {
    return (this.listeners.get(type) ?? []).length;
  }
}

const ALL_DOCUMENT_EVENTS = [
  'mousemove',
  'mouseup',
  'pointerup',
  'pointercancel',
  'keydown',
  'visibilitychange',
];

function setup(overrides: Partial<SidebarResizeSessionOptions> = {}) {
  const doc = new MockEventTarget();
  const win = new MockEventTarget();
  const widths: number[] = [];
  const ends: SidebarResizeEndInfo[] = [];
  const session = startSidebarResizeSession({
    startX: 300,
    startWidth: 320,
    mode: 'home',
    button: 0,
    clamp: clampSidebarWidth,
    onWidth: (width) => widths.push(width),
    onEnd: (info) => ends.push(info),
    documentTarget: doc as unknown as Document,
    windowTarget: win as unknown as Window,
    ...overrides,
  });
  return { doc, win, widths, ends, session };
}

function assertNoListeners(doc: MockEventTarget, win: MockEventTarget): void {
  for (const type of ALL_DOCUMENT_EVENTS) {
    assert.equal(doc.count(type), 0, `document '${type}' listener must be detached`);
  }
  assert.equal(win.count('blur'), 0, "window 'blur' listener must be detached");
}

test('mouseup 后 mousemove 不再改变宽度', () => {
  const { doc, win, widths, ends, session } = setup();

  doc.dispatch('mousemove', { clientX: 340, buttons: 1 });
  assert.deepEqual(widths, [360], 'a held drag drives the width');

  doc.dispatch('mouseup', { buttons: 0 });
  assert.equal(ends.length, 1);
  assert.equal(ends[0].reason, 'mouseup');
  assert.equal(ends[0].width, 360);
  assert.equal(ends[0].moved, true);
  assert.equal(session?.active, false);
  assertNoListeners(doc, win);

  // The exact hang the owner reported: pointer keeps moving with no button.
  doc.dispatch('mousemove', { clientX: 460, buttons: 1 });
  doc.dispatch('mousemove', { clientX: 480, buttons: 0 });
  assert.deepEqual(widths, [360], 'a finished session can never resize again');
  assert.equal(ends.length, 1, 'pairs are 1:1 — no second end callback');
});

test('mousemove 无 buttons 不会改变宽度', () => {
  const { doc, widths, ends } = setup();

  // Either the buttons field is absent entirely or explicitly 0: both mean
  // "no primary button is down", and both must end the session instead of
  // following the pointer.
  doc.dispatch('mousemove', { clientX: 420 });
  assert.deepEqual(widths, [], 'an unpressed move must not resize');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].reason, 'pointer-released');
  assert.equal(ends[0].moved, false);

  doc.dispatch('mousemove', { clientX: 460, buttons: 0 });
  assert.deepEqual(widths, [], 'still nothing after the defensive finish');
  assert.equal(ends.length, 1, 'finish is idempotent');
});

test('a drag released outside the window heals on the first unpressed move', () => {
  // The window never saw the up: blur may or may not fire (alt-tab does,
  // a second monitor release does not). Either way the next move inside the
  // window must not resize.
  const { doc, widths, ends } = setup();
  doc.dispatch('mousemove', { clientX: 350, buttons: 1 });
  assert.deepEqual(widths, [370]);

  doc.dispatch('mousemove', { clientX: 410, buttons: 0 });
  assert.deepEqual(widths, [370], 'the first unpressed move ends, never drags');
  assert.equal(ends[0].reason, 'pointer-released');
});

test('window blur is a hard exit (alt-tab during a drag)', () => {
  const { doc, win, widths, ends } = setup();
  doc.dispatch('mousemove', { clientX: 330, buttons: 1 });
  assert.deepEqual(widths, [350]);

  win.dispatch('blur');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].reason, 'window-blur');
  assertNoListeners(doc, win);

  doc.dispatch('mousemove', { clientX: 450, buttons: 1 });
  assert.deepEqual(widths, [350], 'blur ended the session for good');
});

test('visibilitychange to hidden is a hard exit (tab hidden mid-drag)', () => {
  const { doc, win, widths, ends } = setup();
  doc.dispatch('mousemove', { clientX: 330, buttons: 1 });

  doc.visibilityState = 'hidden';
  doc.dispatch('visibilitychange');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].reason, 'visibility-hidden');
  assertNoListeners(doc, win);

  doc.dispatch('mousemove', { clientX: 450, buttons: 1 });
  assert.deepEqual(widths, [350]);
});

test('Escape aborts the drag', () => {
  const { doc, win, widths, ends } = setup();
  doc.dispatch('mousemove', { clientX: 330, buttons: 1 });

  doc.dispatch('keydown', { key: 'Escape' });
  assert.equal(ends[0].reason, 'escape');
  assertNoListeners(doc, win);

  doc.dispatch('mousemove', { clientX: 450, buttons: 1 });
  assert.deepEqual(widths, [350]);
});

test('pointerup terminates even when the mouseup never arrives', () => {
  const { doc, win, ends } = setup();
  doc.dispatch('pointerup');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].reason, 'pointerup');
  assertNoListeners(doc, win);
});

test('pointercancel terminates (touch/pen or OS-level pointer loss)', () => {
  const { doc, win, ends } = setup();
  doc.dispatch('pointercancel');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].reason, 'pointercancel');
  assertNoListeners(doc, win);
});

test('pointerup + mouseup for the same physical release end the session once', () => {
  const { doc, ends } = setup();
  doc.dispatch('pointerup');
  doc.dispatch('mouseup');
  assert.equal(ends.length, 1, 'one physical release = one end callback');
});

test('only the primary button can start a session', () => {
  for (const button of [1, 2, 3]) {
    const { doc, win, widths, ends, session } = setup({ button });
    assert.equal(session, null, `button=${button} must not start a drag`);
    assert.deepEqual(widths, []);
    assert.deepEqual(ends, []);
    assertNoListeners(doc, win);
  }
});

test('the width is clamped to the 240–480 range while dragging', () => {
  const { doc, widths, ends } = setup();
  doc.dispatch('mousemove', { clientX: 2000, buttons: 1 });
  assert.deepEqual(widths, [480]);
  doc.dispatch('mousemove', { clientX: -400, buttons: 1 });
  assert.deepEqual(widths, [480, 240]);
  doc.dispatch('mouseup');
  assert.equal(ends[0].width, 240);
});

test('a non-finite start position is refused rather than arming listeners', () => {
  const { doc, win, session } = setup({ startX: Number.NaN });
  assert.equal(session, null);
  assertNoListeners(doc, win);
});

test('explicit finish(reason) tears down and reports the reason once', () => {
  const { doc, win, ends, session } = setup();
  session?.finish('unmount');
  assert.equal(ends.length, 1);
  assert.equal(ends[0].reason, 'unmount');
  assert.equal(session?.active, false);
  assertNoListeners(doc, win);

  session?.finish('unmount');
  assert.equal(ends.length, 1, 'finish is idempotent');
});

// ── Extreme damping (drag-cap companion; the band math is cap-independent,
// so the pure tests below exercise it against REPRESENTATIVE bounds 240/548
// — the retired 40:60 cap on a 1440 window. The live cap on that window is
// the 50:50 half-split 686 (2026-11-11 evening ruling); the double-click
// 3:7 baseline is 411. The range is far wider than 2× the 96px band, so the
// identity zone exists and the integration test further down covers the live
// cap end to end.) ──

test('dampedSidebarDelta is the identity far from both edges', () => {
  // Representative bounds min 240 / max 548 (needs a range wider than the two
  // 96px bands; see the block comment above): 400 sits ≥96px from both
  // edges — outside the damping band, so deltas pass through untouched.
  assert.equal(dampedSidebarDelta(10, 400, 240, 548), 10);
  assert.equal(dampedSidebarDelta(-10, 400, 240, 548), -10);
  assert.equal(dampedSidebarDelta(0, 400, 240, 548), 0);
  assert.equal(dampedSidebarDelta(Number.NaN, 400, 240, 548), 0);
  // The 320 default sits 80px over the minimum: INSIDE the 96px band, so a
  // leftward drag is already gently damped (factor 80/96 → round(−8.33)=−8).
  assert.equal(dampedSidebarDelta(-10, 320, 240, 548), -8);
});

test('dampedSidebarDelta shrinks movement near the cap and is 0 at it', () => {
  // 8px under the 548 cap: factor = max(0.12, 8/96) = 0.12 → round(1.2) = 1.
  assert.equal(dampedSidebarDelta(10, 540, 240, 548), 1);
  // Half-band room: factor 0.5 → 25 applied; the applied magnitude can never
  // cross the bound (25 ≤ the 48px of room).
  assert.equal(dampedSidebarDelta(50, 500, 240, 548), 25);
  assert.equal(dampedSidebarDelta(10, 548, 240, 548), 0);
  assert.equal(dampedSidebarDelta(10, 600, 240, 548), 0);
});

test('dampedSidebarDelta shrinks movement near the minimum and is 0 at it', () => {
  assert.equal(dampedSidebarDelta(-10, 244, 240, 548), -1);
  assert.equal(dampedSidebarDelta(-10, 240, 240, 548), 0);
  assert.equal(dampedSidebarDelta(-10, 200, 240, 548), 0);
});

test('dampedSidebarDelta never dampens movement AWAY from the nearby edge', () => {
  // Sitting 8px under the cap but moving LEFT (away from it): full speed.
  assert.equal(dampedSidebarDelta(-10, 540, 240, 548), -10);
  // Sitting 4px over the floor but moving RIGHT (away from it): full speed.
  assert.equal(dampedSidebarDelta(10, 244, 240, 548), 10);
});

test('easeOutCubic is a monotonic 0→1 curve with a soft landing', () => {
  assert.equal(easeOutCubic(0), 0);
  assert.equal(easeOutCubic(1), 1);
  assert.equal(easeOutCubic(0.5), 0.875);
  let previous = -Infinity;
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const value = easeOutCubic(t);
    assert.ok(value >= previous, `curve must not regress at t=${t}`);
    assert.ok(value >= 0 && value <= 1.0001, `curve stays in [0,1] at t=${t}`);
    previous = value;
  }
});

test('a shapeNext shaper damps the drag and clamp still bounds it', () => {
  // 50:50 drag-cap ruling (2026-11-11 evening; supersedes the same-day
  // fixed-width 480px cap on this assertion — the damping-band math itself
  // is cap-independent and unchanged): the live cap for a 1440 window is
  // HALF the split (1372 / 2 = 686; the right-pane rule 892 is looser).
  // Band 96 means damping kicks in only within 96px of the cap — from the
  // 320 default the room is 366, so the first three +100 steps arrive
  // undamped and only the last one damps.
  const cap = maxSidebarWidthForWindow(1440);
  assert.equal(cap, 686, 'the live 50:50 drag cap on a 1440 window');
  const { doc, widths, ends } = setup({
    clamp: (width) => clampSidebarWidth(width, 1440),
    shapeNext: (rawNext, current) => current + dampedSidebarDelta(
      rawNext - current,
      current,
      SIDEBAR_WIDTH_MIN,
      cap,
    ),
  });
  // +100 steps from the 320 default: 420 (room 366 ≥ band 96 → undamped),
  // 520 (room 266 → undamped), 620 (room 166 → undamped), then the fourth
  // step enters the band (room 66 < 96 → damped to exactly the remaining 66)
  // and settles ON the cap at 686; every later move re-pursues a rawNext
  // past the cap, the shaper returns delta 0, and the session's
  // `next === width` gate filters it — no one frame per move.
  doc.dispatch('mousemove', { clientX: 400, buttons: 1 });
  doc.dispatch('mousemove', { clientX: 500, buttons: 1 });
  doc.dispatch('mousemove', { clientX: 600, buttons: 1 });
  doc.dispatch('mousemove', { clientX: 700, buttons: 1 });
  doc.dispatch('mousemove', { clientX: 800, buttons: 1 });
  doc.dispatch('mouseup');
  assert.deepEqual(widths, [420, 520, 620, 686], 'third step still undamped; fourth damps into the cap; at-cap moves are filtered as no-ops');
  for (const width of widths) {
    assert.ok(width <= cap, `every width must respect the drag cap (${width} ≤ ${cap})`);
    assert.ok(width >= SIDEBAR_WIDTH_MIN);
  }
  assert.equal(ends[0].reason, 'mouseup');
  assert.equal(ends[0].width, 686, 'the damped drag settles exactly at the 50:50 cap');
});

test('a shapeNext shaper still runs on no-delta moves; the session filters the no-op', () => {
  const cap = maxSidebarWidthForWindow(1440);
  let shapeCalls = 0;
  const { doc, widths } = setup({
    clamp: (width) => clampSidebarWidth(width, 1440),
    shapeNext: (rawNext, current) => {
      shapeCalls += 1;
      return current + dampedSidebarDelta(rawNext - current, current, SIDEBAR_WIDTH_MIN, cap);
    },
  });
  doc.dispatch('mousemove', { clientX: 320, buttons: 1 }); // +20 from startX 300
  assert.equal(shapeCalls, 1);
  // Under the 50:50 cap (686 at 1440) the 320 default sits 366px under it —
  // OUTSIDE the 96px damping band, so the +20 arrives undamped → 340.
  // (Under the old 3:7 cap this same move was damped to +19.)
  assert.deepEqual(widths, [320 + dampedSidebarDelta(20, 320, SIDEBAR_WIDTH_MIN, cap)]);
  doc.dispatch('mousemove', { clientX: 320, buttons: 1 }); // same position
  assert.equal(shapeCalls, 2, 'the shaper still runs');
  // rawNext is ANCHORED TO startWidth (320 + 20 = 340) and the width has
  // already converged onto it, so the same-position move is a filtered no-op.
  assert.deepEqual(widths, [340], 'converged onto the raw anchor: filtered as a no-op');
  doc.dispatch('mousemove', { clientX: 320, buttons: 1 }); // same position again
  assert.equal(shapeCalls, 3, 'the shaper keeps running');
  assert.deepEqual(widths, [340], 'still converged: filtered as a no-op');
});
