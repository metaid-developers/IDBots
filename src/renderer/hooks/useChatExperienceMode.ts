import { useEffect, useState } from 'react';
import type { ChatExperienceMode } from '../config';
import {
  SURFACE_MODE_CHANGE_EVENT,
  chatExperienceModeForSurface,
  readActiveSurfaceMode,
} from './chatExperienceModeSource';

/**
 * Chat experience mode, decided by the FACE the user is on
 * (总裁办公室裁定 2026-11-09): the BotHub face ('browser' surface) runs
 * 'assistant' — assistant is embedded in the BotHub layer (its sessions carry
 * the per-session assistantMode marker); the BotWorks face ('home' surface)
 * runs 'professional' for every bot, twin included. The old Settings toggle
 * is retired — nothing reads the persisted chatExperienceMode any more; the
 * legacy app_config field survives only as an ignored compat value (see
 * AppConfig in config.ts).
 *
 * 'assistant' hides raw thinking and tool-call chrome (the model's narration
 * arrives as ordinary chat bubbles); 'professional' keeps the full transcript
 * chrome. Reactive within the window through the surface-mode change event
 * the shell dispatches on every face switch, and across windows through the
 * native `storage` event (same origin). One subscription per consumer — the
 * session list mounts it once and passes a plain boolean down to its
 * memoized rows. Face switches also remount the per-face trees (Sidebar /
 * HomeSidebar / CoworkView are conditionally rendered), so the subscription
 * is belt-and-braces for any consumer that outlives a switch.
 */
export function useChatExperienceMode(): ChatExperienceMode {
  const [chatExperienceMode, setChatExperienceMode] = useState<ChatExperienceMode>(
    () => chatExperienceModeForSurface(readActiveSurfaceMode()),
  );

  useEffect(() => {
    const reread = () => {
      setChatExperienceMode(chatExperienceModeForSurface(readActiveSurfaceMode()));
    };
    window.addEventListener(SURFACE_MODE_CHANGE_EVENT, reread);
    // Cross-window: another app window switching the face writes the same
    // localStorage slot, which fires the native storage event here.
    window.addEventListener('storage', reread);
    return () => {
      window.removeEventListener(SURFACE_MODE_CHANGE_EVENT, reread);
      window.removeEventListener('storage', reread);
    };
  }, []);

  return chatExperienceMode;
}
