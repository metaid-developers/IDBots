import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  SMOOTH_DRAIN_WINDOW_MS,
  SMOOTH_MIN_CHARS_PER_MS,
  snapRevealIndex,
  stepSmoothReveal,
} from '../src/mobile/app/chat/smoothStreaming.ts';

test('snapRevealIndex never splits UTF-16 surrogate pairs or variation selectors', () => {
  const text = 'Hi 🚀✨!';
  // 'Hi ' = 3, 🚀 = indices 3..4, ✨ = index 5, '!' = index 6
  assert.equal(snapRevealIndex(text, 4), 5);
  assert.equal(text.slice(0, snapRevealIndex(text, 4)), 'Hi 🚀');

  const withVs16 = 'A☀️B';
  // 'A' = 0, '☀' = 1, '\uFE0F' = 2, 'B' = 3
  assert.equal(snapRevealIndex(withVs16, 2), 3);
  assert.equal(withVs16.slice(0, snapRevealIndex(withVs16, 2)), 'A☀️');
});

test('stepSmoothReveal drains a 90ms server batch progressively at 60fps without stalling', () => {
  const targetText = 'Hello world! This is a smooth streaming test sentence.';
  let revealedCount = 0;
  let carry = 0;
  const steps: number[] = [];

  // Simulate 6 frames (~100ms total) for a 54-char batch.
  for (let frame = 0; frame < 6; frame += 1) {
    const next = stepSmoothReveal({
      revealedCount,
      targetText,
      dtMs: 16.67,
      carry,
    });
    steps.push(next.revealedCount - revealedCount);
    revealedCount = next.revealedCount;
    carry = next.carry;
  }

  assert.ok(steps.every((delta) => delta > 0), `every frame should reveal characters smoothly: ${steps}`);
  assert.ok(revealedCount > targetText.length * 0.6, `should keep pace within ~100ms, got ${revealedCount}/${targetText.length}`);
  assert.ok(revealedCount < targetText.length, 'should pace across frames rather than dumping all at once on frame 1');
});

test('stepSmoothReveal accumulates fractional carry on 120Hz frames for tiny deltas', () => {
  const targetText = 'Hi';
  const frame1 = stepSmoothReveal({ revealedCount: 0, targetText, dtMs: 8, carry: 0 });
  assert.equal(frame1.revealedCount, 0);
  assert.ok(frame1.carry > 0);

  const frame2 = stepSmoothReveal({
    revealedCount: frame1.revealedCount,
    targetText,
    dtMs: 8,
    carry: frame1.carry,
  });
  assert.ok(frame2.revealedCount >= 1);
});

test('stepSmoothReveal catches up rapidly on large bursts without slowing overall throughput', () => {
  const largeText = 'x'.repeat(2000);
  let revealedCount = 0;
  let carry = 0;
  // Run ~120ms of frames (8 frames at 16.67ms) while keeping pace with large backlog.
  for (let i = 0; i < 8; i += 1) {
    const next = stepSmoothReveal({
      revealedCount,
      targetText: largeText,
      dtMs: 16.67,
      carry,
    });
    revealedCount = next.revealedCount;
    carry = next.carry;
  }
  assert.ok(revealedCount > 1400, `large burst should mostly drain within ~133ms, got ${revealedCount}`);
  // After one full drain window elapsed in a single catch-up frame (e.g. tab resume),
  // it catches up to 100% immediately.
  const resume = stepSmoothReveal({
    revealedCount,
    targetText: largeText,
    dtMs: SMOOTH_DRAIN_WINDOW_MS,
    carry,
  });
  assert.equal(resume.revealedCount, largeText.length);
  assert.equal(resume.carry, 0);
});

test('stepSmoothReveal respects minimum speed floor and clamps non-positive dt', () => {
  const targetText = 'abcdef';
  const zeroDt = stepSmoothReveal({ revealedCount: 1, targetText, dtMs: 0, carry: 0.25 });
  assert.equal(zeroDt.revealedCount, 1);
  assert.equal(zeroDt.carry, 0.25);

  const normalDt = stepSmoothReveal({ revealedCount: 0, targetText, dtMs: 16.67, carry: 0 });
  assert.ok(normalDt.revealedCount >= Math.floor(SMOOTH_MIN_CHARS_PER_MS * 16.67));
});

test('mobile chat scroll container disables CSS scroll anchoring and uses pre-paint layout pinning', () => {
  const css = readFileSync(
    new URL('../src/mobile/app/twin-ui.css', import.meta.url),
    'utf8',
  );
  const chatScreen = readFileSync(
    new URL('../src/mobile/app/screens/ChatScreen.tsx', import.meta.url),
    'utf8',
  );

  assert.match(css, /\.twin-scroll\s*\{[^}]*overflow-anchor:\s*none;/s);
  assert.match(chatScreen, /overflow-anchor-none/);
  assert.match(chatScreen, /useLayoutEffect/);
  assert.match(chatScreen, /isStreaming=\{message\.streaming\}/);
  assert.match(chatScreen, /useSmoothStreamingText\(/);
  assert.match(chatScreen, /pinningScrollRef\.current/);
  assert.match(chatScreen, /ResizeObserver/);
});
