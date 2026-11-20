/**
 * Session-level visibility for a turn served by a NON-primary brain.
 *
 * §9 visibility gap (2026-11-20 dream-distillation batch): the transcript
 * already carries a switch notice (`metadata.dshRouteFallback`), but the
 * SESSION STATUS surface — the sidebar row that says 运行中 / Running — kept
 * showing a healthy running state while the primary brain was dead and a
 * fallback route was doing the work. A background, orchestrated or group-task
 * session inspected from another session (post-mortem reads exactly those
 * rows) therefore looked indistinguishable from a turn on the primary model.
 *
 * This module owns ONLY the marker: its shape, its bounded lifecycle and the
 * rung classification the renderer keys its label off. It never decides which
 * route runs — the runner hands it a switch that already happened, so the
 * fallback ladder and routing logic stay untouched.
 *
 * Dependency-free and pure so the mark → lookup → clear behavior is testable
 * without a DSH runtime (see tests/fallbackBrainStatus.test.mjs).
 */

/**
 * Which ladder rung produced the serving route:
 * - 'bot-fallback'    the bot's configured fallback brain (fallback_llm_*)
 * - 'current-default' the app's current default route (system rescue ladder)
 * - 'system-rescue'   the last-resort rescue route
 *
 * Only 'bot-fallback' is literally the 备用脑; the other two are degradations
 * as well and get their own (more general) label on the status surface.
 */
export type FallbackBrainRung = 'bot-fallback' | 'current-default' | 'system-rescue';

export interface FallbackBrainActivation {
  /** Provider key serving the turn now. */
  provider: string;
  /** Model id serving the turn now. */
  model: string;
  /** Provider key of the route that failed. */
  fromProvider: string | null;
  /** Model id of the route that failed. */
  fromModel: string | null;
  /** Ladder rung that resolved the serving route. */
  rung: FallbackBrainRung;
  /** Epoch ms of the switch. */
  at: number;
}

/** Field attached to a session summary while the marker is live. */
export interface CoworkActiveFallbackBrain {
  provider: string;
  model: string;
  fromProvider: string | null;
  fromModel: string | null;
  rung: FallbackBrainRung;
  since: number;
}

/**
 * Bounded like the quota-bypass notice map: a long-lived process must not
 * accumulate one entry per session ever run. Entries are also cleared at turn
 * settle, so this cap is a safety valve, not the normal exit path.
 */
const MAX_TRACKED_SESSIONS = 256;

const RUNGS: ReadonlySet<string> = new Set(['bot-fallback', 'current-default', 'system-rescue']);

function normalizeId(sessionId: unknown): string {
  return typeof sessionId === 'string' ? sessionId.trim() : '';
}

/** Project an activation into the session-summary field. */
export function toSummaryField(activation: FallbackBrainActivation): CoworkActiveFallbackBrain {
  return {
    provider: activation.provider,
    model: activation.model,
    fromProvider: activation.fromProvider,
    fromModel: activation.fromModel,
    rung: activation.rung,
    since: activation.at,
  };
}

/**
 * In-memory registry of live fallback-brain turn markers.
 *
 * One entry per running turn: written when the runner commits a switch,
 * cleared in the runner's single settle point (`finish()`). A process restart
 * drops it along with the turn itself — a stale marker can never outlive the
 * work it described.
 */
export class FallbackBrainRegistry {
  private readonly bySession = new Map<string, FallbackBrainActivation>();

  /**
   * Record (or refresh) the marker for a session. Returns the stored
   * activation, or null when the input cannot describe a known rung / route
   * (never throws: a malformed mark must not break a live turn).
   */
  mark(sessionId: string, activation: FallbackBrainActivation): FallbackBrainActivation | null {
    const id = normalizeId(sessionId);
    if (!id || !activation || typeof activation !== 'object') return null;
    const model = typeof activation.model === 'string' ? activation.model.trim() : '';
    const provider = typeof activation.provider === 'string' ? activation.provider.trim() : '';
    if (!model) return null;
    if (!RUNGS.has(activation.rung)) return null;
    const next: FallbackBrainActivation = {
      provider,
      model,
      fromProvider: activation.fromProvider ?? null,
      fromModel: activation.fromModel ?? null,
      rung: activation.rung,
      at: Number.isFinite(activation.at) ? activation.at : Date.now(),
    };
    this.bySession.set(id, next);
    if (this.bySession.size > MAX_TRACKED_SESSIONS) {
      for (const key of this.bySession.keys()) {
        if (this.bySession.size <= MAX_TRACKED_SESSIONS) break;
        // Never evict the mark just written.
        if (key !== id) this.bySession.delete(key);
      }
    }
    return next;
  }

  /** Drop the marker (turn settled / aborted). True when one was present. */
  clear(sessionId: string): boolean {
    return this.bySession.delete(normalizeId(sessionId));
  }

  get(sessionId: string): FallbackBrainActivation | null {
    return this.bySession.get(normalizeId(sessionId)) ?? null;
  }

  /** `{ activeFallbackBrain }` for a summary, or null when nothing is live. */
  summaryField(sessionId: string): { activeFallbackBrain: CoworkActiveFallbackBrain } | null {
    const activation = this.get(sessionId);
    return activation ? { activeFallbackBrain: toSummaryField(activation) } : null;
  }

  get size(): number {
    return this.bySession.size;
  }
}

/**
 * Merge the live marker into a session summary / session row. Pure and
 * shape-preserving: when no marker is live the input object is returned
 * unchanged (same reference), so callers can map a whole list without
 * replacing untouched rows.
 *
 * `lookup` is the live-marker reader (the runner's getActiveFallbackBrain);
 * a null/absent lookup leaves every row untouched.
 */
export function withActiveFallbackBrain<T extends { id?: string | null }>(
  summary: T,
  lookup: ((sessionId: string) => FallbackBrainActivation | null) | null | undefined,
): T & Partial<{ activeFallbackBrain: CoworkActiveFallbackBrain }> {
  const id = normalizeId(summary?.id);
  if (!id || !lookup) return summary;
  const activation = lookup(id);
  if (!activation) return summary;
  return { ...summary, activeFallbackBrain: toSummaryField(activation) };
}
