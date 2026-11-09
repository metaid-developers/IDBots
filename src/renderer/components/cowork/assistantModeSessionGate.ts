import type { ChatExperienceMode } from '../../config';
import type { CoworkSessionAutoOrigin, CoworkSessionType } from '../../types/cowork';

/**
 * The session fields this gate reads. Structural so it accepts both the full
 * CoworkSession (session detail) and the CoworkSessionSummary (list rows).
 */
export interface AssistantModeSessionIdentity {
  sessionType?: CoworkSessionType | null;
  autoOrigin?: CoworkSessionAutoOrigin | null;
  /** Bot Internet projector marker (owner ruling 2026-11-07). */
  assistantMode?: boolean;
}

/**
 * Renderer mirror of the backend assistant-mode gate.
 *
 * The `mode` argument is the FACE-derived chat experience mode
 * (hooks/chatExperienceModeSource.ts, 总裁办公室裁定 2026-11-09): BotHub
 * face ('browser' surface) -> 'assistant', BotWorks face ('home' surface) ->
 * 'professional'. The retired Settings toggle feeds nothing any more.
 *
 * Backend counterpart: `isAssistantModeOwnerChatSession(sessionId)` in
 * `src/main/libs/coworkRunner.ts` — marker-only since the same ruling: the
 * per-session assistantMode marker (BotHub layer, owner ruling 2026-11-07)
 * with no autoOrigin is assistant; everything else — every BotWorks owner
 * chat, twin included — runs the professional prompt, owner_update surface,
 * and professional effort chain.
 *
 * The two implementations MUST NOT drift on the SESSION axis: the backend
 * gates the assistant prompt section, owner_update surface, and assistant
 * effort rung on the marker rule, so a renderer that misdetects a marker
 * session recreates the defect this mirror fixes — a transcript that "looks
 * assistant" while its turns run professional (or vice versa). Change this
 * function and the backend one in the same breath.
 *
 * Known divergence (the ruling's intent, not a defect): the renderer verdict
 * is face-owned PRESENTATION while the backend verdict is session-owned
 * EXECUTION. On the BotHub face this gate reports assistant chrome for
 * anything listed there — including a BotWorks-created standard chat, whose
 * turns run the professional prompt — because the ruling makes the face the
 * mode's source of truth (BotHub 面=助手模式). On the BotWorks face the same
 * chat renders professional. Do not "fix" this by keying the renderer on
 * session shape again: the face decides, and a renderer-side
 * conversation-source probe (the old sourceChannel divergence) has no
 * renderer-visible payload.
 */
export function isAssistantModeOwnerChatSession(
  mode: ChatExperienceMode,
  session: AssistantModeSessionIdentity | null | undefined,
): boolean {
  if (!session) return false;
  // Bot Internet projector sessions carry a persisted per-session marker and
  // run assistant mode on every face — mirror of the backend branch in
  // coworkRunner.isAssistantModeOwnerChatSession (marker-only, 2026-11-09).
  if (session.assistantMode && !session.autoOrigin) return true;
  // Face-owned presentation: the BotWorks face ('professional') renders every
  // session shape professionally; the BotHub face ('assistant') renders the
  // assistant presentation for what it lists.
  if (mode !== 'assistant') return false;
  if ((session.sessionType ?? 'standard') !== 'standard' || session.autoOrigin) return false;
  return true;
}

/**
 * Bot Internet projector sessions: browser-type sessions carrying the
 * per-session assistantMode marker. In this surface metaapp/HTML is never
 * embedded inline in bubbles (owner ruling #7, 2026-11-07) — everything
 * guides to the right-side projector pane.
 */
export function isProjectorModeSession(
  session: AssistantModeSessionIdentity | null | undefined,
): boolean {
  return !!session?.assistantMode && (session.sessionType ?? 'standard') === 'browser';
}
