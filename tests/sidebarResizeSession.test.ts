import test from 'node:test';
import assert from 'node:assert/strict';

import {
  startSidebarResizeSession,
  type SidebarResizeEndInfo,
  type SidebarResizeSessionOptions,
} from '../src/renderer/utils/sidebarResizeSession';
import { clampSidebarWidth } from '../src/renderer/utils/sidebarWidth';

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
