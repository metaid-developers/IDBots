/**
 * SurfService — the autonomous MetaWeb surf ("AI 冲浪") loop.
 *
 * One run: stage-0 briefing (deterministic) → optional unattended LLM session
 * (injected; learns/engages in persona) → watermarks advance, report lands in
 * metaweb_surf_runs for the UI and the same night's dream.
 *
 * Design follows the DreamService module-singleton pattern with injectable
 * session/broadcast for tests. Per-bot mutex in memory; metaweb_surf_runs rows
 * are the crash-recovery anchor.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  emptySurfRunStats,
  type MetawebSurfRunRecord,
  type MetawebSurfRunStats,
  type MetawebSurfSeenAction,
  type MetawebSurfStore,
  type MetawebSurfTrigger,
} from '../metawebSurfStore';
import { buildSurfBriefing, renderSurfBriefingMarkdown, type SurfBriefing, type SurfHotPostItem, type SurfInboxItem, type SurfProtocolRadarFetchResult } from '../libs/surfBriefing';
import { extractSurfNotesFromReportJson } from '../libs/surfPrompt';
import { surfReceiptsFromChainWriteRecord } from '../libs/surfInteractionGuard';
import { DEFAULT_SURF_PROTOCOLS, type SurfProtocolDescriptor } from '../libs/surfProtocols';
import { getSurfCreationBudget, getSurfCreationMode, getSurfInteractionBudget, isSurfBeforeDreamEnabled, type SurfSettingsReader } from './surfSettings';

export const SURF_STATUS_CHANNEL = 'metabot:surfStatusChanged';
/** A finished surf younger than this makes the pre-dream surf redundant. */
export const PRE_DREAM_SURF_RECENCY_MS = 20 * 60 * 60 * 1000;
/** Longest dream-diary excerpt carried into a surf prompt (P2a bloat cap). */
export const SURF_DREAM_DIGEST_MAX_CHARS = 1200;

/** Local (host timezone) `YYYY-MM-DD` key for the on-disk report file name. */
const formatLocalDateKey = (ms: number): string => {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};

export interface SurfStatusEvent {
  metabotId: number;
  runId: string;
  trigger: MetawebSurfTrigger;
  status: 'running' | 'done' | 'failed';
  error?: string | null;
}

export interface SurfMetabotStoreLike extends SurfSettingsReader {
  getMetabotById(id: number): { id: number; name: string } | null;
}

export interface SurfSessionContext {
  runId: string;
  metabotId: number;
  botName: string;
  trigger: MetawebSurfTrigger;
  briefing: SurfBriefing;
  /**
   * Set by the host session wiring (main.ts): false runs the DEGRADED prompt
   * variant (no KB/memory tools exist in that session) — manual triggers are
   * allowed with memory off (review 2, item 9 option B). Absent → full prompt.
   */
  memoryEnabled?: boolean;
  /**
   * The "notes for next surf" the bot wrote in its last DONE run's report,
   * read back out of reportJson (round 3: notes were a write-only channel).
   * Absent/null → no notes section in the prompt.
   */
  previousNotes?: string | null;
  /**
   * P2a: the bot's latest dream diary (daily_summary) — the overnight
   * reflection that may already contain a creative agenda from the last
   * surf+dream cycle. Absent/null → no dream section in the prompt.
   */
  dreamDigest?: string | null;
}

export interface SurfSessionResult {
  stats?: Partial<MetawebSurfRunStats>;
  reportMarkdown?: string | null;
  reportJson?: string | null;
  /** Per-pin actions reported by the session, folded into the seen ledger. */
  seenActions?: Array<{ pinId: string; action: import('../metawebSurfStore').MetawebSurfSeenAction }>;
}

/**
 * Nightly-token audit (2026-10-25): does the deterministic briefing give the
 * unattended session anything PERSONAL to act on? "No" means no unseen
 * protocol items and an error-free empty inbox. The pre-dream path then
 * skips the LLM session and finishes digest-only — production showed
 * fetched:0 nights still spending the full 10-20 min / ~3.5M-token session
 * on the prompt's mandatory search party, hot-post engagement and creation
 * steps, which is exactly what the skip gives up on a dead night.
 *
 * Fetch errors never qualify: an unknown window is not an empty one, and the
 * errored sections' watermarks are preserved for the next run either way.
 * An absent inbox section (bot without an identity/fetcher) counts as empty.
 */
export function surfBriefingHasNoWork(briefing: SurfBriefing): boolean {
  if (briefing.items.length > 0) return false;
  if (briefing.protocols.some((section) => section.error)) return false;
  if (briefing.inbox) {
    if (briefing.inbox.error) return false;
    if (briefing.inbox.items.length > 0) return false;
  }
  return true;
}

export interface SurfServiceDeps {
  store: MetawebSurfStore;
  metabotStore: SurfMetabotStoreLike;
  broadcast: (payload: SurfStatusEvent) => void;
  /** Phase-3 LLM session; absent → digest-only run (still useful: report + watermarks). */
  runSurfSession?: (context: SurfSessionContext) => Promise<SurfSessionResult>;
  /**
   * Memory policy (same source the study service reads). Only the PRE-DREAM
   * path is gated: the nightly unattended run learns into the KB, so with
   * memory off it is skipped. Manual triggers deliberately run DEGRADED with
   * memory off (owner decision, review 2 item 9 option B) — the session gets
   * no KB/memory tools and the prompt says so. Absent → gate off (tests).
   */
  isMemoryEnabled?: (metabotId: number) => boolean;
  /**
   * Local chain-writes ledger read for the pre-briefing reconciliation
   * (round 3): receipts lost to a crash/kill mid-run (or a stopped orphan
   * session) are re-derived before every run so the duplicate-interaction
   * guard never works off a stale ledger. Absent → reconciliation skipped.
   */
  listChainWritesForSurf?: (metabotId: number) => Array<{
    pinId: string;
    path: string | null;
    contentText: string | null;
  }>;
  registry?: SurfProtocolDescriptor[];
  nowMs?: () => number;
  /**
   * Fresh-install deferral (see libs/installAgeGate): returns a one-line
   * reason while background automation must stay off (a brand-new install's
   * first 24h), else null. Only the PRE-DREAM path consults it — a manual
   * surf is a user action. Absent → never deferred.
   */
  backgroundDeferral?: () => string | null;
  /**
   * Bot identity for the deterministic inbox (R3): the interactions API
   * accepts an address, metaId or globalMetaId as owner. Absent → no inbox
   * section (the prompt degrades to one line).
   */
  getBotIdentity?: (metabotId: number) => { address?: string | null; globalMetaId?: string | null } | null;
  /**
   * Deterministic inbox fetcher (R3): likes/comments on the bot's pins plus
   * answers to its questions since `sinceTs` (the previous run's START —
   * an interaction arriving mid-run must surface next run, so the baseline
   * is the run row's createdAt, NOT its finishedAt).
   */
  fetchSurfInbox?: (input: { owner: string; sinceTs: number }) => Promise<SurfInboxItem[]>;
  /**
   * Reception (P0b): the bot's own recent posts (any order; the briefing
   * windows/caps/sorts). Absent → no reception section.
   */
  listOwnPostsForSurfReception?: (metabotId: number) => Array<{ pinId: string; title: string; postedAtMs: number }>;
  /**
   * Reception counts fetcher (P0b): interactions targeting the given pinIds
   * since sinceTs (unix seconds). Absent → reception renders with unknown
   * counts when own posts exist.
   */
  fetchSurfReception?: (input: { owner: string; sinceTs: number; pinIds: string[] }) => Promise<Array<{ pinId: string; interactions: number }>>;
  /**
   * Dream review P3: pre-flight model-binding validation (host-wired to the
   * cowork runner's route probe). Surf sessions are unattended orchestrator
   * turns — a stale binding used to create an orphan [编排任务] session plus
   * its ~49k-char prompt EVERY night before failing at turn time (13/13
   * pre-dream failures in dev data). The check runs BEFORE any session
   * exists; a failure fails the run row without creating a session.
   * Absent → no check (tests, digest-only harnesses).
   */
  checkModelBinding?: (metabotId: number) => { ok: boolean; reason: string | null };
  /** Protocol radar fetcher (R6): newest registered /protocols/* declarations. */
  fetchProtocolRadar?: () => Promise<SurfProtocolRadarFetchResult>;
  /** Hot posts fetcher (P2b): engagement-ranked items; errors land in hotPosts.error. */
  fetchHotPosts?: () => Promise<SurfHotPostItem[]>;
  /**
   * P2a: the bot's latest dream diary (daily_summary text), feeding the
   * dream→create handoff — the overnight reflection rides into the next surf
   * prompt. Absent → no dream section.
   */
  getLatestDreamDigest?: (metabotId: number) => string | null;
  /**
   * Second source of truth for the rendered report (2026-11-18): absolute
   * directory receiving one `<YYYY-MM-DD>-<runId>.md` per finished run
   * (`<userData>/daily-reports/surf` in production). Absent → no disk copy
   * (tests/harnesses) — the store row stays the only record.
   */
  reportDir?: string;
}

export class SurfService {
  private readonly store: MetawebSurfStore;
  private readonly metabotStore: SurfMetabotStoreLike;
  private readonly broadcast: (payload: SurfStatusEvent) => void;
  private readonly runSurfSession?: (context: SurfSessionContext) => Promise<SurfSessionResult>;
  private readonly isMemoryEnabled?: (metabotId: number) => boolean;
  private readonly listChainWritesForSurf?: SurfServiceDeps['listChainWritesForSurf'];
  private readonly registry: SurfProtocolDescriptor[];
  private readonly nowMs: () => number;
  private readonly getBotIdentity?: SurfServiceDeps['getBotIdentity'];
  private readonly fetchSurfInbox?: SurfServiceDeps['fetchSurfInbox'];
  private readonly listOwnPostsForSurfReception?: SurfServiceDeps['listOwnPostsForSurfReception'];
  private readonly fetchSurfReception?: SurfServiceDeps['fetchSurfReception'];
  private readonly fetchProtocolRadar?: SurfServiceDeps['fetchProtocolRadar'];
  private readonly fetchHotPosts?: SurfServiceDeps['fetchHotPosts'];
  private readonly getLatestDreamDigest?: SurfServiceDeps['getLatestDreamDigest'];
  private readonly reportDir?: string;
  private readonly runningByMetabot = new Map<number, string>();
  private readonly backgroundDeferral?: SurfServiceDeps['backgroundDeferral'];
  private readonly checkModelBinding?: SurfServiceDeps['checkModelBinding'];
  /**
   * Dream review P3: pre-dream surf skips caused by a stale model binding —
   * one entry per bot, cleared as soon as the binding resolves again. The
   * dream fires once per night, so the gate re-validates on every call; the
   * map preserves the skip reason for the night's telemetry.
   */
  private preDreamBindingSkips = new Map<number, string>();
  /** One-line "deferred" log latch (see shouldPreDreamSurf). */
  private deferralLogged = false;

  constructor(deps: SurfServiceDeps) {
    this.store = deps.store;
    this.metabotStore = deps.metabotStore;
    this.broadcast = deps.broadcast;
    this.runSurfSession = deps.runSurfSession;
    this.isMemoryEnabled = deps.isMemoryEnabled;
    this.listChainWritesForSurf = deps.listChainWritesForSurf;
    this.backgroundDeferral = deps.backgroundDeferral;
    this.registry = deps.registry ?? DEFAULT_SURF_PROTOCOLS;
    this.nowMs = deps.nowMs ?? (() => Date.now());
    this.getBotIdentity = deps.getBotIdentity;
    this.fetchSurfInbox = deps.fetchSurfInbox;
    this.listOwnPostsForSurfReception = deps.listOwnPostsForSurfReception;
    this.fetchSurfReception = deps.fetchSurfReception;
    this.fetchProtocolRadar = deps.fetchProtocolRadar;
    this.fetchHotPosts = deps.fetchHotPosts;
    this.getLatestDreamDigest = deps.getLatestDreamDigest;
    this.reportDir = deps.reportDir?.trim() ? deps.reportDir : undefined;
    this.checkModelBinding = deps.checkModelBinding;
  }

  /**
   * Dream review P3: the pre-dream surf's binding gate. Validates the bot's
   * model binding; on failure records the skip (one per bot) and returns the
   * reason so the host can log it and mark the dream telemetry surfSkipped.
   * A later call re-validates — once the binding resolves the skip clears
   * and surfing resumes. A throwing/absent checker never blocks the surf.
   */
  preDreamModelBindingGate(metabotId: number): { ok: boolean; reason: string | null } {
    if (!this.checkModelBinding) return { ok: true, reason: null };
    let result: { ok: boolean; reason: string | null } | null = null;
    try {
      result = this.checkModelBinding(metabotId) ?? null;
    } catch {
      return { ok: true, reason: null };
    }
    if (result?.ok) {
      this.preDreamBindingSkips.delete(metabotId);
      return { ok: true, reason: null };
    }
    const reason = (result?.reason ?? '').trim() || 'model binding unresolved';
    this.preDreamBindingSkips.set(metabotId, reason);
    return { ok: false, reason };
  }

  /** The currently recorded binding-skip reason for one bot (telemetry/tests). */
  preDreamBindingSkipReason(metabotId: number): string | null {
    return this.preDreamBindingSkips.get(metabotId) ?? null;
  }

  /** Crash recovery at startup: runs orphaned by a killed process become failed. */
  recoverAfterRestart(excludeRunId?: string): number {
    return this.store.failStaleRunningRuns({
      error: 'App restarted during surf run',
      nowIso: new Date(this.nowMs()).toISOString(),
      excludeId: excludeRunId,
    });
  }

  isRunning(metabotId: number): boolean {
    return this.runningByMetabot.has(metabotId);
  }

  /**
   * The notes the bot wrote to itself in its last DONE run (round 3): read
   * back out of reportJson so the next surf inherits its hard-won lessons.
   * Best-effort — a missing/malformed note must never block a run.
   */
  private latestSurfNotes(metabotId: number): string | null {
    try {
      const latest = this.store.getLatestFinishedRun(metabotId);
      return extractSurfNotesFromReportJson(latest?.reportJson ?? null);
    } catch {
      return null;
    }
  }

  /** Longest dream-diary excerpt carried into the prompt (prompt-bloat cap). */
  private latestDreamDigest(metabotId: number): string | null {
    try {
      const text = this.getLatestDreamDigest?.(metabotId) ?? null;
      const trimmed = (text ?? '').trim();
      return trimmed ? trimmed.slice(0, SURF_DREAM_DIGEST_MAX_CHARS) : null;
    } catch {
      return null;
    }
  }

  /**
   * Backfill the seen ledger from the local chain-writes ledger (round 3):
   * every own write is a 'posted' receipt and every extractable interaction
   * payload yields its target receipt. Strongest-wins batching makes this a
   * no-op when the ledger is already current. Best-effort — a sick writes
   * ledger must not block a surf run.
   */
  private reconcileSeenLedger(metabotId: number): void {
    if (!this.listChainWritesForSurf) return;
    try {
      const rows = this.listChainWritesForSurf(metabotId);
      const receipts = rows.flatMap((row) => surfReceiptsFromChainWriteRecord(row));
      if (receipts.length > 0) {
        this.store.markSeenBatch(metabotId, receipts, new Date(this.nowMs()).toISOString());
      }
    } catch {
      // Reconciliation is insurance, never a run blocker.
    }
  }

  /**
   * Pre-dream gate: the bot's surf-before-dream setting is enabled (default
   * ON since 2026-09-28; an explicit '0' opts the bot out) and it has not
   * finished a surf within the recency window (a manual evening surf makes
   * the nightly one redundant).
   */
  shouldPreDreamSurf(metabotId: number): boolean {
    if (!isSurfBeforeDreamEnabled(this.metabotStore, metabotId)) return false;
    if (this.isRunning(metabotId)) return false;
    // Fresh-install deferral: the pre-dream surf is part of the nightly
    // pipeline, so it waits out the window with the dream it belongs to.
    // Checked here (not only in the dream tick) so no future caller can
    // bypass the gate.
    const deferredReason = this.backgroundDeferral?.() ?? null;
    if (deferredReason) {
      if (!this.deferralLogged) {
        this.deferralLogged = true;
        console.log(`[SurfService] Pre-dream surf deferred: ${deferredReason}`);
      }
      return false;
    }
    this.deferralLogged = false;
    try {
      // A bot without memory learns nothing from surfing — skip quietly here
      // (the dream proceeds either way); manual triggers fail loudly instead.
      if (this.isMemoryEnabled?.(metabotId) === false) return false;
    } catch {
      return false;
    }
    const latest = this.store.getLatestFinishedRun(metabotId);
    if (!latest?.finishedAt) return true;
    const finishedMs = Date.parse(latest.finishedAt);
    if (!Number.isFinite(finishedMs)) return true;
    return this.nowMs() - finishedMs >= PRE_DREAM_SURF_RECENCY_MS;
  }

  /**
   * Start a surf run in the background; returns the created run row.
   * Throws when the bot does not exist or a run is already in flight.
   */
  startSurf(metabotId: number, trigger: MetawebSurfTrigger): MetawebSurfRunRecord {
    const run = this.beginRun(metabotId, trigger);
    void this.executeRun(run.id).catch(() => {
      // executeRun records failures on the run row itself; this catch only
      // guards against bugs in the failure-recording path.
    });
    return run;
  }

  /** Awaitable variant for the pre-dream pipeline. */
  async runSurfAndWait(metabotId: number, trigger: MetawebSurfTrigger): Promise<MetawebSurfRunRecord> {
    const run = this.beginRun(metabotId, trigger);
    await this.executeRun(run.id).catch(() => undefined);
    return this.store.getRun(run.id) ?? run;
  }

  private beginRun(metabotId: number, trigger: MetawebSurfTrigger): MetawebSurfRunRecord {
    const bot = this.metabotStore.getMetabotById(metabotId);
    if (!bot) throw new Error(`MetaBot ${metabotId} not found`);
    // Only pre-dream is memory-gated (same gate as dreaming). Manual triggers
    // run DEGRADED with memory off (owner decision — review 2 item 9, option
    // B / plan §4.7): the session then has no KB/memory tools and the prompt
    // says so, but the bot can still browse, engage, and handle its inbox.
    if (trigger === 'pre-dream' && this.isMemoryEnabled?.(metabotId) === false) {
      throw new Error('Pre-dream surf requires memory enabled (same gate as dreaming).');
    }
    if (this.runningByMetabot.has(metabotId)) {
      throw new Error('A surf run is already in progress for this bot');
    }
    const nowIso = new Date(this.nowMs()).toISOString();
    const run = this.store.createRun({ id: randomUUID(), metabotId, trigger, nowIso });
    this.runningByMetabot.set(metabotId, run.id);
    this.broadcast({ metabotId, runId: run.id, trigger, status: 'running' });
    return run;
  }

  private async executeRun(runId: string): Promise<void> {
    const run = this.store.getRun(runId);
    if (!run) return;
    const { metabotId, trigger } = run;
    const bot = this.metabotStore.getMetabotById(metabotId);
    const finish = (outcome: 'done' | 'failed', error: string | null) => {
      this.broadcast({ metabotId, runId, trigger, status: outcome, error });
      this.runningByMetabot.delete(metabotId);
    };
    let fetchedCount = 0;
    try {
      // Reconcile the seen ledger against the local chain-writes ledger first
      // (round 3): receipts lost to a crash/kill mid-run or a stopped orphan
      // session are re-derived locally — the duplicate-interaction guard must
      // never work off a stale ledger. Idempotent (strongest-wins batching).
      this.reconcileSeenLedger(metabotId);
      // Dream review P3: validate the model binding BEFORE any cowork
      // session exists — every trigger (pre-dream, manual, scheduled) shares
      // this guard, so a stale binding can no longer mint orphan [编排任务]
      // sessions. The run fails on its row with the binding reason instead.
      if (this.checkModelBinding) {
        let binding: { ok: boolean; reason: string | null } = { ok: true, reason: null };
        try {
          binding = this.checkModelBinding(metabotId) ?? binding;
        } catch {
          // A broken checker must never block a surf.
        }
        if (!binding.ok) {
          throw new Error(`Surf model binding stale: ${(binding.reason ?? '').trim() || 'unresolved'}`);
        }
      }
      const budget = getSurfInteractionBudget(this.metabotStore, metabotId);
      const creationBudget = getSurfCreationBudget(this.metabotStore, metabotId);
      const creationMode = getSurfCreationMode(this.metabotStore, metabotId);
      // Inbox/radar baseline: the START of the latest finished run (its
      // createdAt — NOT finishedAt: an interaction arriving mid-run must
      // surface on the NEXT run). No finished run yet → the briefing's
      // first-lookback default applies (inboxBaselineTs stays undefined).
      let inboxBaselineTs: number | undefined;
      const latestFinished = this.store.getLatestFinishedRun(metabotId);
      if (latestFinished?.createdAt) {
        const parsedMs = Date.parse(latestFinished.createdAt);
        if (Number.isFinite(parsedMs)) inboxBaselineTs = Math.floor(parsedMs / 1000);
      }
      const identity = this.getBotIdentity?.(metabotId) ?? null;
      const owner = (identity?.address ?? '').trim() || (identity?.globalMetaId ?? '').trim() || null;
      // Reception (P0b): own recent posts + their interaction counts — the
      // reward signal that closes the create-loop. Best-effort like the inbox:
      // missing deps or a sick backend degrades the section, never the run.
      let ownPosts: Array<{ pinId: string; title: string; postedAtMs: number }> | undefined;
      try {
        ownPosts = this.listOwnPostsForSurfReception?.(metabotId);
      } catch {
        ownPosts = undefined;
      }
      const receptionOwner = owner;
      const briefing = await buildSurfBriefing({
        store: this.store,
        metabotId,
        interactionBudget: budget,
        creationBudget,
        creationMode,
        registry: this.registry,
        nowMs: this.nowMs(),
        inboxBaselineTs,
        fetchInbox: this.fetchSurfInbox && owner
          ? ({ sinceTs }) => this.fetchSurfInbox!({ owner: owner!, sinceTs })
          : undefined,
        ownPosts,
        fetchReception: receptionOwner && ownPosts && ownPosts.length > 0 && this.fetchSurfReception
          ? ({ sinceTs, pinIds }) => this.fetchSurfReception!({ owner: receptionOwner, sinceTs, pinIds })
          : undefined,
        fetchProtocolRadar: this.fetchProtocolRadar,
        fetchHotPosts: this.fetchHotPosts,
      });
      fetchedCount = briefing.items.length;

      const stats: MetawebSurfRunStats = { ...emptySurfRunStats(), fetched: briefing.items.length };
      let reportMarkdown: string | null = null;
      let reportJson: string | null = null;
      const sessionSeenActions: Array<{ pinId: string; action: MetawebSurfSeenAction }> = [];
      // Empty-briefing skip (nightly-token audit 2026-10-25): only the
      // unattended pre-dream path — a manual trigger is the owner asking for
      // a surf and always runs. The run still completes as digest-only below
      // (watermarks advance, briefing digest recorded, recency dedupe holds),
      // and with no report the same night's dream sees no surf activity.
      const sessionSkipped = trigger === 'pre-dream'
        && this.runSurfSession != null
        && surfBriefingHasNoWork(briefing);
      if (sessionSkipped) {
        stats.sessionSkipped = 1;
        console.log(
          `[SurfService] Pre-dream surf for metabot ${metabotId}: empty briefing (no unseen items, empty inbox) — LLM session skipped, digest-only run.`,
        );
      }
      if (this.runSurfSession && !sessionSkipped) {
        const session = await this.runSurfSession({
          runId,
          metabotId,
          botName: bot?.name ?? `Bot ${metabotId}`,
          trigger,
          briefing,
          previousNotes: this.latestSurfNotes(metabotId),
          dreamDigest: this.latestDreamDigest(metabotId),
        });
        Object.assign(stats, session.stats ?? {});
        reportMarkdown = session.reportMarkdown ?? null;
        reportJson = session.reportJson ?? null;
        sessionSeenActions.push(...(session.seenActions ?? []));
      }

      // Live-audit round 1 (2026-09-17): 3 of 57 live runs returned with NO
      // final report AND no host-verifiable activity (zero deep reads, zero
      // chain-write receipts, zero scheduled tasks — consistent with a
      // silently truncated turn), yet still reached this success path:
      // briefed pins were marked 'presented' and never re-presented. A
      // session that provably did nothing must not consume the window — fail
      // the run so the next surf re-presents it, same as any other failure.
      if (this.runSurfSession && !sessionSkipped) {
        const sessionDidSomething = reportJson != null
          || reportMarkdown != null
          || stats.deepRead > 0
          || stats.savedToKb > 0
          || stats.knowledgePoints > 0
          || stats.liked > 0
          || stats.commented > 0
          || stats.answered > 0
          || stats.posted > 0
          || stats.challenged > 0
          || stats.inboxHandled > 0
          || stats.tasksScheduled > 0;
        if (!sessionDidSomething) {
          throw new Error('Surf session ended without a report and without any host-verifiable activity (no reads, writes or tasks) — the window stays unconsumed; possible silent turn truncation.');
        }
      }

      // Host-computed after the session merge (session stats never carry it):
      // how many inbox items the deterministic section presented tonight.
      // Separates "inbox was empty" from "inboxHandled 0 because nothing
      // needed a reply" — indistinguishable in live data until now.
      stats.inboxPresented = briefing.inbox && !briefing.inbox.error
        ? briefing.inbox.items.length
        : 0;

      // Seen-ledger writes land ONLY on this success path: every briefed pin
      // becomes 'presented' and the session's self-reported actions fold on
      // top (strongest action wins, one batched store write). Presented
      // inbox items join the same batch — the ledger is what guarantees the
      // deterministic inbox presents each interaction exactly once.
      // A run that fails before this point leaves the ledger untouched, so
      // the next surf re-presents the same window — one bad night (LLM
      // timeout, outage) never silently drops that content (review P1).
      const nowIso = new Date(this.nowMs()).toISOString();
      this.store.markSeenBatch(metabotId, [
        ...briefing.items.map((item) => ({ pinId: item.pinId, action: 'presented' as const })),
        ...(briefing.inbox && !briefing.inbox.error
          ? briefing.inbox.items.map((item) => ({ pinId: item.pinId, action: 'presented' as const }))
          : []),
        ...sessionSeenActions,
      ], nowIso);

      // Watermarks/cursors advance only after the run body completed, and
      // only for sections with a usable action (fetch errors preserve their
      // old state so the next surf retries them). Backlog pages move ONLY
      // the cursor — never the watermark.
      for (const section of briefing.protocols) {
        if (section.error) continue;
        if (section.nextWatermarkTs !== null) {
          this.store.advanceProtocolState(metabotId, section.key, {
            lastSeenTs: section.nextWatermarkTs,
            lastPinId: null,
            nowIso,
            backlogCursor: section.backlogCursorAction === 'store'
              ? section.backlogCursor
              : section.backlogCursorAction === 'clear' ? null : undefined,
          });
        } else if (section.backlogCursorAction !== 'preserve') {
          this.store.advanceProtocolState(metabotId, section.key, {
            lastSeenTs: null,
            nowIso,
            backlogCursor: section.backlogCursorAction === 'store'
              ? section.backlogCursor
              : section.backlogCursorAction === 'clear' ? null : undefined,
          });
        }
      }
      this.store.pruneSeenPins(metabotId, nowIso);

      // Live-audit round 1: the digest used to be appended to
      // report_markdown, where the 20k report cap silently cut its tail
      // (inbox/radar sections vanished mid-pin-id). It now lives in its own
      // column under a larger cap; the report stays report-only.
      const digest = renderSurfBriefingMarkdown(briefing);
      this.store.finishRun(runId, {
        status: 'done',
        stats,
        reportMarkdown,
        briefingMarkdown: digest,
        reportJson,
        finishedAtIso: nowIso,
      });
      // Second source of truth (2026-11-18): sqlite was the ONLY place the
      // rendered report lived, and the 20k store cap silently cut its tail.
      // The same markdown now also lands on disk best-effort — a failed write
      // never blocks or fails the run (the row stays authoritative).
      this.persistReportToDisk({ runId, finishedAtMs: this.nowMs(), markdown: reportMarkdown });
      finish('done', null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Round 3: a failed run keeps the REAL numbers the host can vouch for
      // (fetched from the briefing; deep reads / KB adds / chain interactions
      // attached to the session error by main.ts runSurfSession) instead of
      // the historical all-zero stats.
      const partial = (error as { surfPartialStats?: Partial<MetawebSurfRunStats> } | null)?.surfPartialStats;
      this.store.finishRun(runId, {
        status: 'failed',
        stats: { ...emptySurfRunStats(), fetched: fetchedCount, ...(partial ?? {}) },
        error: message,
        finishedAtIso: new Date(this.nowMs()).toISOString(),
      });
      finish('failed', message);
    }
  }

  /**
   * Best-effort markdown copy of the report next to the store record
   * (2026-11-18): `metaweb_surf_runs.report_markdown` was the only copy of the
   * rendered report, and its 20k cap silently cut the tail. This writes
   * `<reportDir>/<YYYY-MM-DD>-<runId>.md`; when the store's copy was clamped,
   * the file carries the FULL report and a header saying the row is the
   * truncated copy (the stored row itself is never changed).
   *
   * Contract: never throws and never writes outside `reportDir`. A missing
   * `reportDir` (tests, harnesses) or an empty report means "no file", not an
   * error — the run has already succeeded at this point.
   */
  private persistReportToDisk(input: { runId: string; finishedAtMs: number; markdown: string | null }): void {
    const dir = this.reportDir;
    if (!dir) return;
    const markdown = typeof input.markdown === 'string' ? input.markdown : '';
    if (!markdown.trim()) return;
    try {
      const stored = this.store.getRun(input.runId)?.reportMarkdown ?? null;
      const storeIsTruncated = typeof stored === 'string' && stored.length < markdown.length;
      const header = storeIsTruncated
        ? [
            '> [!NOTE] store copy truncated',
            `> metaweb_surf_runs.report_markdown holds ${stored!.length} of the full ${markdown.length} chars (the store cap cut the tail).`,
            '> This file is the full report; the stored row is unchanged.',
            '',
            '',
          ].join('\n')
        : '';
      fs.mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, `${formatLocalDateKey(input.finishedAtMs)}-${input.runId}.md`);
      fs.writeFileSync(filePath, `${header}${markdown}`, 'utf8');
    } catch (error) {
      console.warn(
        '[Surf] report disk write failed (best effort — the run row remains authoritative):',
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
