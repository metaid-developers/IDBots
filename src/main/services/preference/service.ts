import type { CollectPreferenceEventsResult } from './collector';
import { COMMIT_CUTOFF_SEC, REVEAL_DELAY_SEC, type PreferenceSegment } from './constants';
import { compareOrderKey, tallyRound } from './engine';
import { canonicalRoundForSubject, checkLesson, verifyLessonPin, type CanonicalRoundResolution } from './lesson';
import { checkBallot, parseLesson, parseRound } from './schemas';
import { ballotCommitHash, newBallotSalt } from './sealing';
import { toBallotView, type PreferenceBallotView, type PreferenceStore } from './store';
import type {
  LessonPrinciple,
  PreferenceChainEvent,
  RoundBody,
  RoundCandidate,
  RoundJudge,
  TallyResult,
  TallyStatus,
} from './types';

export type PreferenceSigner = { type: 'user' } | { type: 'metabot'; metabotId: number };

export interface PreferencePinWriteResult {
  pinId: string;
  txids: string[];
}

export interface PreferenceWriter {
  globalMetaId: string;
  write(segment: PreferenceSegment, payload: object): Promise<PreferencePinWriteResult>;
}

export type PreferenceWriterResolution = PreferenceWriter | { error: string };

export interface PreferenceServiceDeps {
  store: PreferenceStore;
  collect: (options?: { bypassCache?: boolean }) => Promise<CollectPreferenceEventsResult>;
  resolveWriter: (signer: PreferenceSigner) => PreferenceWriterResolution;
  nowMs?: () => number;
  onUpdate?: (reason: string) => void;
}

export interface PreferenceRoundSummary {
  pinId: string;
  author: string;
  confirmed: boolean;
  title: string;
  category: string[];
  subject: { taskid: string; node: string } | null;
  candidateCount: number;
  judges: RoundJudge[];
  commitCloseAt: number;
  revealCloseAt: number;
  status: TallyStatus | 'pending';
  winner: string | null;
}

export interface PreferenceRoundView {
  pinId: string;
  author: string;
  confirmed: boolean;
  round: RoundBody;
  tally: TallyResult | null;
  tallyError: string | null;
  localBallots: PreferenceBallotView[];
  lesson: { pinId: string; valid: boolean; reason: string | null } | null;
}

export interface PreferenceLessonView {
  pinId: string;
  author: string;
  timestampMs: number;
  roundPinId: string;
  roundTitle: string;
  category: string[];
  summary: string;
  principles: LessonPrinciple[];
  preferred: RoundCandidate;
  rejected: RoundCandidate[];
  decidingBallots: number;
}

export interface PreferenceRefreshResult {
  ok: boolean;
  eventCount: number;
  error: string | null;
}

type ErrorResult = { error: string };

const errorOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const tagMatches = (query: string, tag: string): boolean => tag === query || tag.startsWith(`${query}:`);

const STALE_COMMITTING_MS = 120_000;

export class PreferenceService {
  private readonly deps: PreferenceServiceDeps;
  private refreshing: Promise<PreferenceRefreshResult> | null = null;

  constructor(deps: PreferenceServiceDeps) {
    this.deps = deps;
  }

  private nowMs(): number {
    return this.deps.nowMs ? this.deps.nowMs() : Date.now();
  }

  private nowSec(): number {
    return Math.floor(this.nowMs() / 1000);
  }

  refresh(reason: string, options?: { bypassCache?: boolean }): Promise<PreferenceRefreshResult> {
    if (!this.refreshing) {
      this.refreshing = this.runRefresh(reason, options).finally(() => {
        this.refreshing = null;
      });
    }
    // If a sweep is already in flight we share it as-is: a bypassCache rider
    // on a running non-bypass sweep is accepted (the next write-flow refresh
    // will bypass again; the shared sweep only costs one extra TTL window).
    return this.refreshing;
  }

  private async runRefresh(reason: string, options?: { bypassCache?: boolean }): Promise<PreferenceRefreshResult> {
    try {
      const result = await this.deps.collect({ ...(options?.bypassCache ? { bypassCache: true } : {}) });
      this.deps.store.upsertEvents(result.events, this.nowMs());
      const errors = result.perPath.filter((entry) => entry.error).map((entry) => `${entry.segment}: ${entry.error}`);
      this.deps.onUpdate?.(reason);
      return { ok: errors.length === 0, eventCount: result.events.length, error: errors.length > 0 ? errors.join('; ') : null };
    } catch (error) {
      return { ok: false, eventCount: 0, error: errorOf(error) };
    }
  }

  events(): PreferenceChainEvent[] {
    return this.deps.store.loadEvents();
  }

  /** Finds a round in the cache, confirmed or not, and validates it against its own timestamp. */
  private locateRound(
    events: readonly PreferenceChainEvent[],
    roundPinId: string,
  ): { event: PreferenceChainEvent; round: RoundBody } | ErrorResult {
    const event = events.find((candidate) => candidate.path === 'round' && candidate.pinId === roundPinId);
    if (!event) return { error: 'round:not-found' };
    const parsed = parseRound(event.body, Math.floor(event.timestampMs / 1000));
    return parsed.ok === true ? { event, round: parsed.value } : { error: parsed.reason };
  }

  listRounds(filter: { judge?: string; taskid?: string } = {}): PreferenceRoundSummary[] {
    const events = this.events();
    const nowSec = this.nowSec();
    const rounds = events.filter((event) => event.path === 'round').sort((a, b) => b.timestampMs - a.timestampMs);
    const out: PreferenceRoundSummary[] = [];
    for (const event of rounds) {
      const located = this.locateRound(events, event.pinId);
      if ('error' in located) continue;
      const { round } = located;
      if (filter.judge && !round.judges.some((judge) => judge.id === filter.judge)) continue;
      if (filter.taskid && round.subject?.taskid !== filter.taskid) continue;
      const confirmed = event.height >= 0;
      const tally = confirmed ? tallyRound(events, event.pinId, { nowSec }) : null;
      out.push({
        pinId: event.pinId,
        author: event.author,
        confirmed,
        title: round.title,
        category: round.category,
        subject: round.subject ?? null,
        candidateCount: round.candidates.length,
        judges: round.judges,
        commitCloseAt: round.commitCloseAt,
        revealCloseAt: round.revealCloseAt,
        status: tally && tally.ok === true ? tally.result.output.status : 'pending',
        winner: tally && tally.ok === true ? tally.result.output.winner : null,
      });
    }
    return out;
  }

  roundStatus(roundPinId: string, options: { lessonPinId?: string } = {}): PreferenceRoundView | ErrorResult {
    const events = this.events();
    const located = this.locateRound(events, roundPinId);
    if ('error' in located) return located;
    const nowSec = this.nowSec();
    const tally = tallyRound(events, roundPinId, { nowSec });
    let lesson: PreferenceRoundView['lesson'] = null;
    if (options.lessonPinId) {
      const lessonEvent = events.find((event) => event.path === 'lesson' && event.pinId === options.lessonPinId);
      const verdict = verifyLessonPin(events, options.lessonPinId, nowSec);
      const sameRound = lessonEvent?.body.round === roundPinId;
      lesson = {
        pinId: options.lessonPinId,
        valid: verdict.ok && sameRound,
        reason: verdict.ok === true ? (sameRound ? null : 'lesson:round-mismatch') : verdict.reason,
      };
    }
    return {
      pinId: roundPinId,
      author: located.event.author,
      confirmed: located.event.height >= 0,
      round: located.round,
      tally: tally.ok === true ? tally.result : null,
      tallyError: tally.ok === true ? null : tally.reason,
      localBallots: this.deps.store.listBallots({ roundPinId }).map(toBallotView),
      lesson,
    };
  }

  canonicalRound(subject: { taskid: string; node: string; rootAuthor: string }): CanonicalRoundResolution {
    return canonicalRoundForSubject(this.events(), subject, this.nowSec());
  }

  searchLessons(query: { category?: string[]; limit?: number } = {}): PreferenceLessonView[] {
    const events = this.events();
    const nowSec = this.nowSec();
    const limit = Math.max(1, Math.min(query.limit ?? 10, 50));
    const tallies = new Map<string, TallyResult | null>();
    const out: PreferenceLessonView[] = [];
    const lessons = events
      .filter((event) => event.path === 'lesson' && event.height >= 0)
      .sort((a, b) => compareOrderKey(b, a));
    for (const event of lessons) {
      const roundPinId = typeof event.body.round === 'string' ? event.body.round : '';
      if (!tallies.has(roundPinId)) {
        const tally = tallyRound(events, roundPinId, { nowSec });
        tallies.set(roundPinId, tally.ok === true ? tally.result : null);
      }
      const tally = tallies.get(roundPinId);
      if (!tally) continue;
      const verdict = checkLesson(event.body, tally);
      if (verdict.ok === false) continue;
      const { lesson } = verdict;
      const wanted = query.category ?? [];
      if (wanted.length > 0 && !wanted.some((tag) => lesson.category.some((own) => tagMatches(tag, own)))) continue;
      const located = this.locateRound(events, roundPinId);
      if ('error' in located) continue;
      const byId = new Map(located.round.candidates.map((candidate) => [candidate.id, candidate] as const));
      const preferred = byId.get(lesson.exemplars.preferred);
      if (!preferred) continue;
      out.push({
        pinId: event.pinId,
        author: event.author,
        timestampMs: event.timestampMs,
        roundPinId,
        roundTitle: located.round.title,
        category: lesson.category,
        summary: lesson.summary,
        principles: lesson.principles,
        preferred,
        rejected: lesson.exemplars.rejected.flatMap((id) => {
          const candidate = byId.get(id);
          return candidate ? [candidate] : [];
        }),
        decidingBallots: tally.output.ballots.deciding,
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  private cacheOwnPin(pinId: string, segment: PreferenceSegment, author: string, payload: object): void {
    const body = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    this.deps.store.upsertEvents(
      [{ pinId, path: segment, author, height: -1, txIndex: 0, timestampMs: this.nowMs(), body }],
      this.nowMs(),
    );
    this.deps.onUpdate?.(`local-${segment}`);
  }

  async openRound(signer: PreferenceSigner, body: unknown): Promise<{ pinId: string } | ErrorResult> {
    const parsed = parseRound(body, this.nowSec() + COMMIT_CUTOFF_SEC);
    if (parsed.ok === false) return { error: parsed.reason };
    const writer = this.deps.resolveWriter(signer);
    if ('error' in writer) return writer;
    try {
      const written = await writer.write('round', parsed.value);
      this.cacheOwnPin(written.pinId, 'round', writer.globalMetaId, parsed.value);
      return { pinId: written.pinId };
    } catch (error) {
      return { error: errorOf(error) };
    }
  }

  async commitBallot(
    signer: PreferenceSigner,
    roundPinId: string,
    rawBallot: unknown,
  ): Promise<{ pinId: string; ballotId: string } | ErrorResult> {
    let located = this.locateRound(this.events(), roundPinId);
    if ('error' in located && located.error === 'round:not-found') {
      await this.refresh('commit-lookup');
      located = this.locateRound(this.events(), roundPinId);
    }
    if ('error' in located) return located;
    const { round } = located;
    if (this.nowSec() > round.commitCloseAt - COMMIT_CUTOFF_SEC) return { error: 'preference:commit-window-closing' };
    const checked = checkBallot(rawBallot, round);
    if (checked.ok === false) return { error: checked.reason };
    const writer = this.deps.resolveWriter(signer);
    if ('error' in writer) return writer;
    const ownIds = new Set(round.candidates.filter((candidate) => candidate.author === writer.globalMetaId).map((candidate) => candidate.id));
    if (checked.value.pairs.some((pair) => ownIds.has(pair.a) || ownIds.has(pair.b))) {
      return { error: 'preference:own-candidate-in-ballot' };
    }
    const salt = newBallotSalt();
    const commitHash = ballotCommitHash({ round: roundPinId, judge: writer.globalMetaId, salt, ballot: checked.value });
    const row = this.deps.store.insertBallot({
      roundPinId,
      signerType: signer.type,
      metabotId: signer.type === 'metabot' ? signer.metabotId : null,
      judgeGlobalMetaId: writer.globalMetaId,
      ballot: checked.value,
      salt,
      commitHash,
      commitCloseAt: round.commitCloseAt,
      revealCloseAt: round.revealCloseAt,
      nowMs: this.nowMs(),
    });
    try {
      const payload = { round: roundPinId, hash: commitHash };
      const written = await writer.write('commit', payload);
      this.deps.store.markCommitted(row.id, written.pinId, this.nowMs());
      this.cacheOwnPin(written.pinId, 'commit', writer.globalMetaId, payload);
      return { pinId: written.pinId, ballotId: row.id };
    } catch (error) {
      this.deps.store.markCommitFailed(row.id, errorOf(error), this.nowMs());
      return { error: errorOf(error) };
    }
  }

  async publishLesson(signer: PreferenceSigner, body: unknown): Promise<{ pinId: string } | ErrorResult> {
    const parsed = parseLesson(body);
    if (parsed.ok === false) return { error: parsed.reason };
    const tally = tallyRound(this.events(), parsed.value.round, { nowSec: this.nowSec() });
    if (tally.ok === false) return { error: tally.reason };
    const verdict = checkLesson(parsed.value, tally.result);
    if (verdict.ok === false) return { error: verdict.reason };
    const writer = this.deps.resolveWriter(signer);
    if ('error' in writer) return writer;
    try {
      const written = await writer.write('lesson', verdict.lesson);
      this.cacheOwnPin(written.pinId, 'lesson', writer.globalMetaId, verdict.lesson);
      return { pinId: written.pinId };
    } catch (error) {
      return { error: errorOf(error) };
    }
  }

  recordTelemetry(roundPinId: string, pairKey: string, seconds: number): void {
    if (!Number.isInteger(seconds) || seconds < 0 || seconds > 3600) return;
    this.deps.store.recordTelemetry(roundPinId, pairKey, seconds, this.nowMs());
  }

  hasActiveBallots(): boolean {
    return this.deps.store.countActive(this.nowSec()) > 0;
  }

  async revealDue(): Promise<{ attempted: number; revealed: number; failed: number; expired: number }> {
    const nowSec = this.nowSec();
    const expired = this.deps.store.expireStale(nowSec, this.nowMs());
    this.reconcile(this.events(), nowSec);
    const counts = { attempted: 0, revealed: 0, failed: 0, expired };
    for (const row of this.deps.store.listBallots({ statuses: ['committed'] })) {
      if (!row.commitPinId || nowSec < row.commitCloseAt + REVEAL_DELAY_SEC || nowSec > row.revealCloseAt) continue;
      counts.attempted += 1;
      const signer: PreferenceSigner = row.signerType === 'user'
        ? { type: 'user' }
        : { type: 'metabot', metabotId: row.metabotId ?? -1 };
      const writer = this.deps.resolveWriter(signer);
      if ('error' in writer || writer.globalMetaId !== row.judgeGlobalMetaId) {
        this.deps.store.markRevealFailed(row.id, 'error' in writer ? writer.error : 'preference:signer-changed', this.nowMs());
        counts.failed += 1;
        continue;
      }
      const payload = { round: row.roundPinId, commit: row.commitPinId, salt: row.salt, ballot: row.ballot };
      try {
        const written = await writer.write('reveal', payload);
        this.deps.store.markRevealed(row.id, written.pinId, this.nowMs());
        this.cacheOwnPin(written.pinId, 'reveal', writer.globalMetaId, payload);
        counts.revealed += 1;
      } catch (error) {
        this.deps.store.markRevealFailed(row.id, errorOf(error), this.nowMs());
        counts.failed += 1;
      }
    }
    if (counts.revealed > 0 || counts.expired > 0) this.deps.onUpdate?.('preference-reveal');
    return counts;
  }

  private reconcile(events: readonly PreferenceChainEvent[], nowSec: number): void {
    const nowMs = this.nowMs();
    for (const row of this.deps.store.listBallots({ statuses: ['committing', 'revealed'] })) {
      if (row.status === 'committing') {
        if (nowMs - row.createdAtMs < STALE_COMMITTING_MS) continue;
        const onChain = events.find(
          (event) => event.path === 'commit'
            && event.author === row.judgeGlobalMetaId
            && event.body.round === row.roundPinId
            && event.body.hash === row.commitHash,
        );
        if (onChain) this.deps.store.markCommitted(row.id, onChain.pinId, nowMs);
        continue;
      }
      if (!row.revealPinId || nowSec > row.revealCloseAt) continue;
      const reveal = events.find((event) => event.pinId === row.revealPinId);
      if (reveal && reveal.height >= 0 && Math.floor(reveal.timestampMs / 1000) <= row.commitCloseAt) {
        this.deps.store.markRevealRetry(row.id, nowMs);
      }
    }
  }
}
