import type { AsrUpstreamEvent } from '../src/services/asr/types.js';

/** Shared collector + waiter for UpstreamProvider event streams. */
export function eventCollector(): {
  events: AsrUpstreamEvent[];
  onEvent: (event: AsrUpstreamEvent) => void;
  wait: (pred: (e: AsrUpstreamEvent) => boolean, ms?: number) => Promise<AsrUpstreamEvent>;
} {
  const events: AsrUpstreamEvent[] = [];
  const waiters: Array<{
    pred: (e: AsrUpstreamEvent) => boolean;
    resolve: (e: AsrUpstreamEvent) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  const onEvent = (event: AsrUpstreamEvent): void => {
    events.push(event);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].pred(event)) {
        clearTimeout(waiters[i].timer);
        waiters[i].resolve(event);
        waiters.splice(i, 1);
      }
    }
  };
  const wait = (pred: (e: AsrUpstreamEvent) => boolean, ms = 3000): Promise<AsrUpstreamEvent> =>
    new Promise((resolve, reject) => {
      const existing = [...events].reverse().find(pred);
      if (existing) {
        resolve(existing);
        return;
      }
      const timer = setTimeout(() => reject(new Error('event wait timed out')), ms);
      waiters.push({ pred, resolve, timer });
    });
  return { events, onEvent, wait };
}

/** Polls until fn returns non-null (small in-test wait, 40 ms interval). */
export function pollFor<T>(fn: () => T | null, timeoutMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      const value = fn();
      if (value !== null && value !== undefined) {
        resolve(value);
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error('pollFor timed out'));
        return;
      }
      setTimeout(tick, 40);
    };
    tick();
  });
}
