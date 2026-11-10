/**
 * Voice copy mapping (voice P1) — maps a machine error code to its i18n key.
 *
 * Lives in its own module so both the button/banner (tap mode) and the hold
 * overlay (hold mode) can use it without importing each other.
 */

import { errorClassToCopyCode, type VoiceServerErrorClass } from './protocol';
import type { VoiceClientErrorCode } from './voiceButtonState';

export function voiceErrorCopyKey(code: VoiceClientErrorCode): string {
  if (code.startsWith('server:')) {
    const errorClass = code.slice('server:'.length) as VoiceServerErrorClass;
    return `mobile.chat.voice.errorServer.${errorClassToCopyCode(errorClass)}`;
  }
  return `mobile.chat.voice.error.${code}`;
}
