import React, { useEffect, useMemo, useState } from 'react';
import { i18nService } from '../../services/i18n';
import type { CoworkMessage } from '../../types/cowork';
import { getDefaultMetabotAvatarUrl } from '../../utils/rendererAssetPaths';
import { isRenderableAvatarSource } from '../../utils/avatarSource';
import { splitThinkTaggedContent } from './ThinkingBlock';
import { drawTurnAckPhrase, findTailTurnAck } from './turnAckPhrases';

const DEFAULT_BOT_AVATAR = getDefaultMetabotAvatarUrl();

const IDLE_PHRASE_KEYS = [
  'assistantStatusIdleThinking',
  'assistantStatusIdleLookingUp',
  'assistantStatusIdleOrganizing',
  'assistantStatusIdleAlmostThere',
  'assistantStatusIdleMoment',
  'assistantStatusIdleLeads',
  'assistantStatusIdleSorting',
] as const;

const IDLE_PHRASE_INTERVAL_MS = 3000;

/**
 * Assistant-mode replacement for StreamingActivityBar: the session bot's
 * avatar with a soft breathing ring plus a friendly status line. Status
 * wording stays non-technical (no tool names, no retry counters) — real
 * runtime signals (api_retry / requesting / unpaired tool_use) still take
 * precedence over the rotating idle phrases, mirroring the professional bar's
 * precedence so the text never contradicts the actual state.
 *
 * Turn acknowledgment: a `sdkRuntimeStatus: 'turnAck'` signal in the tail
 * run (emitted by the main process before the brain call, tier derived from
 * the #11 effort verdict) replaces the generic wait copy with a tier phrase
 * — "on it right away" / "needs a moment" / "complex, may take a few
 * minutes" — drawn from a per-session shuffle bag so consecutive turns never
 * repeat the same line. The draw is memoized per ack message id, so React
 * re-renders never re-roll the wording mid-turn.
 *
 * Single placement: `inline` inside the transcript at the reply position,
 * where it is assistant mode's only activity indicator. It stays visible
 * through the ENTIRE running state — pre-first-token wait, narration and
 * reply streaming, tool runs, hidden thinking — and only its status line
 * differentiates the phases; stepping aside while text streamed left
 * multi-minute tool windows looking idle. Professional mode keeps the
 * above-composer StreamingActivityBar.
 */
export const AssistantActivityIndicator: React.FC<{
  messages: CoworkMessage[];
  avatar?: string | null;
  fallbackText?: string;
  /** Drop the page-level gutter/max-width wrapper for inline transcript use. */
  inline?: boolean;
  /** Shuffle-bag scope: phrases rotate without repeats per session. */
  sessionId?: string | null;
}> = ({ messages, avatar, fallbackText, inline = false, sessionId = null }) => {
  const [idlePhraseIndex, setIdlePhraseIndex] = useState(0);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setIdlePhraseIndex((index) => (index + 1) % IDLE_PHRASE_KEYS.length);
    }, IDLE_PHRASE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);

  // Turn-ack scan over the CONTIGUOUS tail run of runtime-status messages:
  // once real content streams, the run ends and the ack stops applying.
  const tailTurnAck = useMemo(() => findTailTurnAck(messages), [messages]);

  const ackPhrase = useMemo(
    () => tailTurnAck
      ? drawTurnAckPhrase({
          sessionId,
          tier: tailTurnAck.tier,
          language: i18nService.getLanguage(),
          ackMessageId: tailTurnAck.messageId,
        })
      : null,
    // Draw once per ack message; language flips only re-draw for NEW acks
    // (remembered phrases stay in their drawn language), the right trade.
    [tailTurnAck?.messageId, tailTurnAck?.tier, sessionId],
  );

  const getStatusText = (): string => {
    let activityKey: 'assistantStatusSearchingLocal' | 'assistantStatusVerifyingDelivery' | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const activity = messages[i].metadata?.turnAckActivity;
      if (activity === 'search_local') {
        activityKey = 'assistantStatusSearchingLocal';
        break;
      }
      if (activity === 'verify_delivery') {
        activityKey = 'assistantStatusVerifyingDelivery';
        break;
      }
      if (activity === 'working') break;
    }

    let sawRequesting = false;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const status = msg.metadata?.sdkRuntimeStatus;
      if (typeof status !== 'string') break;
      if (status === 'api_retry') {
        return i18nService.t('assistantStatusRetrying');
      }
      if (status === 'requesting') {
        sawRequesting = true;
      }
    }
    if (activityKey && (tailTurnAck || sawRequesting)) {
      return i18nService.t(activityKey);
    }
    if (ackPhrase && tailTurnAck) {
      return ackPhrase;
    }
    if (sawRequesting) {
      return i18nService.t('assistantStatusThinking');
    }

    // Visible reply text actively streaming (narration or the final answer):
    // the newest streaming non-thinking assistant message is the live one. A
    // stream carrying only think-tag content so far renders nothing in
    // assistant mode, so that still reads as "thinking".
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.type !== 'assistant' || !msg.metadata?.isStreaming || msg.metadata?.isThinking) {
        continue;
      }
      const content = typeof msg.content === 'string' ? msg.content : '';
      const split = splitThinkTaggedContent(content);
      const visibleText = split.thinking ? split.text : content;
      return i18nService.t(visibleText.trim() ? 'assistantStatusWriting' : 'assistantStatusThinking');
    }

    const toolResultIds = new Set<string>();
    for (const msg of messages) {
      const id = msg.metadata?.toolUseId;
      if (typeof id === 'string' && msg.type === 'tool_result') {
        toolResultIds.add(id);
      }
    }
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.type === 'tool_use') {
        const id = msg.metadata?.toolUseId;
        if (typeof id === 'string' && !toolResultIds.has(id)) {
          return activityKey
            ? i18nService.t(activityKey)
            : i18nService.t('assistantStatusWorking');
        }
      }
    }
    return activityKey
      ? i18nService.t(activityKey)
      : fallbackText || i18nService.t(IDLE_PHRASE_KEYS[idlePhraseIndex]);
  };

  const avatarSrc = isRenderableAvatarSource(avatar) ? avatar! : DEFAULT_BOT_AVATAR;

  const row = (
    // pt-2 keeps the ring's breathing room below the bubble above it; the
    // bottom edge is slimmer (pb-1) because inline placement is always the
    // transcript's last row and the composer should sit close under it.
    <div className="flex items-center gap-2.5 pt-2 pb-1">
      <div className="assistant-activity-avatar-ring relative h-8 w-8 shrink-0">
        <img
          src={avatarSrc}
          alt=""
          className="h-8 w-8 rounded-full object-cover border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface"
          onError={(e) => { (e.currentTarget as HTMLImageElement).src = DEFAULT_BOT_AVATAR; }}
        />
      </div>
      {/* The status line gets a calm light-sweep shimmer (CSS class in
          index.css, gated on prefers-reduced-motion: no-preference); the
          glyphs themselves never move. */}
      <span className="assistant-status-shimmer min-w-0 truncate text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
        {getStatusText()}
      </span>
    </div>
  );

  if (inline) {
    return row;
  }

  return (
    <div className="shrink-0 animate-fade-in px-4">
      <div className="max-w-[clamp(680px,64%,920px)] mx-auto">
        {row}
      </div>
    </div>
  );
};
