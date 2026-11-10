/**
 * VoiceOverlay — the hold-to-talk surface (voice P1).
 *
 * Rises from the bottom over the composer while the user holds the mic
 * button. Four variants, each with a stable data-testid:
 *   voice-overlay-recording   live transcript + PCM-driven level bars + timer
 *   voice-overlay-recognizing release happened, waiting for `asr.done`
 *   voice-overlay-cancel      finger crossed the swipe-up threshold
 *   voice-overlay-error       failure card with an explicit salvage action
 *
 * Visual quality notes:
 *  - The level bars read `levelRef` (PCM frame RMS from capture.ts) inside a
 *    requestAnimationFrame loop; only this small component re-renders. Bars
 *    are deterministic weights times the live level — never random.
 *  - The panel uses a CSS rise-in keyframe. `prefers-reduced-motion` is
 *    honored twice: the app-wide media query kills the animation, and the
 *    pulse/spin classes carry `motion-reduce:animate-none`.
 *  - The error card must always offer a way back: if any text was recognized,
 *    "put into input box" hands it to the composer. Words are never dropped.
 */

import { ExclamationTriangleIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { useEffect, useState } from 'react';
import type { MutableRefObject } from 'react';
import { t } from '../../i18n';
import { voiceErrorCopyKey } from './voiceCopy';
import { voiceOverlayVariant, type VoiceUiState } from './voiceButtonState';

const BAR_COUNT = 9;
/** Fixed silhouette so the bars look like a voice print, not noise. */
const BAR_WEIGHTS = [0.45, 0.7, 0.95, 0.8, 0.55, 0.85, 1, 0.65, 0.4];
const BAR_MIN_HEIGHT = 0.08;

/** Deterministic bar heights (0..1) for a live level (0..1). */
export function levelBarHeights(level: number, count = BAR_COUNT): number[] {
  const clamped = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  const heights: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const weight = BAR_WEIGHTS[i % BAR_WEIGHTS.length]!;
    heights.push(Math.min(1, BAR_MIN_HEIGHT + clamped * weight * 0.92));
  }
  return heights;
}

export function formatElapsed(sec: number): string {
  const safe = Math.max(0, Math.floor(sec));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

export interface VoiceOverlayProps {
  state: VoiceUiState;
  elapsedSec: number;
  /** Live transcript (partials + settled finals). */
  text: string;
  levelRef: MutableRefObject<number>;
  /** Finger crossed the swipe-up threshold while still pressed. */
  cancelArmed: boolean;
  /** Keyboard inset (px) so the sheet sits above the on-screen keyboard. */
  bottomInset?: number;
  /** Error recovery: move the recognized text into the composer. */
  onSalvage: () => void;
  onDismissError: () => void;
}

export function VoiceOverlay({
  state,
  elapsedSec,
  text,
  levelRef,
  cancelArmed,
  bottomInset = 0,
  onSalvage,
  onDismissError,
}: VoiceOverlayProps): JSX.Element | null {
  const variant = voiceOverlayVariant(state, cancelArmed);
  const [bars, setBars] = useState<number[]>(() => levelBarHeights(0));
  const active = variant === 'recording';

  useEffect(() => {
    if (!active || typeof requestAnimationFrame !== 'function') return undefined;
    let frame = 0;
    let lastPaint = 0;
    const tick = (timestamp: number): void => {
      frame = requestAnimationFrame(tick);
      // ~20 fps is enough for a level meter and keeps re-renders cheap.
      if (timestamp - lastPaint < 50) return;
      lastPaint = timestamp;
      setBars(levelBarHeights(levelRef.current));
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, levelRef]);

  if (!variant) return null;

  const hasText = text.trim().length > 0;
  // Only the recording state owns a "speak now" placeholder; a recognizing
  // card with no text must not claim the mic is still listening.
  const displayText = hasText
    ? text
    : variant === 'recording'
      ? t('mobile.chat.voice.listeningPlaceholder')
      : '';

  return (
    <div
      data-testid={`voice-overlay-${variant}`}
      data-state={variant}
      style={{ bottom: `${Math.max(0, bottomInset)}px` }}
      className={`twin-voice-overlay fixed inset-x-0 bottom-0 z-50 px-3 pb-[max(env(safe-area-inset-bottom),12px)] ${
        variant === 'cancel' ? 'twin-voice-overlay-cancel' : ''
      }`}
    >
      <div className="twin-voice-overlay-panel motion-reduce:animate-none" data-testid="voice-overlay-panel">
        {variant === 'error' ? (
          <div className="flex items-start gap-3" role="alert" data-testid="voice-overlay-error-card">
            <ExclamationTriangleIcon className="mt-0.5 h-5 w-5 shrink-0 text-[var(--twin-warning)]" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-[var(--twin-text-primary)]" data-testid="voice-overlay-error-text">
                {state.errorCode ? t(voiceErrorCopyKey(state.errorCode)) : t('mobile.chat.voice.errorServer.generic')}
              </p>
              {hasText ? (
                <p className="mt-1 line-clamp-2 text-sm text-[var(--twin-text-secondary)]" data-testid="voice-overlay-error-preview">
                  {text}
                </p>
              ) : null}
              <div className="mt-3 flex items-center gap-2">
                {hasText ? (
                  <button
                    type="button"
                    onClick={onSalvage}
                    data-testid="voice-overlay-salvage"
                    className="twin-button twin-button-primary min-h-[40px] flex-1 text-sm"
                  >
                    {t('mobile.chat.voice.putIntoDraft')}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={onDismissError}
                  aria-label={t('mobile.chat.voice.errorDismiss')}
                  data-testid="voice-overlay-error-dismiss"
                  className="twin-icon-button"
                >
                  <XMarkIcon className="h-5 w-5" aria-hidden />
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span
                  className={`twin-voice-live-dot ${
                    variant === 'recording' ? 'animate-pulse motion-reduce:animate-none' : ''
                  }`}
                  aria-hidden
                />
                <span
                  role="status"
                  aria-live="polite"
                  className="text-xs font-medium text-[var(--twin-text-secondary)]"
                >
                  {variant === 'recording'
                    ? t('mobile.chat.voice.listening')
                    : variant === 'cancel'
                      ? t('mobile.chat.voice.releaseToCancel')
                      : t('mobile.chat.voice.recognizing')}
                </span>
              </div>
              <span className="twin-voice-timer tabular-nums" data-testid="voice-overlay-timer">
                {formatElapsed(elapsedSec)}
              </span>
            </div>

            <p
              data-testid="voice-overlay-text"
              className={`min-h-[2.75rem] line-clamp-3 text-xl font-medium leading-snug ${
                hasText ? 'text-[var(--twin-text-primary)]' : 'text-[var(--twin-text-tertiary)]'
              }`}
            >
              {variant === 'cancel' ? t('mobile.chat.voice.cancelHint') : displayText}
            </p>

            {variant === 'recording' ? (
              <div
                className="flex h-8 items-end justify-center gap-1.5"
                data-testid="voice-overlay-level"
                aria-hidden
              >
                {bars.map((height, index) => (
                  <span
                    key={index}
                    data-testid="voice-level-bar"
                    className="twin-voice-bar w-1.5 rounded-full"
                    style={{ height: `${Math.round(height * 100)}%` }}
                  />
                ))}
              </div>
            ) : null}

            <div className="flex items-center justify-center gap-4 text-xs text-[var(--twin-text-secondary)]">
              {variant === 'recording' ? (
                <>
                  <span>{t('mobile.chat.voice.holdReleaseToSend')}</span>
                  <span className="text-[var(--twin-border-strong)]" aria-hidden>
                    ·
                  </span>
                  <span>{t('mobile.chat.voice.holdSwipeToCancel')}</span>
                </>
              ) : variant === 'cancel' ? (
                <span data-testid="voice-overlay-cancel-hint">{t('mobile.chat.voice.cancelSwipeHint')}</span>
              ) : (
                <span>{t('mobile.chat.voice.recognizingHint')}</span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
