/**
 * Voice tactile feedback helpers.
 *
 * Mainstream hold-to-talk UX relies on a crisp, unmistakable system vibration
 * at the exact instant BOTH microphone capture and ASR recognition are ready
 * ("speak now"), NOT on initial finger-down (which would trick users into
 * speaking before capture/ASR have started).
 *
 * Routes through MobileNativeAdapter first so iOS (UIImpactFeedbackGenerator,
 * since Safari/WKWebView lacks navigator.vibrate) and Android native shells
 * fire reliable hardware haptics even from async WebSocket `asr.open` events,
 * and degrades cleanly to Web Vibration API in mobile browsers.
 */

import { getNativeAdapter } from '../../native/nativeAdapter';
import type { MobileNativeHapticStyle } from '../../native/idbotsNative';

export interface VoiceHapticSink {
  triggerHaptic(style?: MobileNativeHapticStyle): void;
}

function resolveSink(sink?: VoiceHapticSink | null): VoiceHapticSink | null {
  if (sink) return sink;
  if (typeof window === 'undefined') return null;
  try {
    return getNativeAdapter();
  } catch {
    return null;
  }
}

/** Wakes the Taptic Engine on press-down without emitting a premature buzz. */
export function prepareVoiceHaptic(sink?: VoiceHapticSink | null): void {
  resolveSink(sink)?.triggerHaptic('prepare');
}

/** Fires the crisp "microphone + ASR ready — speak now" vibration. */
export function triggerVoiceReadyHaptic(sink?: VoiceHapticSink | null): void {
  resolveSink(sink)?.triggerHaptic('ready');
}

/** Subtle tick when the finger crosses the swipe-up cancel threshold. */
export function triggerVoiceCancelHaptic(sink?: VoiceHapticSink | null): void {
  resolveSink(sink)?.triggerHaptic('light');
}
