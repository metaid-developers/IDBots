import React, { useEffect, useMemo, useRef, useState } from 'react';
import { i18nService } from '../../services/i18n';
import type { CoworkMessage } from '../../types/cowork';
import { getDefaultMetabotAvatarUrl } from '../../utils/rendererAssetPaths';
import { isRenderableAvatarSource } from '../../utils/avatarSource';
import { splitThinkTaggedContent } from './ThinkingBlock';
import { drawTurnAckPhrase, findTailTurnAck } from './turnAckPhrases';
import {
  ASSISTANT_IDLE_POOLS,
  ASSISTANT_THINKING_POOLS,
  ASSISTANT_WORK_POOLS,
  ASSISTANT_WRITING_POOLS,
  buildRetryStatusLine,
  describeToolUseStatus,
  drawAssistantStatusPhrase,
  formatWaitSuffix,
  type AssistantStatusLanguage,
} from './assistantStatusPhrases';

const DEFAULT_BOT_AVATAR = getDefaultMetabotAvatarUrl();

/** Idle rotation cadence — the fallback pool is the only rotating surface. */
const IDLE_ROTATE_INTERVAL_MS = 3000;

/** 1s tick drives the waiting-phase elapsed suffix ("· 已 45 秒"). */
const TICK_INTERVAL_MS = 1000;

/**
 * Assistant-mode replacement for StreamingActivityBar: the session bot's
 * avatar with a soft breathing ring plus a status line that tells the owner
 * WHAT is happening, not just that something is (owner ruling 2026-11-10,
 * session 42b6a16d follow-up: the old fixed keys + 3s blind rotation read as
 * "a few words circling", and a 7m45s provider retry storm read as silence).
 *
 * Status resolution, most specific wins:
 *   1. api_retry — with the real attempt/max counters the runtime payload
 *      already carries (lead-in phrase from a shuffle pool).
 *   2. Visible reply text streaming — writing pool.
 *   3. Pending tool_use — event-derived line from the tool's OWN object:
 *      "正在执行：pdftoppm -png …", "正在修改 bp-2026-11.html" (the tone
 *      stays conversational; the object is the information).
 *   4. turnGoal — the LLM-authored per-turn headline emitted by the main
 *      process pre-first-token, shown verbatim with an elapsed suffix.
 *   5. Heuristic activity keys (search_local / verify_delivery).
 *   6. Turn-ack tier phrase (existing shuffle bag).
 *   7. Thinking pool with elapsed suffix; idle pool rotates as the fallback.
 *
 * Phrase stability: every pool draw is keyed by (session, phase, instance id)
 * via drawAssistantStatusPhrase — a phase holds ONE phrase for its whole
 * lifetime (no re-roll per tick), and the elapsed suffix is the only part
 * that ticks.
 *
 * Single placement: `inline` inside the transcript at the reply position,
 * where it is assistant mode's only activity indicator. It stays visible
 * through the ENTIRE running state — pre-first-token wait, narration and
 * reply streaming, tool runs, hidden thinking — and only its status line
 * differentiates the phases. Professional mode keeps the above-composer
 * StreamingActivityBar.
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
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), TICK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);

  const language: AssistantStatusLanguage = i18nService.getLanguage() === 'zh' ? 'zh' : 'en';
  const scope = sessionId ?? 'global';

  // Turn-ack scan over the CONTIGUOUS tail run of runtime-status messages:
  // once real content streams, the run ends and the ack stops applying.
  const tailTurnAck = useMemo(() => findTailTurnAck(messages), [messages]);

  // One pass over the same contiguous tail run gathers every runtime-status
  // signal the precedence chain needs (goal headline, retry counters, the
  // plain 'requesting' marker).
  const tailSignals = useMemo(() => {
    const signals: {
      goalPhrase: string | null;
      goalMessageId: string | null;
      retryAttempt: number | null;
      retryMax: number | null;
      retryMessageId: string | null;
      sawRequesting: boolean;
    } = {
      goalPhrase: null,
      goalMessageId: null,
      retryAttempt: null,
      retryMax: null,
      retryMessageId: null,
      sawRequesting: false,
    };
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const status = msg.metadata?.sdkRuntimeStatus;
      if (typeof status !== 'string') break;
      if (status === 'turnGoal') {
        const phrase = msg.metadata?.turnGoalPhrase;
        if (!signals.goalPhrase && typeof phrase === 'string' && phrase.trim()) {
          signals.goalPhrase = phrase.trim();
          signals.goalMessageId = String(msg.id ?? '');
        }
      } else if (status === 'api_retry') {
        if (signals.retryMessageId === null) {
          signals.retryMessageId = String(msg.id ?? '');
          const attempt = msg.metadata?.retryAttempt;
          const max = msg.metadata?.retryMax;
          signals.retryAttempt = typeof attempt === 'number' ? attempt : null;
          signals.retryMax = typeof max === 'number' ? max : null;
        }
      } else if (status === 'requesting') {
        signals.sawRequesting = true;
      }
    }
    return signals;
  }, [messages]);

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

  // Heuristic activity keys (search_local / verify_delivery), same scan as
  // before — they predict from the prompt text and stay gated on the waiting
  // window (an ack in the tail run or the request in flight).
  const activityKey = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const activity = messages[i].metadata?.turnAckActivity;
      if (activity === 'search_local') return 'assistantStatusSearchingLocal';
      if (activity === 'verify_delivery') return 'assistantStatusVerifyingDelivery';
      if (activity === 'working') break;
    }
    return null;
  }, [messages]);

  // The newest streaming non-thinking assistant message is the live one. A
  // stream carrying only think-tag content so far renders nothing in
  // assistant mode, so that still reads as thinking.
  const streamingTextMessageId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.type !== 'assistant' || !msg.metadata?.isStreaming || msg.metadata?.isThinking) {
        continue;
      }
      const content = typeof msg.content === 'string' ? msg.content : '';
      const split = splitThinkTaggedContent(content);
      const visibleText = split.thinking ? split.text : content;
      if (visibleText.trim()) return String(msg.id ?? '');
    }
    return null;
  }, [messages]);

  // The newest UNANSWERED tool call, with the object fields the specific
  // status line needs.
  const pendingTool = useMemo(() => {
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
          return {
            id,
            toolName: typeof msg.metadata?.toolName === 'string' ? msg.metadata.toolName : '',
            toolInput: msg.metadata?.toolInput,
          };
        }
      }
    }
    return null;
  }, [messages]);

  // Phrase-instance clock: the elapsed suffix anchors to the phase INSTANCE
  // (its runtime-status message id when one exists), so a new turn's wait
  // restarts the counter while a long phase keeps it running.
  const phaseClock = useRef<{ key: string; startedAt: number }>({ key: '', startedAt: 0 });

  const getStatusText = (): string => {
    // 1. Retry — the counter is the whole point; the runtime payload already
    //    carries attempt/max, the old wording just hid them.
    if (tailSignals.retryMessageId !== null) {
      return buildRetryStatusLine({
        attempt: tailSignals.retryAttempt,
        max: tailSignals.retryMax,
        language,
        bagKey: `${scope}|${tailSignals.retryMessageId}`,
      });
    }
    // 2. Visible reply text streaming.
    if (streamingTextMessageId !== null) {
      return drawAssistantStatusPhrase({
        key: `writing:${scope}|${language}|${streamingTextMessageId}`,
        bagScope: `${scope}|${language}|writing`,
        pool: ASSISTANT_WRITING_POOLS[language],
        language,
      });
    }
    // 3. Pending tool — the event-derived specific line, generic pool only
    //    when the tool has nothing nameable to say.
    if (pendingTool !== null) {
      const specific = describeToolUseStatus(pendingTool.toolName, pendingTool.toolInput, language);
      if (specific) return specific;
      return drawAssistantStatusPhrase({
        key: `tool:${scope}|${language}|${pendingTool.id}`,
        bagScope: `${scope}|${language}|tool`,
        pool: ASSISTANT_WORK_POOLS[language],
        language,
      });
    }
    // 4. LLM turn-goal headline — specific beats every generic waiting
    //    phrase; shown with the elapsed suffix (the phase it exists for is
    //    exactly the silent pre-first-token wait).
    if (tailSignals.goalPhrase && tailSignals.goalMessageId !== null) {
      const key = `goal:${scope}|${tailSignals.goalMessageId}`;
      if (phaseClock.current.key !== key) {
        phaseClock.current = { key, startedAt: now };
      }
      const suffix = formatWaitSuffix(now - phaseClock.current.startedAt, language);
      return `${tailSignals.goalPhrase}${suffix}`;
    }
    // 5. Heuristic activity keys.
    if (activityKey && (tailTurnAck || tailSignals.sawRequesting)) {
      return i18nService.t(activityKey);
    }
    // 6. Turn-ack tier phrase.
    if (ackPhrase && tailTurnAck) {
      return ackPhrase;
    }
    // 7. Thinking pool + elapsed suffix.
    if (tailSignals.sawRequesting) {
      const key = `thinking:${scope}|${language}|${tailTurnAck?.messageId ?? tailSignals.goalMessageId ?? 'cont'}`;
      if (phaseClock.current.key !== key) {
        phaseClock.current = { key, startedAt: now };
      }
      const phrase = drawAssistantStatusPhrase({
        key,
        bagScope: `${scope}|${language}|thinking`,
        pool: ASSISTANT_THINKING_POOLS[language],
        language,
      });
      return `${phrase}${formatWaitSuffix(now - phaseClock.current.startedAt, language)}`;
    }
    // 8. Idle fallback — the only rotating surface (3s cadence, 10-phrase bag).
    const idlePool = ASSISTANT_IDLE_POOLS[language];
    const idleIndex = Math.floor(now / IDLE_ROTATE_INTERVAL_MS) % idlePool.length;
    return fallbackText || idlePool[idleIndex];
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
          glyphs themselves never move. 15px + primary-ish ink: the status is
          the only thing talking during a long bubble phase, so it reads as
          body text, not fine print. */}
      <span className="assistant-status-shimmer min-w-0 truncate text-[15px] dark:text-claude-darkText text-claude-text">
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
