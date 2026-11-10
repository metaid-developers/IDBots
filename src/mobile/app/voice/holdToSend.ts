/**
 * Hold-to-send gesture decisions (voice P1) — pure helpers, no DOM.
 *
 * The pointer plumbing lives in VoiceButton; everything that can be decided
 * from numbers is decided here so the rules are unit-testable without a
 * browser:
 *  - a press shorter than HOLD_MIN_MS is an accidental tap, not a message;
 *    the same short press is also how keyboard/screen-reader users toggle
 *    recording (a11y fallback), so the SCREEN decides what a tap means.
 *  - dragging up past HOLD_CANCEL_DISTANCE arms "release to cancel".
 *    Re-arming on the way back down uses a smaller threshold (hysteresis) so
 *    the state does not flicker while the finger hovers near the line.
 */

export const HOLD_MIN_MS = 400;
export const HOLD_CANCEL_DISTANCE_PX = 80;
/** Re-arm band: travel must fall back below this before cancel disarms. */
export const HOLD_CANCEL_DISARM_PX = 56;

export interface HoldTravelInput {
  /** Pointer Y at press time (clientY). */
  startY: number;
  /** Current pointer Y (clientY; smaller = further up the screen). */
  currentY: number;
  /** Whether cancel was already armed (hysteresis input). */
  armed: boolean;
}

/** True when the finger has travelled far enough up to arm cancel. */
export function holdCancelArmed({ startY, currentY, armed }: HoldTravelInput): boolean {
  const travelUp = startY - currentY;
  return armed ? travelUp > HOLD_CANCEL_DISARM_PX : travelUp > HOLD_CANCEL_DISTANCE_PX;
}

export type HoldCancelReason = 'too_short' | 'swipe' | 'interrupted';

export type HoldReleaseDecision =
  | { action: 'send' }
  | { action: 'cancel'; reason: HoldCancelReason };

/**
 * What a pointerup means. `interrupted` covers lost pointer capture / the
 * browser stealing the gesture: discard rather than send a half utterance.
 */
export function resolveHoldRelease(input: {
  heldMs: number;
  cancelArmed: boolean;
  interrupted?: boolean;
}): HoldReleaseDecision {
  if (input.interrupted) return { action: 'cancel', reason: 'interrupted' };
  if (input.cancelArmed) return { action: 'cancel', reason: 'swipe' };
  if (!Number.isFinite(input.heldMs) || input.heldMs < HOLD_MIN_MS) {
    return { action: 'cancel', reason: 'too_short' };
  }
  return { action: 'send' };
}

/** Minimal chat surface the final-text hand-off needs (ChatScreen's chat). */
export interface VoiceSendTarget {
  send(text: string, attachments?: unknown[]): unknown;
  setDraft?(text: string): void;
  readonly draft?: string;
}

export type VoiceSendOutcome = 'sent' | 'empty' | 'kept_in_draft';

/**
 * Hands a finished transcript to the chat as a BRAND-NEW message.
 *
 * Contract (acceptance-critical):
 *  - `chat.send(finalText, [])` is called with the transcript and no
 *    attachments; the composer draft is neither read nor written.
 *  - Empty transcript = accidental press: no send, caller shows a hint.
 *  - `blocked` (the composer is busy: streaming / waiting permission):
 *    the words are never dropped — they are appended to the existing draft
 *    and the caller tells the user, so the next send still carries them.
 */
export function sendVoiceMessage(
  target: VoiceSendTarget,
  finalText: string,
  options: { blocked?: boolean } = {},
): VoiceSendOutcome {
  const text = finalText.trim();
  if (!text) return 'empty';
  if (options.blocked) {
    const draft = target.draft ?? '';
    const glue = draft && !/\s$/.test(draft) ? ' ' : '';
    target.setDraft?.(`${draft}${glue}${text}`);
    return 'kept_in_draft';
  }
  void target.send(text, []);
  return 'sent';
}
