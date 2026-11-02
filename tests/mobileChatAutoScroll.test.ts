import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NEAR_BOTTOM_THRESHOLD_PX,
  isNearBottom,
} from '../src/mobile/app/chat/autoScroll.ts';
import { mobileI18n, t } from '../src/mobile/i18n.ts';

/**
 * Scroll-guard unit tests (mobile chat auto-scroll fix).
 *
 * ChatScreen's auto-follow is keyed on isNearBottom: while the transcript
 * viewport sits within NEAR_BOTTOM_THRESHOLD_PX of the bottom it keeps the
 * original follow (scrollTop = scrollHeight on every message/streaming
 * delta); further up, updates must leave the scroll position untouched and
 * only the floating "new messages" pill appears. These tests pin the
 * predicate's boundary math — the component wiring (listener + guarded
 * effect + pill tap) is covered by the ChatScreen render tests and e2e.
 */

function metrics(scrollTop: number, scrollHeight: number, clientHeight: number) {
  return { scrollTop, scrollHeight, clientHeight };
}

test('threshold constant is pinned at 120px', () => {
  assert.equal(NEAR_BOTTOM_THRESHOLD_PX, 120);
});

test('exactly at the bottom is near', () => {
  // scrollHeight 1000, client 600 → bottomed scrollTop is 400.
  assert.equal(isNearBottom(metrics(400, 1000, 600)), true);
});

test('distance within the threshold counts as near (inclusive boundary)', () => {
  assert.equal(isNearBottom(metrics(280, 1000, 600)), true); // distance 120 exactly → near
  assert.equal(isNearBottom(metrics(281, 1000, 600)), true); // distance 119 → near
  assert.equal(isNearBottom(metrics(360, 1000, 600)), true); // distance 40 → near
});

test('reading history far from the bottom is not near', () => {
  assert.equal(isNearBottom(metrics(0, 1000, 600)), false); // top of the transcript (distance 400)
  assert.equal(isNearBottom(metrics(100, 5000, 600)), false); // deep history (distance 4300)
  assert.equal(isNearBottom(metrics(279, 1000, 600)), false); // distance 121 — one past the threshold
});

test('non-overflowing transcript is always near', () => {
  // Content shorter than the viewport: nothing to scroll, follow must stay on.
  assert.equal(isNearBottom(metrics(0, 400, 600)), true);
});

test('negative distance (overscroll/rubber-band) is clamped to near', () => {
  // iOS overscroll can report scrollTop beyond the max; clamp, not flicker.
  assert.equal(isNearBottom(metrics(405, 1000, 600)), true);
});

test('custom threshold overrides the default', () => {
  assert.equal(isNearBottom(metrics(250, 1000, 600), 200), true); // 150 ≤ 200
  assert.equal(isNearBottom(metrics(100, 1000, 600), 200), false); // 300 > 200
});

test('new-messages pill copy resolves in both languages via t()', () => {
  const previous = mobileI18n.getLanguage();
  try {
    mobileI18n.setLanguage('zh');
    assert.equal(t('mobile.chat.newMessages'), '新消息');
    mobileI18n.setLanguage('en');
    assert.equal(t('mobile.chat.newMessages'), 'New messages');
  } finally {
    mobileI18n.setLanguage(previous);
  }
});
