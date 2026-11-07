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
 * Backend counterpart: `isAssistantModeOwnerChatSession(sessionId)` in
 * `src/main/libs/coworkRunner.ts` — the global mode must be 'assistant' AND
 * the session must be a regular interactive owner chat: standard type,
 * human-initiated (no autoOrigin), created from the cowork UI. Group tasks,
 * A2A/IM conversations, Bot Browser pages, long-term sessions, and
 * auto-created orchestration/schedule runs serve other audiences or run
 * unattended, so they keep the professional treatment there.
 *
 * The two implementations MUST NOT drift: the backend gates the assistant
 * prompt section, owner_update surface, and assistant effort rung on this
 * exact rule, so a renderer that decides differently recreates the defect
 * this mirror fixes — a transcript that "looks assistant" (thinking/tool
 * chrome hidden) while its turns actually run the professional prompt (or
 * vice versa). Change this function and the backend one in the same breath.
 *
 * Known divergence: the backend additionally requires the session's
 * conversation source channel to be 'cowork_ui'
 * (getConversationSourceContextBySession). The renderer session payload
 * carries no source channel, so this mirror decides on the two available
 * signals ONLY. A standard, human-initiated session whose backend channel is
 * not cowork_ui (e.g. an IM-bridged conversation) renders assistant-side
 * while its backend turns stay professional. Do not pretend the two rules are
 * equivalent — widen this only together with a renderer-visible channel.
 */
export function isAssistantModeOwnerChatSession(
  mode: ChatExperienceMode,
  session: AssistantModeSessionIdentity | null | undefined,
): boolean {
  if (!session) return false;
  // Bot Internet projector sessions carry a persisted per-session marker and
  // run assistant mode regardless of the global chatExperienceMode — mirror
  // of the backend branch in coworkRunner.isAssistantModeOwnerChatSession.
  if (session.assistantMode && !session.autoOrigin) return true;
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
