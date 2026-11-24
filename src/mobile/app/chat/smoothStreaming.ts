import { useEffect, useRef, useState } from 'react';

/** Target time window (ms) over which a buffered delta is drained smoothly. */
export const SMOOTH_DRAIN_WINDOW_MS = 95;

/**
 * Floor reveal speed (UTF-16 code units / ms) so very small deltas finish
 * briskly (~2 chars per 16.6ms frame, ~1 char per 8.3ms 120Hz frame) instead of
 * stalling on the last few characters.
 */
export const SMOOTH_MIN_CHARS_PER_MS = 0.12;

/**
 * Max initial length on first mount of a streaming message that will animate
 * from 0 instead of snapping to the existing prefix. Longer initial text
 * indicates an already-running session restored or reopened mid-stream, which
 * must display immediately without replaying history.
 */
export const INITIAL_SMOOTH_REVEAL_THRESHOLD = 120;

export function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

export function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Clamp/adjust a slice boundary so we never split a UTF-16 surrogate pair
 * (emoji) or leave a trailing variation selector dangling on the next frame.
 */
export function snapRevealIndex(text: string, rawIndex: number): number {
  const len = text.length;
  if (rawIndex <= 0) return 0;
  if (rawIndex >= len) return len;
  let index = Math.floor(rawIndex);
  if (
    index > 0
    && index < len
    && isHighSurrogate(text.charCodeAt(index - 1))
    && isLowSurrogate(text.charCodeAt(index))
  ) {
    index += 1;
  }
  while (index < len && text.charCodeAt(index) === 0xfe0f) {
    index += 1;
  }
  return Math.min(index, len);
}

export interface SmoothRevealStepInput {
  revealedCount: number;
  targetText: string;
  dtMs: number;
  carry: number;
}

export interface SmoothRevealStepResult {
  revealedCount: number;
  carry: number;
}

/**
 * Compute the next character count for one animation frame.
 *
 * Uses proportional drain over SMOOTH_DRAIN_WINDOW_MS (~95ms, matching the
 * server's 90ms stream throttle) with a minimum speed floor so small deltas
 * never stall and large bursts catch up proportionally without slowing down
 * overall throughput.
 */
export function stepSmoothReveal(input: SmoothRevealStepInput): SmoothRevealStepResult {
  const targetLen = input.targetText.length;
  if (input.revealedCount >= targetLen) {
    return { revealedCount: targetLen, carry: 0 };
  }
  const dt = Math.max(0, input.dtMs);
  if (dt === 0) {
    return { revealedCount: input.revealedCount, carry: input.carry };
  }
  const remaining = targetLen - input.revealedCount;
  const rate = Math.max(SMOOTH_MIN_CHARS_PER_MS, remaining / SMOOTH_DRAIN_WINDOW_MS);
  const rawAdvance = rate * dt + Math.max(0, input.carry);
  const wholeAdvance = Math.floor(rawAdvance);
  if (wholeAdvance <= 0) {
    return { revealedCount: input.revealedCount, carry: rawAdvance };
  }
  const nextRaw = Math.min(targetLen, input.revealedCount + wholeAdvance);
  const snapped = snapRevealIndex(input.targetText, nextRaw);
  const carry = snapped >= targetLen ? 0 : rawAdvance - wholeAdvance;
  return { revealedCount: snapped, carry };
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function resolveInitialCount(canAnimate: boolean, streaming: boolean, targetLength: number): number {
  if (!canAnimate || !streaming || targetLength > INITIAL_SMOOTH_REVEAL_THRESHOLD) {
    return targetLength;
  }
  return 0;
}

/**
 * Smoothly reveal incoming streaming text on display refresh frames while
 * preserving exact throughput: completion (`streaming === false`) or history
 * restore immediately reveals the full text with zero lag.
 */
export function useSmoothStreamingText(
  targetText: string,
  streaming: boolean,
  messageKey: string,
): string {
  const canAnimate = typeof window !== 'undefined'
    && typeof requestAnimationFrame === 'function'
    && !prefersReducedMotion();

  const [state, setState] = useState<{ key: string; revealedCount: number }>(() => ({
    key: messageKey,
    revealedCount: resolveInitialCount(canAnimate, streaming, targetText.length),
  }));

  const carryRef = useRef(0);
  const revealedRef = useRef(state.revealedCount);
  const targetRef = useRef(targetText);
  const lastTextRef = useRef(targetText);
  const rafIdRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number | null>(null);

  targetRef.current = targetText;

  let effectiveCount = state.revealedCount;
  if (state.key !== messageKey) {
    effectiveCount = resolveInitialCount(canAnimate, streaming, targetText.length);
  } else if (!canAnimate || !streaming) {
    effectiveCount = targetText.length;
  } else if (targetText.length < effectiveCount) {
    effectiveCount = targetText.length;
  } else if (
    effectiveCount > 0
    && lastTextRef.current !== targetText
    && !targetText.startsWith(lastTextRef.current.slice(0, effectiveCount))
  ) {
    effectiveCount = targetText.length;
  }

  revealedRef.current = effectiveCount;

  useEffect(() => {
    lastTextRef.current = targetText;
    if (state.key !== messageKey || state.revealedCount !== effectiveCount) {
      carryRef.current = 0;
      setState({ key: messageKey, revealedCount: effectiveCount });
    }
  }, [messageKey, targetText, effectiveCount, state.key, state.revealedCount]);

  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      lastTimeRef.current = null;
      carryRef.current = 0;
    };
  }, [canAnimate, streaming, messageKey]);

  useEffect(() => {
    if (!canAnimate || !streaming) return;
    if (revealedRef.current >= targetRef.current.length) return;
    if (rafIdRef.current !== null) return;

    const tick = (now: number) => {
      const dt = lastTimeRef.current === null ? 16 : Math.max(0, now - lastTimeRef.current);
      lastTimeRef.current = now;
      const currentTarget = targetRef.current;
      const step = stepSmoothReveal({
        revealedCount: revealedRef.current,
        targetText: currentTarget,
        dtMs: dt,
        carry: carryRef.current,
      });
      carryRef.current = step.carry;
      if (step.revealedCount !== revealedRef.current) {
        revealedRef.current = step.revealedCount;
        setState({ key: messageKey, revealedCount: step.revealedCount });
      }
      if (step.revealedCount < currentTarget.length) {
        rafIdRef.current = requestAnimationFrame(tick);
      } else {
        rafIdRef.current = null;
        lastTimeRef.current = null;
        carryRef.current = 0;
      }
    };

    lastTimeRef.current = null;
    rafIdRef.current = requestAnimationFrame(tick);
  }, [canAnimate, streaming, messageKey, targetText]);

  if (!canAnimate || !streaming || effectiveCount >= targetText.length) {
    return targetText;
  }
  return targetText.slice(0, effectiveCount);
}
