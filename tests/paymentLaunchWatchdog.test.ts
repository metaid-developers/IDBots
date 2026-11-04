import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LAUNCH_DEGRADE_MS, startLaunchWatchdog } from '../src/renderer/components/chat/paymentLaunchWatchdog';

/** Deterministic fake clock: timers never fire until the test advances time. */
function createFakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    setTimeoutFn(fn: () => void, ms: number) {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeoutFn(handle: unknown) {
      timers.delete(handle as number);
    },
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
    pendingCount() {
      return timers.size;
    },
  };
}

describe('payment launch watchdog (2s degrade window)', () => {
  it('degrades exactly once when no hide signal arrives within 2s', () => {
    const clock = createFakeClock();
    let degraded = 0;
    const watchdog = startLaunchWatchdog(() => { degraded += 1; }, clock);

    clock.advance(LAUNCH_DEGRADE_MS - 1);
    assert.equal(degraded, 0, 'must not degrade before the 2s window closes');
    clock.advance(1);
    assert.equal(degraded, 1, 'degrades at exactly 2s');
    assert.equal(watchdog.degraded(), true);

    clock.advance(10_000);
    assert.equal(degraded, 1, 'never degrades twice');
    assert.equal(clock.pendingCount(), 0);
  });

  it('does not degrade when the page hides before 2s (launch succeeded)', () => {
    const clock = createFakeClock();
    let degraded = 0;
    const watchdog = startLaunchWatchdog(() => { degraded += 1; }, clock);

    clock.advance(300);
    watchdog.succeed(); // visibilitychange/pagehide/blur observed
    clock.advance(10_000);
    assert.equal(degraded, 0);
    assert.equal(watchdog.degraded(), false);
    assert.equal(clock.pendingCount(), 0, 'timer cleared on success');
  });

  it('a late hide signal after the degrade fired changes nothing', () => {
    const clock = createFakeClock();
    let degraded = 0;
    const watchdog = startLaunchWatchdog(() => { degraded += 1; }, clock);
    clock.advance(LAUNCH_DEGRADE_MS);
    assert.equal(degraded, 1);
    watchdog.succeed();
    watchdog.cancel();
    assert.equal(degraded, 1);
  });

  it('cancel() stops watching without degrading (unmount / manual fallback)', () => {
    const clock = createFakeClock();
    let degraded = 0;
    const watchdog = startLaunchWatchdog(() => { degraded += 1; }, clock);
    clock.advance(500);
    watchdog.cancel();
    clock.advance(10_000);
    assert.equal(degraded, 0);
    assert.equal(clock.pendingCount(), 0);
  });

  it('defaults to the 2000ms window required by the acceptance criteria', () => {
    assert.equal(LAUNCH_DEGRADE_MS, 2000);
  });
});
