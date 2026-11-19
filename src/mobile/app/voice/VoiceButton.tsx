/**
 * VoiceButton + VoiceErrorBanner + hold gesture host (voice P1).
 *
 * Interaction: HOLD TO TALK. Pointerdown arms a hold, and only a sustained
 * press starts the microphone; a short tap never requests mic permission.
 * Pointerup sends the transcript as a new message, swiping up arms cancel. The bottom
 * overlay (VoiceOverlay) rises over the composer while the finger is down.
 * In the icon variant a short press switches composer modes; in the wide
 * "hold to talk" variant it is only an accidental press. Keyboard and
 * screen-reader activation switches modes on the icon, or toggles recording
 * on the wide button as the accessibility fallback.
 *
 * iOS guard set (each one answers a concrete failure; see the inline notes):
 *  1. `touch-action: none` — without it iOS claims the gesture for scrolling
 *     and fires pointercancel/touchcancel mid-word.
 *  2. `-webkit-touch-callout: none` — without it a long press opens the iOS
 *     callout/context menu over the button.
 *  3. `user-select: none` — without it a long press starts text selection,
 *     which also steals the gesture.
 *  4. Pointer Events + `setPointerCapture` — the gesture keeps its target and
 *     keeps receiving pointermove/pointerup even when the finger leaves the
 *     button (needed for swipe-up cancel).
 * Belt and braces: while a hold is live we add non-passive `touchmove` and
 * `contextmenu` preventDefault listeners on the document, then remove them on
 * release, so the page underneath cannot scroll or pop a menu.
 *
 * Everything is presentational here except the gesture bookkeeping; the
 * voice session itself lives in useVoiceInput/VoiceSession.
 */

import {
  ExclamationTriangleIcon,
  MicrophoneIcon,
  StopIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, MutableRefObject, PointerEvent as ReactPointerEvent } from 'react';
import { t } from '../../i18n';
import {
  HOLD_START_DELAY_MS,
  holdCancelArmed,
  resolveHoldRelease,
  type HoldCancelReason,
} from './holdToSend';
import { VoiceOverlay, formatElapsed } from './VoiceOverlay';
import { voiceErrorCopyKey } from './voiceCopy';
import { voicePhaseTestid, type VoiceUiState } from './voiceButtonState';

export { voiceErrorCopyKey } from './voiceCopy';
export { formatElapsed } from './VoiceOverlay';

export interface VoiceButtonProps {
  state: VoiceUiState;
  elapsedSec: number;
  variant?: 'icon' | 'hold';
  /** Live transcript for the overlay. */
  recognizedText: string;
  /** 0..1 PCM level, polled by the overlay's rAF loop. */
  levelRef: MutableRefObject<number>;
  /** Keyboard inset (px) forwarded to the overlay. */
  bottomInset?: number;
  /** Wide-button keyboard / screen-reader recording toggle. */
  onStart: () => void;
  onStop: () => void;
  onStartHold: () => void;
  onEndHold: () => void;
  onCancelHold: () => void;
  /** Error card: move recognized text back into the composer. */
  onSalvage: () => void;
  onDismissError: () => void;
  /** Fired after a cancelled gesture so the screen can show a one-shot hint. */
  onHoldCancelled?: (reason: HoldCancelReason) => void;
  /** Icon variant: a short press switches between text and voice composer modes. */
  onToggleMode?: () => void;
}

interface HoldState {
  pointerId: number;
  startY: number;
  startedAt: number;
  armed: boolean;
  active: boolean;
  sessionStarted: boolean;
}

/** Non-passive guards live only for the duration of one hold. */
function preventGesture(event: Event): void {
  if (event.cancelable) event.preventDefault();
}

function setPageGestureLock(locked: boolean): void {
  if (typeof document === 'undefined') return;
  if (locked) {
    // `passive: false` is the point: a passive listener cannot cancel the
    // scroll that would abort the hold.
    document.addEventListener('touchmove', preventGesture, { passive: false });
    document.addEventListener('contextmenu', preventGesture);
    document.body.classList.add('twin-voice-holding');
  } else {
    document.removeEventListener('touchmove', preventGesture);
    document.removeEventListener('contextmenu', preventGesture);
    document.body.classList.remove('twin-voice-holding');
  }
}

const PRESS_STYLE: CSSProperties = {
  // The four iOS guards (see the file header for what each one prevents).
  touchAction: 'none',
  WebkitTouchCallout: 'none',
  WebkitUserSelect: 'none',
  userSelect: 'none',
};

export function VoiceButton({
  state,
  elapsedSec,
  variant = 'icon',
  recognizedText,
  levelRef,
  bottomInset = 0,
  onStart,
  onStop,
  onStartHold,
  onEndHold,
  onCancelHold,
  onSalvage,
  onDismissError,
  onHoldCancelled,
  onToggleMode,
}: VoiceButtonProps): JSX.Element {
  const [cancelArmed, setCancelArmed] = useState(false);
  const holdRef = useRef(null as HoldState | null);
  // Started holds and cancelled gestures suppress their synthesized click;
  // an unstarted icon tap uses that click to switch modes on the same target.
  const pointerHandledRef = useRef(false);
  // The synthesized click may never arrive (pointercancel, AT quirk); let the
  // suppression flag heal so keyboard activation is never swallowed for good.
  const pointerResetRef = useRef(null as ReturnType<typeof setTimeout> | null);
  const holdActivationRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const releaseGesture = useCallback(() => {
    if (holdActivationRef.current !== null) {
      clearTimeout(holdActivationRef.current);
      holdActivationRef.current = null;
    }
    holdRef.current = null;
    setCancelArmed(false);
    setPageGestureLock(false);
  }, []);

  // Never leave document-level listeners behind on unmount.
  useEffect(
    () => () => {
      setPageGestureLock(false);
      if (pointerResetRef.current !== null) clearTimeout(pointerResetRef.current);
      if (holdActivationRef.current !== null) clearTimeout(holdActivationRef.current);
    },
    [],
  );

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (state.phase !== 'idle' || holdRef.current?.active) return;
    if (event.button > 0) return; // secondary mouse buttons keep their meaning
    pointerHandledRef.current = true;
    try {
      // Guard 4: capture keeps pointermove/pointerup on this button even when
      // the finger travels off it (swipe-up cancel depends on it).
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Older WebKit may refuse capture; the gesture still works, just weaker.
    }
    holdRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startedAt: typeof performance !== 'undefined' ? performance.now() : Date.now(),
      armed: false,
      active: true,
      sessionStarted: false,
    };
    setCancelArmed(false);
    setPageGestureLock(true);
    const pointerId = event.pointerId;
    holdActivationRef.current = setTimeout(() => {
      const hold = holdRef.current;
      if (!hold?.active || hold.pointerId !== pointerId) return;
      hold.sessionStarted = true;
      onStartHold();
    }, HOLD_START_DELAY_MS);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const hold = holdRef.current;
    if (!hold?.active || hold.pointerId !== event.pointerId) return;
    const armed = holdCancelArmed({ startY: hold.startY, currentY: event.clientY, armed: hold.armed });
    if (armed !== hold.armed) {
      hold.armed = armed;
      setCancelArmed(armed);
    }
  };

  const finishGesture = (event: ReactPointerEvent<HTMLButtonElement>, interrupted: boolean): void => {
    const hold = holdRef.current;
    if (!hold?.active || hold.pointerId !== event.pointerId) return;
    hold.active = false;
    const sessionStarted = hold.sessionStarted;
    const heldMs =
      (typeof performance !== 'undefined' ? performance.now() : Date.now()) - hold.startedAt;
    const decision = resolveHoldRelease({
      heldMs,
      cancelArmed: hold.armed,
      interrupted,
    });
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // capture already gone
    }
    releaseGesture();
    if (pointerResetRef.current !== null) clearTimeout(pointerResetRef.current);
    pointerResetRef.current = setTimeout(() => {
      pointerHandledRef.current = false;
    }, 350);
    if (decision.action === 'send') {
      onEndHold();
      return;
    }
    // Switching an icon on pointerup would replace it with the keyboard button
    // before the browser dispatches click, handing that click to the new button.
    pointerHandledRef.current = variant !== 'icon' || decision.reason !== 'too_short' || sessionStarted;
    onCancelHold();
    onHoldCancelled?.(decision.reason);
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    finishGesture(event, false);
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    finishGesture(event, true);
  };

  const handleLostPointerCapture = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    // Fires after a normal release too; only an ACTIVE capture loss is an abort.
    const hold = holdRef.current;
    if (hold?.active && hold.pointerId === event.pointerId) {
      finishGesture(event, true);
    }
  };

  const handleClick = (): void => {
    // Unstarted icon taps intentionally reach this path; keyboard and
    // screen-reader activation use it too. Completed holds never toggle here.
    if (pointerHandledRef.current) {
      pointerHandledRef.current = false;
      return;
    }
    if (state.phase === 'error') return;
    if (variant === 'icon') {
      onToggleMode?.();
      return;
    }
    if (state.phase === 'recording') onStop();
    else if (state.phase === 'idle') onStart();
  };

  const recording = state.phase === 'recording';
  const inFlight = state.phase === 'requestingMic' || state.phase === 'connecting';
  const stopping = state.phase === 'stopping';
  const errored = state.phase === 'error';

  const label = errored
    ? t('mobile.chat.voice.errorDismiss')
    : recording
      ? t(variant === 'hold' ? 'mobile.chat.voice.holdReleaseToSend' : 'mobile.chat.voice.stop')
      : stopping && variant === 'hold'
        ? t('mobile.chat.voice.recognizing')
        : variant === 'hold'
          ? t('mobile.chat.voice.holdToTalk')
          : t('mobile.chat.voice.start');

  return (
    <>
      <button
        type="button"
        data-testid={variant === 'hold' ? 'voice-hold-button' : voicePhaseTestid(state)}
        data-variant={variant}
        aria-label={label}
        aria-pressed={recording}
        style={PRESS_STYLE}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onLostPointerCapture={handleLostPointerCapture}
        onClick={handleClick}
        className={`${variant === 'hold' ? 'twin-voice-hold-button' : 'twin-icon-button twin-composer-accessory'} relative shrink-0 select-none ${
          errored
            ? 'text-[var(--twin-warning)]'
            : recording
              ? 'twin-icon-button-danger animate-pulse motion-reduce:animate-none'
              : stopping
                ? 'bg-[var(--bg-hover)] text-[var(--text-secondary)]'
                : ''
        } ${inFlight ? 'opacity-70' : ''}`}
      >
        {variant === 'hold' ? (
          <span className="pointer-events-none">{label}</span>
        ) : recording ? <StopIcon className="h-5 w-5" aria-hidden /> : <MicrophoneIcon className="h-5 w-5" aria-hidden />}
        {variant === 'icon' && recording && elapsedSec > 0 ? (
          <span
            data-testid="voice-elapsed"
            className="absolute -top-2 left-1/2 -translate-x-1/2 rounded-full bg-red-500 px-1.5 text-[10px] font-medium leading-4 text-white"
          >
            {formatElapsed(elapsedSec)}
          </span>
        ) : null}
      </button>
      <VoiceOverlay
        state={state}
        elapsedSec={elapsedSec}
        text={recognizedText}
        levelRef={levelRef}
        cancelArmed={cancelArmed}
        bottomInset={bottomInset}
        onSalvage={onSalvage}
        onDismissError={onDismissError}
      />
    </>
  );
}

/**
 * Tap-mode error banner (voice P0). Hold sessions render their error as the
 * bottom overlay card instead, which carries the salvage action; showing both
 * would duplicate the same message and two competing dismiss buttons.
 */
export function VoiceErrorBanner({ state, onDismiss }: { state: VoiceUiState; onDismiss: () => void }): JSX.Element | null {
  if (state.mode !== 'tap' || state.phase !== 'error' || !state.errorCode) return null;
  return (
    <div
      role="alert"
      data-testid="voice-error"
      className="twin-notice twin-notice-warning mx-3 mb-2 flex items-center gap-2"
    >
      <ExclamationTriangleIcon className="h-4 w-4 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1 text-xs" data-testid="voice-error-text">
        {t(voiceErrorCopyKey(state.errorCode))}
      </p>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t('mobile.chat.voice.errorDismiss')}
        data-testid="voice-error-dismiss"
        className="twin-icon-button"
      >
        <XMarkIcon className="h-4 w-4" aria-hidden />
      </button>
    </div>
  );
}
