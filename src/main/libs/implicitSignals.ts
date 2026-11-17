import type { DreamDayActivity, DreamImplicitSignal, DreamImplicitSignalKind, DreamInputDropCounters } from '../dreamStore';

/**
 * Implicit activity signals (隐式信号) — the mechanical collection layer.
 *
 * Design rule (owner-approved 2026-09-17): this layer records only
 * STRUCTURAL FACTS — computable numbers like similarity scores, time gaps,
 * repeat counts. It never assigns sentiment and never pattern-matches
 * keywords ("太慢了" ≠ negative). What a fact MEANS is decided by the
 * dreaming bot, which sees the full conversation context; false alarms are
 * absorbed downstream by the counterfactual replay's margin gate.
 */

/** Two user messages closer than this (and similar enough) count as a re-ask. */
export const IMPLICIT_REASK_WINDOW_MS = 10 * 60 * 1000;
/** Character-bigram Jaccard threshold for "the user restated the same request". */
export const IMPLICIT_REASK_MIN_SIMILARITY = 0.55;
/** Long gap after an assistant turn before a terse follow-up in a persistent Studio session. */
export const STUDIO_LONG_WAIT_FOLLOWUP_MIN_MS = 20 * 60 * 1000;
const STUDIO_SHORT_FOLLOWUP_MAX_CHARS = 28;
const REASK_MIN_CONTENT_CHARS = 8;
const MAX_IMPLICIT_SIGNALS = 5;

export type { DreamImplicitSignal, DreamImplicitSignalKind } from '../dreamStore';

// Case-folded so Latin-script re-asks ("Video" vs "video") compare equal;
// no-op for Chinese and other case-less scripts. Detection stays purely
// structural — no language-specific rules anywhere in this layer.
const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim().toLowerCase();

/** Character-bigram Jaccard similarity; 0 for anything too short to compare. */
export function bigramSimilarity(a: string, b: string): number {
  const left = normalize(a);
  const right = normalize(b);
  if (left.length < 2 || right.length < 2) return 0;
  const bigrams = (text: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i < text.length - 1; i += 1) set.add(text.slice(i, i + 2));
    return set;
  };
  const aSet = bigrams(left);
  const bSet = bigrams(right);
  let intersection = 0;
  for (const gram of aSet) {
    if (bSet.has(gram)) intersection += 1;
  }
  return intersection / (aSet.size + bSet.size - intersection);
}

/**
 * Extract the day's structural implicit signals. Pure: same activity in, same
 * signals out. At most one re-ask per session (the strongest), and the whole
 * list is capped so busy days stay bounded. When `dropCounters` is given, the
 * signals sliced off by the cap are counted there (dream review P0 telemetry).
 */
export function extractImplicitSignals(
  activity: DreamDayActivity,
  dropCounters?: DreamInputDropCounters,
): DreamImplicitSignal[] {
  const signals: DreamImplicitSignal[] = [];

  for (const session of activity.sessions) {
    // Unattended background sessions ([督办], [长期], [定时]) carry machine-generated
    // prompts rather than a human conversing live — never derive human implicit
    // friction signals from them (prevents false prompt-layer rollbacks).
    if (session.autoOrigin) continue;

    // Re-ask: a user message that closely restates the previous user message
    // within the re-ask window. Synthetic briefing markers (isSystemBriefing)
    // are host triggers, not human turns, so skip them.
    let bestReask: { index: number; similarity: number; gapMin: number } | null = null;
    let prevUserIndex = -1;
    session.messages.forEach((message, index) => {
      if (message.type !== 'user' || message.isSystemBriefing) return;
      if (prevUserIndex >= 0) {
        const prev = session.messages[prevUserIndex];
        const gap = message.createdAt - prev.createdAt;
        if (gap >= 0 && gap <= IMPLICIT_REASK_WINDOW_MS
          && normalize(message.content).length >= REASK_MIN_CONTENT_CHARS
          && normalize(prev.content).length >= REASK_MIN_CONTENT_CHARS) {
          const similarity = bigramSimilarity(prev.content, message.content);
          if (similarity >= IMPLICIT_REASK_MIN_SIMILARITY
            && (bestReask == null || similarity > bestReask.similarity)) {
            bestReask = { index, similarity, gapMin: Math.round(gap / 60000) };
          }
        }
      }
      prevUserIndex = index;
    });
    if (bestReask != null) {
      const reask: { index: number; similarity: number; gapMin: number } = bestReask;
      signals.push({
        kind: 'reask',
        sessionId: session.sessionId,
        messageIndex: reask.index,
        text: `会话「${session.title}」:用户在 ${reask.gapMin} 分钟后重述了同一诉求(相似度 ${reask.similarity.toFixed(2)})`,
      });
    }

    // Unanswered burst: the session's tail is ≥2 consecutive genuine user messages.
    let tailUserCount = 0;
    for (let index = session.messages.length - 1; index >= 0; index -= 1) {
      const msg = session.messages[index];
      if (msg.isSystemBriefing) continue;
      if (msg.type === 'user') tailUserCount += 1;
      else break;
    }
    if (tailUserCount >= 2) {
      signals.push({
        kind: 'unanswered_burst',
        sessionId: session.sessionId,
        messageIndex: session.messages.length - 1,
        text: `会话「${session.title}」:会话末尾用户连发 ${tailUserCount} 条消息,之后没有我的回复`,
      });
    }

    // Studio long-wait terse follow-up: in a persistent Studio owner session,
    // an assistant reply was followed >= 20 min later by a short owner message
    // (<= 28 chars). Pure structural timing + length fact.
    if (session.isStudioOwner) {
      let bestLongWait: { index: number; gapMin: number; charLen: number } | null = null;
      for (let index = 1; index < session.messages.length; index += 1) {
        const msg = session.messages[index];
        if (msg.type !== 'user' || msg.isSystemBriefing) continue;
        const charLen = normalize(msg.content).length;
        if (charLen === 0 || charLen > STUDIO_SHORT_FOLLOWUP_MAX_CHARS) continue;
        let prevAssistantIdx = -1;
        for (let back = index - 1; back >= 0; back -= 1) {
          if (session.messages[back].isSystemBriefing) continue;
          if (session.messages[back].type === 'assistant') {
            prevAssistantIdx = back;
            break;
          }
          if (session.messages[back].type === 'user') break;
        }
        if (prevAssistantIdx < 0) continue;
        const gapMs = msg.createdAt - session.messages[prevAssistantIdx].createdAt;
        if (gapMs >= STUDIO_LONG_WAIT_FOLLOWUP_MIN_MS) {
          const gapMin = Math.round(gapMs / 60000);
          if (!bestLongWait || gapMin > bestLongWait.gapMin) {
            bestLongWait = { index, gapMin, charLen };
          }
        }
      }
      if (bestLongWait) {
        signals.push({
          kind: 'studio_long_wait_followup',
          sessionId: session.sessionId,
          messageIndex: bestLongWait.index,
          text: `Studio 会话「${session.title}」:上一条回复后间隔 ${bestLongWait.gapMin} 分钟,主人发来一条 ${bestLongWait.charLen} 字的简短跟进`,
        });
      }
    }
  }

  const primaryStudioSessionId = activity.sessions.find((s) => s.isStudioOwner)?.sessionId ?? null;
  for (const delegation of activity.studioDelegations ?? []) {
    if (delegation.attemptCount >= 2 || delegation.failedOrCancelledAttempts >= 1) {
      signals.push({
        kind: 'studio_multi_round_revision',
        sessionId: primaryStudioSessionId,
        text: `Studio 派工「${delegation.ownerIntent.slice(0, 48)}」:经历 ${delegation.attemptCount} 次执行尝试(完成 ${delegation.completedAttempts},失败/改派 ${delegation.failedOrCancelledAttempts})`,
      });
    }
  }

  for (const decision of activity.studioDecisions ?? []) {
    if (decision.status === 'deferred') {
      signals.push({
        kind: 'studio_superseded_briefing',
        sessionId: primaryStudioSessionId,
        text: `Studio 拍板项「${decision.title.slice(0, 48)}」(${decision.kind}):呈报后状态转为 deferred`,
      });
    }
  }

  // Repeat orders: the same peer opened ≥2 order sessions that day.
  const orderCountByPeer = new Map<string, number>();
  for (const session of activity.sessions) {
    if (!session.isOrder || !session.peerName) continue;
    orderCountByPeer.set(session.peerName, (orderCountByPeer.get(session.peerName) ?? 0) + 1);
  }
  for (const [peer, count] of orderCountByPeer) {
    if (count >= 2) {
      signals.push({
        kind: 'repeat_order',
        sessionId: null,
        text: `同一对象「${peer}」当天发起了 ${count} 笔服务订单`,
      });
    }
  }

  if (signals.length > MAX_IMPLICIT_SIGNALS && dropCounters) {
    dropCounters.implicitSignals += signals.length - MAX_IMPLICIT_SIGNALS;
  }
  return signals.slice(0, MAX_IMPLICIT_SIGNALS);
}
