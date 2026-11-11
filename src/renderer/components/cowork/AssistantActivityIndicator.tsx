import React, { useEffect, useMemo, useRef, useState } from 'react';
import { i18nService } from '../../services/i18n';
import type { CoworkMessage } from '../../types/cowork';
import { getDefaultMetabotAvatarUrl } from '../../utils/rendererAssetPaths';
import { isRenderableAvatarSource } from '../../utils/avatarSource';
import NftAvatarFrame from '../metabots/NftAvatarFrame';
import { parseNftAvatarReference } from '../metabots/nftAvatarPresentation.js';
import { splitThinkTaggedContent } from './ThinkingBlock';
import { drawTurnAckPhrase, findTailTurnAck } from './turnAckPhrases';
import {
  ASSISTANT_COORDINATE_POOLS,
  ASSISTANT_CONTINUE_POOLS,
  ASSISTANT_DIGEST_POOLS,
  ASSISTANT_PROJECTED_POOLS,
  ASSISTANT_RESUME_POOLS,
  ASSISTANT_THINKING_POOLS,
  ASSISTANT_WORK_POOLS,
  ASSISTANT_WRITING_POOLS,
  buildRetryStatusLine,
  describeToolUseStatus,
  drawAssistantStatusPhrase,
  formatWaitSuffix,
  isResumeSpliceContent,
  type AssistantStatusLanguage,
} from './assistantStatusPhrases';

const DEFAULT_BOT_AVATAR = getDefaultMetabotAvatarUrl();

/** 1s tick drives the waiting-phase elapsed suffix ("· 已 45 秒"). */
const TICK_INTERVAL_MS = 1000;

/** The projection tool whose landed result means the artifact is on screen. */
const PROJECT_TOOL = 'bot_browser_preview_local';

/** Subagent events that mean a delegation is LIVE right now. */
const LIVE_SUBAGENT_EVENTS = new Set(['task_started', 'task_progress', 'tool_progress']);

/**
 * Assistant-mode replacement for StreamingActivityBar: the session bot's
 * avatar with a soft breathing ring plus a status line that names the phase
 * the bot is actually IN. Revision 2 (owner ruling 2026-11-11, session
 * b817372f): the old fallback rotated idle/warm-up/completion phrases on a
 * 3s timer, so a 429-storm session (where every auto-resume splice breaks
 * the runtime-status tail run) showed "热身/蓄力/马上就好" looping like a
 * recording while the Studio right pane already displayed the projected
 * HTML. Rules now:
 *
 *   - NO timer rotation anywhere; every phrase is stable for its phase
 *     instance (only the waiting-phase elapsed suffix ticks).
 *   - Completion words exist ONLY in the writing pool (visible text actually
 *     streaming); no other state may promise or imply "almost done".
 *   - Phase precedence, most specific wins: retry counters → writing →
 *     pending tool (its own object) → live delegation (subagent events /
 *     worker tools) → projected artifact → turn-goal headline → heuristic
 *     activity → ack tier → resume-from-interruption → thinking → digesting
 *     (inter-step gap) → neutral continue fallback.
 *
 * Single placement: `inline` inside the transcript at the reply position,
 * where it is assistant mode's only activity indicator. Professional mode
 * keeps the above-composer StreamingActivityBar.
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

  // Live-delegation signal: the newest subagent event message decides whether
  // a delegation is running RIGHT NOW (task started/progress/tool progress)
  // or has settled (completed/notification/failure → not delegating).
  const delegating = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const payload = messages[i].metadata?.subagentEvent as
        | { event?: unknown; taskId?: unknown }
        | undefined;
      if (!payload || typeof payload !== 'object') continue;
      const event = typeof payload.event === 'string' ? payload.event : '';
      if (!event) continue;
      if (LIVE_SUBAGENT_EVENTS.has(event)) {
        return { active: true, taskId: typeof payload.taskId === 'string' ? payload.taskId : '' };
      }
      return { active: false, taskId: '' };
    }
    return { active: false, taskId: '' };
  }, [messages]);

  // Projection state: the newest ANSWERED bot_browser_preview_local call —
  // the artifact is on the big screen and the turn is still going. The
  // status must acknowledge what the owner can see.
  const projected = useMemo(() => {
    const toolResultIds = new Set<string>();
    for (const msg of messages) {
      const id = msg.metadata?.toolUseId;
      if (typeof id === 'string' && msg.type === 'tool_result') {
        toolResultIds.add(id);
      }
    }
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.type === 'tool_use'
        && msg.metadata?.toolName === PROJECT_TOOL) {
        const id = msg.metadata?.toolUseId;
        if (typeof id === 'string' && toolResultIds.has(id)) {
          return { messageId: id };
        }
      }
    }
    return null;
  }, [messages]);

  // Inter-step gap: the newest CONCRETE transcript message (skipping the
  // runtime-status system run) is a tool_result — its answer landed and no
  // pending tool, stream, or request has superseded it yet.
  const digesting = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.type === 'system') continue;
      return msg.type === 'tool_result';
    }
    return false;
  }, [messages]);

  // Resume-from-interruption: the newest user message is the runner's
  // auto-resume splice (provider-death turn) — say THAT, not generic words.
  const resuming = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.type === 'user') {
        const content = typeof msg.content === 'string' ? msg.content : '';
        return isResumeSpliceContent(content);
      }
      // A concrete bot action after the splice means it already resumed.
      if (msg.type === 'assistant' || msg.type === 'tool_use') return false;
    }
    return false;
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
    // 2. Visible reply text streaming — the ONLY phase allowed to speak of
    //    wrapping up (the words are literally on screen).
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
    // 4. Live delegation — subagent events say a worker is running NOW.
    if (delegating.active) {
      return drawAssistantStatusPhrase({
        key: `delegate:${scope}|${language}|${delegating.taskId}`,
        bagScope: `${scope}|${language}|delegate`,
        pool: ASSISTANT_COORDINATE_POOLS[language],
        language,
      });
    }
    // 5. LLM turn-goal headline — specific beats every generic waiting
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
    // 6. Projected artifact — the owner can SEE the deliverable; the status
    //    acknowledges it instead of rotating generic waiting words.
    if (projected !== null) {
      return drawAssistantStatusPhrase({
        key: `projected:${scope}|${language}|${projected.messageId}`,
        bagScope: `${scope}|${language}|projected`,
        pool: ASSISTANT_PROJECTED_POOLS[language],
        language,
      });
    }
    // 7. Heuristic activity keys.
    if (activityKey && (tailTurnAck || tailSignals.sawRequesting)) {
      return i18nService.t(activityKey);
    }
    // 8. Turn-ack tier phrase.
    if (ackPhrase && tailTurnAck) {
      return ackPhrase;
    }
    // 9. Resume-from-interruption — the turn is a provider-death recovery.
    if (resuming) {
      return drawAssistantStatusPhrase({
        key: `resume:${scope}|${language}|cont`,
        bagScope: `${scope}|${language}|resume`,
        pool: ASSISTANT_RESUME_POOLS[language],
        language,
      });
    }
    // 10. Thinking pool + elapsed suffix (request in flight).
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
    // 11. Inter-step gap — a tool result landed, nothing in flight yet.
    if (digesting) {
      return drawAssistantStatusPhrase({
        key: `digest:${scope}|${language}|cont`,
        bagScope: `${scope}|${language}|digest`,
        pool: ASSISTANT_DIGEST_POOLS[language],
        language,
      });
    }
    // 12. Cold-start fallback — neutral, stable, no theater.
    return fallbackText || drawAssistantStatusPhrase({
      key: `continue:${scope}|${language}`,
      bagScope: `${scope}|${language}|continue`,
      pool: ASSISTANT_CONTINUE_POOLS[language],
      language,
    });
  };

  const avatarSrc = parseNftAvatarReference(avatar)
    ? avatar
    : (isRenderableAvatarSource(avatar) ? avatar! : DEFAULT_BOT_AVATAR);

  const row = (
    // pt-2 keeps the ring's breathing room below the bubble above it; the
    // bottom edge is slimmer (pb-1) because inline placement is always the
    // transcript's last row and the composer should sit close under it.
    <div className="flex items-center gap-2.5 pt-2 pb-1">
      <div className="assistant-activity-avatar-ring relative h-8 w-8 shrink-0">
        <NftAvatarFrame
          avatar={avatarSrc}
          frameClassName="h-8 w-8 rounded-full"
          fallback={<img src={DEFAULT_BOT_AVATAR} alt="" className="h-8 w-8 rounded-full object-cover" />}
        />
      </div>
      {/* The status line gets a calm light-sweep shimmer (CSS class in
          index.css, gated on prefers-reduced-motion: no-preference); the
          glyphs themselves never move. Size back to text-sm per owner
          feedback 2026-11-11 — the 15px bump read as too loud. */}
      <span className="assistant-status-shimmer min-w-0 truncate text-sm dark:text-claude-darkText text-claude-text">
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
