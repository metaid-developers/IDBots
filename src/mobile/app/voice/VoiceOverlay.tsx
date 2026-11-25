/**
 * VoiceOverlay — the hold-to-talk surface (voice P1).
 *
 * Rises from the bottom over the composer while the user holds either voice
 * press surface. Five variants, each with a stable data-testid:
 *   voice-overlay-preparing   mic/ASR warming up; tells user to wait for vibration
 *   voice-overlay-recording   ready to speak; live transcript + undulating voice wave
 *   voice-overlay-recognizing release happened, waiting for `asr.done`
 *   voice-overlay-cancel      finger crossed the swipe-up threshold
 *   voice-overlay-error       failure card with an explicit salvage action
 *
 * Visual & tactile quality notes:
 *  - Preparing -> Recording transitions only once BOTH microphone capture and
 *    `asr.open` are live, synchronized with the phone's ready vibration.
 *  - The level bars read `levelRef` (PCM frame RMS from capture.ts) inside a
 *    ~30 fps requestAnimationFrame loop with fast attack / smooth release and
 *    deterministic travelling wave harmonics modulated strictly by real speech
 *    energy — silent input stays calm and never fakes speech.
 *  - `prefers-reduced-motion` is honored in both CSS and JS (freezes phase).
 *  - The error card always offers a way back: if any text was recognized,
 *    "put into input box" hands it to the composer. Words are never dropped.
 */

import { ExclamationTriangleIcon, XMarkIcon } from '@heroicons/react/24/outline';
import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, MutableRefObject } from 'react';
import { t } from '../../i18n';
import { voiceErrorCopyKey } from './voiceCopy';
import { voiceOverlayVariant, type VoiceUiState } from './voiceButtonState';

export const BAR_COUNT = 15;
const PREP_BAR_COUNT = 9;
const BAR_MIN_HEIGHT = 0.14;

/**
 * Deterministic voiceprint bar heights (0..1) for a live level (0..1) and
 * travelling wave phase (radians).
 *
 * - At silence (`level <= 0.03`), bars rest quietly along a subtle center-weighted
 *   contour with zero travelling wave motion.
 * - When speech arrives, a bell-shaped voiceprint envelope is modulated by two
 *   counter-propagating harmonic waves so sustained syllables visibly undulate
 *   and ripple with the speaker's volume.
 */
export function levelBarHeights(
  level: number,
  phaseRad = 0,
  count = BAR_COUNT,
): number[] {
  const clamped = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  const phase = Number.isFinite(phaseRad) ? phaseRad : 0;
  const active = clamped <= 0.03 ? 0 : Math.pow((clamped - 0.03) / 0.97, 0.82);
  const heights: number[] = [];
  const half = count > 1 ? (count - 1) / 2 : 1;

  for (let i = 0; i < count; i += 1) {
    const u = count > 1 ? (i - half) / half : 0;
    const envelope = 0.38 + 0.62 * Math.cos(u * Math.PI * 0.46);
    const rest = BAR_MIN_HEIGHT + 0.04 * envelope;
    if (active === 0) {
      heights.push(rest);
      continue;
    }
    const primaryWave = Math.sin(phase - i * 0.68);
    const harmonicWave = Math.cos(phase * 1.6 + i * 1.05);
    const ripple = 0.72 + 0.18 * primaryWave + 0.1 * harmonicWave;
    const height = rest + active * envelope * ripple * (1 - rest);
    heights.push(Math.min(1, Math.max(BAR_MIN_HEIGHT, height)));
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
  /** True immediately on hold-bar pointerdown during the pre-capture gate. */
  pressingHold?: boolean;
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
  pressingHold = false,
  bottomInset = 0,
  onSalvage,
  onDismissError,
}: VoiceOverlayProps): JSX.Element | null {
  const variant = voiceOverlayVariant(state, cancelArmed, pressingHold);
  const [bars, setBars] = useState<number[]>(() => levelBarHeights(0));
  const [energy, setEnergy] = useState(0);
  const smoothedLevelRef = useRef(0);
  const phaseRef = useRef(0);
  const active = variant === 'recording';

  useEffect(() => {
    if (!active) {
      smoothedLevelRef.current = 0;
      phaseRef.current = 0;
      setEnergy(0);
      setBars(levelBarHeights(0));
      return undefined;
    }
    if (typeof requestAnimationFrame !== 'function') return undefined;

    const reducedMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let frame = 0;
    let lastPaint = 0;
    const tick = (timestamp: number): void => {
      frame = requestAnimationFrame(tick);
      // ~30 fps gives fluid wave undulation while keeping mobile CPU minimal.
      if (timestamp - lastPaint < 32) return;
      lastPaint = timestamp;

      const raw = Number.isFinite(levelRef.current)
        ? Math.min(1, Math.max(0, levelRef.current))
        : 0;
      const prev = smoothedLevelRef.current;
      // Asymmetric envelope: fast attack snaps to new syllables; smooth release
      // lets crests settle organically instead of chattering.
      const coeff = raw > prev ? 0.56 : 0.22;
      const next = prev + (raw - prev) * coeff;
      const settled = next < 0.01 ? 0 : next;
      smoothedLevelRef.current = settled;

      if (!reducedMotion && settled > 0.03) {
        phaseRef.current = (phaseRef.current + 0.14 + settled * 0.24) % (Math.PI * 20);
      }
      setEnergy(settled);
      setBars(levelBarHeights(settled, reducedMotion ? 0 : phaseRef.current));
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, levelRef]);

  if (!variant) return null;

  const hasText = text.trim().length > 0;
  // Preparing instructs the user to wait for the ready vibration; only the
  // recording state invites them to speak now.
  const displayText = hasText
    ? text
    : variant === 'preparing'
      ? t('mobile.chat.voice.preparingPlaceholder')
      : variant === 'recording'
        ? t('mobile.chat.voice.listeningPlaceholder')
        : '';

  const variantClass =
    variant === 'cancel'
      ? 'twin-voice-overlay-cancel'
      : variant === 'preparing'
        ? 'twin-voice-overlay-preparing'
        : variant === 'recording'
          ? 'twin-voice-overlay-recording'
          : '';

  return (
    <div
      data-testid={`voice-overlay-${variant}`}
      data-state={variant}
      style={{ bottom: `${Math.max(0, bottomInset)}px` }}
      className={`twin-voice-overlay fixed inset-x-0 bottom-0 z-50 px-3 pb-[max(env(safe-area-inset-bottom),12px)] ${variantClass}`}
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
                {variant === 'preparing' ? (
                  <span
                    className="twin-voice-prep-spinner motion-reduce:animate-none"
                    data-testid="voice-overlay-preparing-spinner"
                    aria-hidden
                  />
                ) : (
                  <span
                    className={`twin-voice-live-dot ${
                      variant === 'recording'
                        ? 'twin-voice-live-dot-ready animate-pulse motion-reduce:animate-none'
                        : variant === 'cancel'
                          ? 'twin-voice-live-dot-cancel'
                          : ''
                    }`}
                    style={
                      variant === 'recording'
                        ? ({ '--voice-energy': energy.toFixed(3) } as CSSProperties)
                        : undefined
                    }
                    aria-hidden
                  />
                )}
                <span
                  role="status"
                  aria-live="polite"
                  className={`text-xs font-semibold ${
                    variant === 'recording'
                      ? 'text-[var(--twin-success)]'
                      : variant === 'preparing'
                        ? 'text-[var(--twin-warning)]'
                        : 'text-[var(--twin-text-secondary)]'
                  }`}
                >
                  {variant === 'preparing'
                    ? t('mobile.chat.voice.preparing')
                    : variant === 'recording'
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
              className={`min-h-[2.75rem] line-clamp-3 leading-snug ${
                hasText && variant !== 'cancel'
                  ? 'text-xl font-medium text-[var(--twin-text-primary)]'
                  : variant === 'preparing'
                    ? 'text-base font-medium text-[var(--twin-text-secondary)]'
                    : 'text-xl font-medium text-[var(--twin-text-tertiary)]'
              }`}
            >
              {variant === 'cancel' ? t('mobile.chat.voice.cancelHint') : displayText}
            </p>

            {variant === 'preparing' ? (
              <div
                className="flex h-10 items-center justify-center gap-1.5"
                data-testid="voice-overlay-preparing-wave"
                aria-hidden
              >
                {Array.from({ length: PREP_BAR_COUNT }, (_, index) => (
                  <span
                    key={index}
                    className="twin-voice-bar-preparing w-1.5 rounded-full motion-reduce:animate-none"
                    style={{ animationDelay: `${index * 70}ms` }}
                  />
                ))}
              </div>
            ) : variant === 'recording' ? (
              <div
                className="twin-voice-wave-stage flex h-11 items-center justify-center gap-1.5"
                data-testid="voice-overlay-level"
                style={{ '--voice-energy': energy.toFixed(3) } as CSSProperties}
                aria-hidden
              >
                {bars.map((height, index) => (
                  <span
                    key={index}
                    data-testid="voice-level-bar"
                    className={`twin-voice-bar w-1.5 rounded-full ${
                      energy > 0.05 ? 'twin-voice-bar-active' : ''
                    }`}
                    style={{ height: `${Math.round(height * 100)}%` }}
                  />
                ))}
              </div>
            ) : null}

            <div className="flex items-center justify-center gap-4 text-xs text-[var(--twin-text-secondary)]">
              {variant === 'preparing' ? (
                <>
                  <span>{t('mobile.chat.voice.preparingKeepHolding')}</span>
                  <span className="text-[var(--twin-border-strong)]" aria-hidden>
                    ·
                  </span>
                  <span>{t('mobile.chat.voice.holdSwipeToCancel')}</span>
                </>
              ) : variant === 'recording' ? (
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
