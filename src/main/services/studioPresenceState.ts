import type { StudioDecisionQueueItem } from '../studioDecisionQueueStore';

/**
 * Twin Bot front-office presence state in Studio mode:
 *  - 'shaping': actively responding to an owner demand / clarifying & forming
 *    a task card. Proactive decision-queue briefings MUST hold silent.
 *  - 'briefing': presenting one queued decision/acceptance item to the owner
 *    and awaiting their ruling. Subsequent queued items wait in line; if the
 *    owner starts a brand-new topic, the presenting item is deferred back to
 *    the head of the queue and presence transitions to 'shaping'.
 *  - 'idle': casual chat or standing by. When the decision queue is non-empty,
 *    the heartbeat pops the next item and transitions into 'briefing'.
 */
export type StudioTwinPresenceMode = 'shaping' | 'briefing' | 'idle';

export interface StudioTwinPresenceSnapshot {
  mode: StudioTwinPresenceMode;
  reason: string;
  activeStudioSessionId: string | null;
  presentingItem: StudioDecisionQueueItem | null;
  queuedCount: number;
}

export const DEFAULT_STUDIO_IDLE_DEBOUNCE_MS = 8_000;
export const DEFAULT_SHAPING_HOLD_TTL_MS = 20 * 60_000;

export interface DeriveStudioPresenceInput {
  activeStudioSessionId: string | null;
  studioTurnRunning: boolean;
  briefingTurnRunning: boolean;
  hasDefiningDraftInStudio: boolean;
  explicitShapingHoldReason: string | null;
  lastNonBriefingTurnEndedAtMs: number | null;
  presentingItem: StudioDecisionQueueItem | null;
  queuedCount: number;
  nowMs?: number;
  idleDebounceMs?: number;
}

export function deriveStudioPresenceState(
  input: DeriveStudioPresenceInput,
): StudioTwinPresenceSnapshot {
  const nowMs = input.nowMs ?? Date.now();
  const debounceMs = Math.max(0, input.idleDebounceMs ?? DEFAULT_STUDIO_IDLE_DEBOUNCE_MS);

  if (input.briefingTurnRunning) {
    return {
      mode: 'briefing',
      reason: 'proactive briefing turn is streaming',
      activeStudioSessionId: input.activeStudioSessionId,
      presentingItem: input.presentingItem,
      queuedCount: input.queuedCount,
    };
  }

  if (input.studioTurnRunning) {
    return {
      mode: 'shaping',
      reason: 'owner turn is currently running in Studio',
      activeStudioSessionId: input.activeStudioSessionId,
      presentingItem: input.presentingItem,
      queuedCount: input.queuedCount,
    };
  }

  if (input.explicitShapingHoldReason) {
    return {
      mode: 'shaping',
      reason: `awaiting owner clarification to form task (${input.explicitShapingHoldReason})`,
      activeStudioSessionId: input.activeStudioSessionId,
      presentingItem: input.presentingItem,
      queuedCount: input.queuedCount,
    };
  }

  if (input.hasDefiningDraftInStudio) {
    return {
      mode: 'shaping',
      reason: 'an unactivated task draft is currently being defined in Studio',
      activeStudioSessionId: input.activeStudioSessionId,
      presentingItem: input.presentingItem,
      queuedCount: input.queuedCount,
    };
  }

  if (input.presentingItem) {
    return {
      mode: 'briefing',
      reason: `awaiting owner ruling on "${input.presentingItem.title}"`,
      activeStudioSessionId: input.activeStudioSessionId,
      presentingItem: input.presentingItem,
      queuedCount: input.queuedCount,
    };
  }

  if (
    input.lastNonBriefingTurnEndedAtMs !== null
    && nowMs - input.lastNonBriefingTurnEndedAtMs < debounceMs
  ) {
    return {
      mode: 'shaping',
      reason: 'post-turn quiet debounce window active',
      activeStudioSessionId: input.activeStudioSessionId,
      presentingItem: null,
      queuedCount: input.queuedCount,
    };
  }

  return {
    mode: 'idle',
    reason: 'standing by for owner conversation or next queued briefing',
    activeStudioSessionId: input.activeStudioSessionId,
    presentingItem: null,
    queuedCount: input.queuedCount,
  };
}

interface ShapingHoldRecord {
  reason: string;
  expiresAtMs: number;
}

export class StudioPresenceTracker {
  private readonly shapingHolds = new Map<string, ShapingHoldRecord>();
  private readonly lastOwnerTurnEndedAt = new Map<string, number>();
  private readonly activeBriefingSessions = new Set<string>();

  markShapingHold(
    sessionId: string,
    reason: string,
    nowMs: number = Date.now(),
    ttlMs: number = DEFAULT_SHAPING_HOLD_TTL_MS,
  ): void {
    const trimmed = sessionId.trim();
    if (!trimmed) return;
    this.shapingHolds.set(trimmed, {
      reason: reason.trim() || 'requirement alignment',
      expiresAtMs: nowMs + Math.max(10_000, ttlMs),
    });
  }

  clearShapingHold(sessionId: string): void {
    this.shapingHolds.delete(sessionId.trim());
  }

  getActiveShapingHoldReason(sessionId: string | null, nowMs: number = Date.now()): string | null {
    if (!sessionId) return null;
    const key = sessionId.trim();
    const record = this.shapingHolds.get(key);
    if (!record) return null;
    if (nowMs >= record.expiresAtMs) {
      this.shapingHolds.delete(key);
      return null;
    }
    return record.reason;
  }

  recordNonBriefingTurnEnd(sessionId: string, nowMs: number = Date.now()): void {
    const trimmed = sessionId.trim();
    if (!trimmed) return;
    if (this.activeBriefingSessions.has(trimmed)) return;
    this.lastOwnerTurnEndedAt.set(trimmed, nowMs);
  }

  getLastNonBriefingTurnEndedAtMs(sessionId: string | null): number | null {
    if (!sessionId) return null;
    return this.lastOwnerTurnEndedAt.get(sessionId.trim()) ?? null;
  }

  setBriefingTurnRunning(sessionId: string, running: boolean): void {
    const trimmed = sessionId.trim();
    if (!trimmed) return;
    if (running) {
      this.activeBriefingSessions.add(trimmed);
    } else {
      this.activeBriefingSessions.delete(trimmed);
    }
  }

  isBriefingTurnRunning(sessionId: string | null): boolean {
    if (!sessionId) return false;
    return this.activeBriefingSessions.has(sessionId.trim());
  }
}
