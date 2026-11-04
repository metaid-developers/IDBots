/**
 * QQ group rate limiting — the guard in front of the model.
 *
 * The hole this file closes: group access is allowlisted (see `qqTrust.ts`),
 * but an ALLOWED member could still @ the bot a hundred times in a row and
 * every trigger burned a model turn. Authorization answers "may this group
 * talk to us"; it says nothing about "how often".
 *
 * Four rules, decided once at the message entry point:
 *
 *   1. per sender per group : 3 admitted messages / rolling 60 s
 *   2. per group             : 10 admitted messages / rolling 60 s
 *   3. all groups (daily)    : 500 admitted group messages / local day (configurable)
 *   4. duplicate content     : a sender's consecutive identical message is dropped
 *
 * Load-bearing properties:
 *
 *   - SILENT. A rejected message produces NO outbound text whatsoever. Telling
 *     a flooder 「太频繁」/「请稍后」 confirms a live bot and invites more
 *     flooding. The only trace is the audit line the gateway already writes.
 *   - GROUP-SCOPED. The per-minute counters are keyed by group, so one noisy
 *     group cannot silence another. The daily cap is deliberately global: it is
 *     the bot's total group-reply budget.
 *   - NO OWNER EXCEPTION. The owner OpenID is not special here. Groups are a
 *     public surface; whoever floods a group gets the same silence.
 *   - DM IS OUT OF SCOPE. Direct messages are owner-only and already isolated
 *     by the trust gate, so none of these group rules apply there.
 *
 * State is in-memory on purpose: a restart clears it, which is acceptable for a
 * flood guard. Nothing here is written to long-term memory or to disk.
 */

/*
 * The numeric guards live in `src/main/shared/qqRateLimit.ts` so the settings
 * page can render the real numbers; they are re-exported here for callers that
 * only know this module.
 */
import {
  QQ_DAILY_REPLY_LIMIT_DEFAULT,
  QQ_DAILY_REPLY_LIMIT_MAX,
  QQ_DAILY_REPLY_LIMIT_MIN,
  QQ_RATE_GROUP_PER_MINUTE,
  QQ_RATE_SENDER_PER_MINUTE,
  QQ_RATE_WINDOW_MS,
} from '../shared/qqRateLimit';

export {
  QQ_DAILY_REPLY_LIMIT_DEFAULT,
  QQ_DAILY_REPLY_LIMIT_MAX,
  QQ_DAILY_REPLY_LIMIT_MIN,
  QQ_RATE_GROUP_PER_MINUTE,
  QQ_RATE_SENDER_PER_MINUTE,
  QQ_RATE_WINDOW_MS,
};

/** Why a group message was refused. Audit/log material, never user facing. */
export type QQRateLimitReason = 'per-sender' | 'per-group' | 'daily' | 'duplicate';

export interface QQRateLimitDecision {
  allowed: boolean;
  reason: QQRateLimitReason | null;
  /** Usage after this decision (an admitted message is already counted). */
  senderCount: number;
  groupCount: number;
  dailyCount: number;
  dailyLimit: number;
}

export interface QQGroupRateCheck {
  groupId: string;
  senderId: string;
  content: string | null | undefined;
  /** Live daily budget. Invalid values degrade to the default, never to ∞. */
  dailyLimit?: unknown;
}

const MAX_WINDOW_KEYS = 2048;
const MAX_LAST_CONTENT_KEYS = 4096;

/**
 * Normalize the configurable daily cap.
 *
 * Invalid / out-of-range values fall back to the DEFAULT (500), not to the
 * maximum: a typo in a safety setting must tighten, never loosen. Values are
 * floored to integers; strings are accepted because an <input> hands one over.
 */
export function normalizeQQDailyReplyLimit(value: unknown): number {
  const numeric = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof numeric !== 'number' || !Number.isFinite(numeric)) {
    return QQ_DAILY_REPLY_LIMIT_DEFAULT;
  }
  const limit = Math.floor(numeric);
  if (limit < QQ_DAILY_REPLY_LIMIT_MIN || limit > QQ_DAILY_REPLY_LIMIT_MAX) {
    return QQ_DAILY_REPLY_LIMIT_DEFAULT;
  }
  return limit;
}

/**
 * Comparison key for the duplicate rule: drops @-mention markers (transport
 * metadata, identical on every group message) and collapses whitespace runs so
 * a trailing space cannot be used to dodge the rule. It does NOT lowercase or
 * otherwise rewrite the text: different words stay different.
 */
export function normalizeQQRateContent(content: string | null | undefined): string {
  return String(content ?? '')
    .replace(/<@!?[A-Za-z0-9_-]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function localDayStamp(now: number): string {
  const d = new Date(now);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function pruneWindow(hits: number[], now: number): number[] {
  // Keep events strictly inside the rolling window. A clock that jumps
  // backwards keeps the entries (they will age out again) instead of widening.
  return hits.filter((at) => now - at < QQ_RATE_WINDOW_MS);
}

/**
 * In-memory limiter. One instance per gateway; call {@link checkGroup} once per
 * group message, before any model work (and before any outbound notice).
 */
export class QQRateLimiter {
  private readonly now: () => number;
  /** `${groupId}\u0000${senderId}` -> admitted timestamps. */
  private readonly senderWindows = new Map<string, number[]>();
  /** groupId -> admitted timestamps. */
  private readonly groupWindows = new Map<string, number[]>();
  /** `${groupId}\u0000${senderId}` -> last distinct normalized content. */
  private readonly lastContent = new Map<string, string>();
  private dailyKey = '';
  private dailyCount = 0;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Decide whether this group message may reach the model.
   *
   * Order matters: the duplicate check runs first (it consumes no budget and
   * gives the clearest audit reason), then the per-minute rules, then the
   * daily budget. Only an ADMITTED message consumes quota — rejected messages
   * must not extend their own block.
   */
  checkGroup(input: QQGroupRateCheck): QQRateLimitDecision {
    const now = this.now();
    const dailyLimit = normalizeQQDailyReplyLimit(input.dailyLimit);
    const groupKey = String(input.groupId ?? '').trim();
    const senderKey = `${groupKey}\u0000${String(input.senderId ?? '').trim()}`;
    const content = normalizeQQRateContent(input.content);

    this.rollDay(now);
    this.sweep(now);

    // Read-only until the message is admitted: a rejected message must not
    // create or refresh a window entry, otherwise a flood from many ids would
    // grow these maps without bound (and make every sweep O(n) under attack).
    const senderWindow = pruneWindow(this.senderWindows.get(senderKey) ?? [], now);
    const groupWindow = pruneWindow(this.groupWindows.get(groupKey) ?? [], now);

    const deny = (reason: QQRateLimitReason): QQRateLimitDecision => ({
      allowed: false,
      reason,
      senderCount: senderWindow.length,
      groupCount: groupWindow.length,
      dailyCount: this.dailyCount,
      dailyLimit,
    });

    // 4. Consecutive identical content from the same sender in the same group.
    // Compare with that sender's previous distinct message; remember the
    // current one even if a minute-limit rejects it afterwards, so a burst of
    // the same text stays a burst.
    if (content) {
      const previous = this.lastContent.get(senderKey);
      if (previous !== undefined && previous === content) {
        return deny('duplicate');
      }
      this.rememberContent(senderKey, content);
    }

    if (senderWindow.length >= QQ_RATE_SENDER_PER_MINUTE) {
      return deny('per-sender');
    }
    if (groupWindow.length >= QQ_RATE_GROUP_PER_MINUTE) {
      return deny('per-group');
    }
    if (this.dailyCount >= dailyLimit) {
      return deny('daily');
    }

    senderWindow.push(now);
    groupWindow.push(now);
    this.senderWindows.set(senderKey, senderWindow);
    this.groupWindows.set(groupKey, groupWindow);
    this.dailyCount += 1;
    return {
      allowed: true,
      reason: null,
      senderCount: senderWindow.length,
      groupCount: groupWindow.length,
      dailyCount: this.dailyCount,
      dailyLimit,
    };
  }

  /** Clear every counter (restart semantics; also used by tests). */
  reset(): void {
    this.senderWindows.clear();
    this.groupWindows.clear();
    this.lastContent.clear();
    this.dailyKey = '';
    this.dailyCount = 0;
  }

  private rollDay(now: number): void {
    const key = localDayStamp(now);
    if (key === this.dailyKey) return;
    this.dailyKey = key;
    this.dailyCount = 0;
    // A new budget day is also a new "consecutive" baseline. Carrying
    // yesterday's last line over would silently swallow a legitimate repeat
    // after the counters had already reset.
    this.lastContent.clear();
  }

  private rememberContent(senderKey: string, content: string): void {
    if (!this.lastContent.has(senderKey) && this.lastContent.size >= MAX_LAST_CONTENT_KEYS) {
      const oldest = this.lastContent.keys().next();
      if (!oldest.done) this.lastContent.delete(oldest.value);
    }
    this.lastContent.set(senderKey, content);
  }

  /** Bound memory: drop empty windows once the maps look polluted. */
  private sweep(now: number): void {
    if (this.senderWindows.size > MAX_WINDOW_KEYS) {
      for (const [key, hits] of this.senderWindows) {
        const live = pruneWindow(hits, now);
        if (live.length === 0) this.senderWindows.delete(key);
        else this.senderWindows.set(key, live);
      }
    }
    if (this.groupWindows.size > MAX_WINDOW_KEYS) {
      for (const [key, hits] of this.groupWindows) {
        const live = pruneWindow(hits, now);
        if (live.length === 0) this.groupWindows.delete(key);
        else this.groupWindows.set(key, live);
      }
    }
  }
}
