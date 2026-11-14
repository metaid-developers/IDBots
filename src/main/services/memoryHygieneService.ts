import type { CoworkStore } from '../coworkStore';
import type { DreamStore } from '../dreamStore';
import type { MetaIDExperienceStore } from '../metaidExperienceStore';
import type { MetaIDImpressionStore } from '../metaidImpressionStore';
import type { MetaIDKnowledgeStore } from '../metaidKnowledgeStore';
import type { TeamCultureStore } from '../teamCultureStore';
import { formatBotWorkspaceDate } from '../libs/botWorkspace';
import {
  isMemoryHygieneRunTimeDue,
  type MemoryHygieneConfig,
  type MemoryHygieneRunStats,
} from '../libs/memoryHygienePolicy';
import {
  buildDeepConsolidationPrompt,
  deepConsolidationRetireCap,
  describeDeepConsolidationParseFailure,
  parseDeepConsolidationOutput,
  shouldRunDeepConsolidation,
  type DeepConsolidationInventoryItem,
} from '../libs/deepConsolidationPrompt';
import { resolveDreamAttemptTimeoutMs } from '../libs/dreamRetryPolicy';
import { FALSIFIED_MAX_PER_BOT, FALSIFIED_RETENTION_DAYS } from '../libs/capabilityGateRegularizers';
import { HOT_LAYER_USAGE_RETENTION_DAYS } from '../coworkStore';
import { metabotBrainOptions } from './llmFallback';
import type { StandingPageStore } from '../standingPageStore';
import type { MetawebSurfStore } from '../metawebSurfStore';
import type { ChainContentHistoryStore } from '../chainContentHistoryStore';
import {
  STANDING_PAGE_MAX_OUTPUT_TOKENS,
  buildStandingPageRefreshPrompt,
  parseStandingPageRefreshOutput,
  sampleStandingPageScope,
} from '../libs/standingPageRefresh';

/**
 * Memory hygiene service — the nightly deterministic "compression stroke".
 *
 * The dream pass abstracts raw experience into summaries, memories,
 * impressions and knowledge. This service retires what nothing will read
 * again: supersede stale impression observations, soft-archive old episodes
 * and decayed dream memories, prune knowledge-revision overflow and purge
 * low-risk tombstones. LLM-free and fully deterministic; every step is
 * isolated so one failure never blocks the others, and nothing here can
 * interfere with the dream pipeline (worst case a step retries next night).
 *
 * Scheduling: one pass per local date, eligible from 04:00 (late in the dream
 * window so nightly dreams finish first) and any time later as catch-up.
 * Manual runs (settings UI / IPC) bypass every gate.
 */

const HYGIENE_TICK_INTERVAL_MS = 60_000;
const HYGIENE_STATUS_CHANNEL = 'memoryHygiene:statusChanged';
// The per-attempt LLM window rides the shared dream attempt-timeout ladder
// (resolveDreamAttemptTimeoutMs): consolidation prompts carry up to ~160
// belief-layer rows + 60 knowledge entries and emit up to a 12K-token JSON
// at flash-tier generation speed, so legitimate calls run 8-38 minutes. The
// 2026-09-23 04:00 run timed out on bots 22 and 10 under the pre-fix build
// (GLM thinking toggle dropped upstream; the low-effort mapping a5681845
// shrinks the output, but throttled generation still exceeded the old fixed
// 180s/600s walls). A failed pass leaves the cadence unstamped, so the bot
// retries on the next pass — that pass is attempt+1 and resolves the next
// tier, exactly like a retried dream run. Tiers: 10 / 20 / 38 minutes by
// consecutive failing passes; the top tier is sized from the worst measured
// legitimate call, so only a genuinely stalled call aborts to the fallback.

// Explicit output budget for the consolidation JSON. The transport default
// for thinking-disabled calls (4_096) truncated real inventories mid-JSON
// (bots with 150+ belief-layer rows hit "unparseable output" on 2026-09-02);
// 12_288 keeps 2-3x headroom over observed well-formed proposals while
// staying inside the deepseek catalog caps (flash 32_768 / pro 16_000).
const DEEP_CONSOLIDATION_MAX_OUTPUT_TOKENS = 12_288;

export interface MemoryHygieneMetabotLike {
  id: number;
  name?: string | null;
  llm_id?: string | null;
  /** Provider key the brain model was picked from (id-collision disambiguation). */
  llm_provider?: string | null;
  /** Secondary brain retried once when the primary brain errors mid-call. */
  fallback_llm_id?: string | null;
  fallback_llm_provider?: string | null;
  globalmetaid?: string | null;
  enabled?: boolean;
}

export interface MemoryHygieneMetabotStoreLike {
  listMetabots(): MemoryHygieneMetabotLike[];
}

/** Shared context handed to every step; steps are added one per commit. */
export interface MemoryHygieneRunContext {
  config: MemoryHygieneConfig;
  nowMs: number;
  /** Owner GlobalMetaIDs of bots whose per-bot policy opted out of hygiene. */
  disabledOwners: ReadonlySet<string>;
  /** MetaBot ids of the same opt-out set (stores keyed by metabot_id). */
  disabledMetabotIds: ReadonlySet<number>;
  coworkStore: CoworkStore;
  dreamStore?: DreamStore;
  experienceStore?: MetaIDExperienceStore;
  impressionStore?: MetaIDImpressionStore;
  knowledgeStore?: MetaIDKnowledgeStore;
  cultureStore?: TeamCultureStore;
  standingPageStore?: StandingPageStore;
  surfStore?: MetawebSurfStore;
  chainHistoryStore?: ChainContentHistoryStore;
}

/** Steps return flat counters, or { counts, errors } when they collect
 *  non-fatal diagnostics the stats view should surface. */
interface MemoryHygieneStep {
  name: string;
  run: (context: MemoryHygieneRunContext) =>
    | Promise<Record<string, number>>
    | Record<string, number>
    | Promise<{ counts: Record<string, number>; errors?: string[] }>
    | { counts: Record<string, number>; errors?: string[] };
}

export type MemoryHygienePerformChat = (
  systemPrompt: string,
  userMessage: string,
  llmId?: string | null,
  options?: {
    signal?: AbortSignal;
    maxTokens?: number;
    thinking?: 'enabled' | 'disabled';
    /** Pass false: a stray built-in web search derails the JSON contract. */
    webSearch?: boolean;
    /** Provider key the brain model was picked from (id-collision disambiguation). */
    llmProvider?: string | null;
    /** Secondary brain retried once when the primary brain errors mid-call. */
    fallbackLlmId?: string | null;
    fallbackLlmProvider?: string | null;
    /** Per-attempt timeout: primary and fallback each get a fresh window. */
    attemptTimeoutMs?: number;
  }
) => Promise<string>;

export interface MemoryHygieneDeps {
  coworkStore: CoworkStore;
  metabotStore: MemoryHygieneMetabotStoreLike;
  dreamStore?: DreamStore;
  metaidExperienceStore?: MetaIDExperienceStore;
  metaidImpressionStore?: MetaIDImpressionStore;
  metaidKnowledgeStore?: MetaIDKnowledgeStore;
  metaidCultureStore?: TeamCultureStore;
  /** Required only for the standing-pages step; absent = step no-ops. */
  standingPageStore?: StandingPageStore;
  metawebSurfStore?: MetawebSurfStore;
  chainContentHistoryStore?: ChainContentHistoryStore;
  /** Required only for the deep-consolidation step; absent = step no-ops. */
  performChat?: MemoryHygienePerformChat;
  tickIntervalMs?: number;
  now?: () => Date;
  emitToRenderer?: (channel: string, payload: unknown) => void;
}

export class MemoryHygieneService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private stopped = false;

  /** Steps registered by later commits (observation compaction, episode archival, …). */
  protected readonly steps: MemoryHygieneStep[] = [];

  constructor(private readonly deps: MemoryHygieneDeps) {
    this.registerSteps();
  }

  /** One entry per compaction mechanism; each is error-isolated by runAll. */
  protected registerSteps(): void {
    // Impression observations: supersede stale ones past the per-pair anchors;
    // the snapshot survives as the compressed state.
    this.steps.push({
      name: 'impression-observations',
      run: (context) => {
        if (!context.impressionStore) return {};
        const result = context.impressionStore.compactObservations({
          cutoffMs: context.nowMs - context.config.observationRetentionDays * 86_400_000,
          anchorsPerPair: context.config.observationAnchorsPerPair,
          excludeObservers: context.disabledOwners,
        });
        return {
          observationPairsCompacted: result.pairsCompacted,
          observationsSuperseded: result.observationsSuperseded,
          observationSnapshotsRebuilt: result.snapshotsRebuilt,
        };
      },
    });
    // Episodes: reconcile open rows whose source (order / task) already
    // reached a terminal state, or whose conversation went long-dormant —
    // live event wiring is best-effort and missed terminal transitions
    // otherwise stay 'open' forever (invisible to the archive stroke
    // below, which only touches terminal rows). Then soft-archive
    // terminal episodes past the retention horizon so dream candidates /
    // contact views / cognition context stop scanning them; explicit
    // experience_recall keeps them visible with an (archived) mark.
    this.steps.push({
      name: 'episodes',
      run: (context) => {
        if (!context.experienceStore) return {};
        const settled = context.experienceStore.reconcileOpenEpisodes({
          nowMs: context.nowMs,
          dormantCutoffMs: context.nowMs - context.config.episodeArchiveDays * 86_400_000,
          excludeOwners: context.disabledOwners,
        });
        const archived = context.experienceStore.archiveEpisodes({
          cutoffMs: context.nowMs - context.config.episodeArchiveDays * 86_400_000,
          archivedAt: context.nowMs,
          excludeOwners: context.disabledOwners,
        });
        return {
          episodesReconciled: settled.serviceOrdersSettled + settled.taskEpisodesSettled,
          dormantInteractionsClosed: settled.dormantInteractionsClosed,
          episodesArchived: archived,
        };
      },
    });
    // Dream memories: decay-archive entries untouched past the horizon
    // (self_identity and conversation-origin rows never auto-archive), then
    // physically purge tombstones that outlived the grace period — the one
    // low-risk delete in the memory layer.
    this.steps.push({
      name: 'dream-memories',
      run: (context) => {
        const archived = context.coworkStore.archiveDecayedDreamMemories({
          cutoffMs: context.nowMs - context.config.memoryDecayDays * 86_400_000,
          archivedAt: context.nowMs,
          excludeMetabotIds: context.disabledMetabotIds,
        });
        const purged = context.coworkStore.purgeDeletedMemoryTombstones({
          cutoffMs: context.nowMs - context.config.tombstonePurgeDays * 86_400_000,
          excludeMetabotIds: context.disabledMetabotIds,
        });
        return { memoriesArchived: archived, tombstonesPurged: purged };
      },
    });
    // Knowledge revision overflow: keep the newest N historical revisions per
    // entry, physically remove older redundant copies.
    this.steps.push({
      name: 'knowledge-revisions',
      run: (context) => {
        if (!context.knowledgeStore) return {};
        const result = context.knowledgeStore.pruneKnowledgeRevisions({
          keepPerEntry: context.config.knowledgeRevisionKeep,
          excludeMetabotIds: context.disabledMetabotIds,
        });
        return { knowledgeRevisionsPruned: result.revisionsDeleted };
      },
    });
    // Dream bookkeeping: completed runs and fragment caches past the horizon
    // are pure history (the scheduler only looks back 7 days).
    this.steps.push({
      name: 'dream-runs',
      run: (context) => {
        if (!context.dreamStore) return {};
        const result = context.dreamStore.purgeOldRunsAndFragments({
          cutoffDateKey: formatBotWorkspaceDate(
            new Date(context.nowMs - context.config.dreamRunRetentionDays * 86_400_000)
          ),
          excludeMetabotIds: context.disabledMetabotIds,
        });
        return { dreamRunsPurged: result.runsDeleted, dreamFragmentsPurged: result.fragmentsDeleted };
      },
    });
    // Capability drafts (L3b): 'rejected' and never-validated 'draft' rows
    // past the retention horizon are physically deleted. These are dream
    // BOOKKEEPING rows (verdict candidates and their corpses), not user
    // memories — the capability they described survives in the night's diary.
    // 'validated' drafts never age out here; their quality control is the
    // periodic re-review in dreamService.
    this.steps.push({
      name: 'capability-drafts',
      run: (context) => {
        const purged = context.coworkStore.purgeExpiredCapabilityDrafts({
          cutoffMs: context.nowMs - context.config.capabilityDraftRetentionDays * 86_400_000,
          excludeMetabotIds: context.disabledMetabotIds,
        });
        return { capabilityDraftsPurged: purged };
      },
    });
    // Falsified-hypothesis ledger (RRSI P1, design §6.1 P1.3): dream
    // bookkeeping like rejected drafts — rows older than the retention
    // horizon drain and each bot keeps at most FALSIFIED_MAX_PER_BOT newest
    // rows. The retention is a constant, not a user setting.
    this.steps.push({
      name: 'capability-falsified',
      run: (context) => {
        const purged = context.coworkStore.purgeFalsifiedHypotheses({
          cutoffMs: context.nowMs - FALSIFIED_RETENTION_DAYS * 86_400_000,
          maxPerBot: FALSIFIED_MAX_PER_BOT,
          excludeMetabotIds: context.disabledMetabotIds,
        });
        return { capabilityFalsifiedPurged: purged };
      },
    });
    // Hot-layer exposure ledger (RRSI P2, design §6.2 P2.4): dream
    // bookkeeping — one row per item per day drains after the retention
    // horizon. Like the falsified retention, a constant, not a user setting.
    this.steps.push({
      name: 'hot-layer-usage',
      run: (context) => {
        const purged = context.coworkStore.purgeHotLayerUsage({
          cutoffDate: formatBotWorkspaceDate(
            new Date(context.nowMs - HOT_LAYER_USAGE_RETENTION_DAYS * 86_400_000)
          ),
          excludeMetabotIds: context.disabledMetabotIds,
        });
        return { hotLayerUsagePurged: purged };
      },
    });
    // Culture layer: emergent entries that stopped earning injection slots
    // decay to archived (owner entries never auto-archived); revision
    // overflow is pruned like knowledge revisions.
    this.steps.push({
      name: 'culture',
      run: (context) => {
        if (!context.cultureStore) return {};
        const decayed = context.cultureStore.archiveDecayedCulture({
          cutoffMs: context.nowMs - context.config.memoryDecayDays * 86_400_000,
          archivedAt: context.nowMs,
        });
        const pruned = context.cultureStore.pruneCultureRevisions({
          keepPerEntry: context.config.knowledgeRevisionKeep,
        });
        return { cultureEntriesDecayed: decayed, cultureRevisionsPruned: pruned };
      },
    });
    // Deep consolidation (the LLM side of the compression stroke): every N
    // days per bot, review the belief layer and retire/merge what aged out.
    // Proposals are validated against the listed inventory and applied via
    // reversible channels (memory archived_at mark / knowledge versioning).
    this.steps.push({
      name: 'deep-consolidation',
      run: async (context) => {
        if (!this.deps.performChat || !context.config.deepConsolidationEnabled) return { counts: {} };
        const intervalMs = context.config.deepConsolidationIntervalDays * 86_400_000;
        const errors: string[] = [];
        let botsConsidered = 0;
        let retiredMemories = 0;
        let rewrittenMemories = 0;
        let retiredKnowledge = 0;
        let rewrittenKnowledge = 0;
        const isoDate = (epochMs: number | null | undefined): string | undefined => {
          const value = Number(epochMs);
          if (!Number.isFinite(value) || value <= 0) return undefined;
          return new Date(value).toISOString().slice(0, 10);
        };
        for (const bot of this.deps.metabotStore.listMetabots()) {
          if (context.disabledMetabotIds.has(bot.id)) continue;
          // Align with the dream gate: no consolidation tokens for disabled bots.
          if (bot.enabled === false) continue;
          const lastRunAt = context.coworkStore.getDeepConsolidationLastRunAt(bot.id);
          if (lastRunAt != null && context.nowMs - lastRunAt < intervalMs) continue;

          const boundaries = context.coworkStore.listUserMemories({
            metabotId: bot.id,
            scopeKind: 'owner',
            scopeKey: 'owner:self',
            usageClass: 'value_boundary',
            status: 'created',
            limit: 50,
          });
          const reviews = context.coworkStore.listUserMemories({
            metabotId: bot.id,
            scopeKind: 'owner',
            scopeKey: 'owner:self',
            usageClass: 'work_review',
            status: 'created',
            limit: 50,
          });
          // Owner facts are where preference/state changes live ("used to X,
          // now Y"); conversation-origin rows ride along as read-only context
          // so the owner's own words can supersede a dream belief.
          const facts = context.coworkStore.listUserMemories({
            metabotId: bot.id,
            scopeKind: 'owner',
            scopeKey: 'owner:self',
            usageClass: 'profile_fact',
            status: 'created',
            limit: 50,
          });
          const knowledge = context.knowledgeStore
            ? context.knowledgeStore.listKnowledgeForDream(bot.id, 60)
            : [];
          const memories = [...boundaries, ...reviews, ...facts];
          const evidence = context.coworkStore.listUserMemoryEvidence(memories.map((memory) => memory.id));
          const toMemoryItem = (
            memory: (typeof memories)[number],
            kind: 'value_boundary' | 'work_review' | 'profile_fact',
          ): DeepConsolidationInventoryItem => ({
            id: memory.id,
            kind,
            text: memory.text,
            origin: memory.origin === 'dream' ? 'dream' : 'conversation',
            rewritable: memory.origin === 'dream',
            proofCount: evidence.get(memory.id)?.proofCount ?? 0,
            quotes: evidence.get(memory.id)?.quotes ?? [],
            firstSeen: isoDate(memory.createdAt),
            lastSeen: isoDate(memory.updatedAt),
            occurred: isoDate(memory.occurredAt),
          });
          const items: DeepConsolidationInventoryItem[] = [
            ...boundaries.map((memory) => toMemoryItem(memory, 'value_boundary')),
            ...reviews.map((memory) => toMemoryItem(memory, 'work_review')),
            ...facts.map((memory) => toMemoryItem(memory, 'profile_fact')),
            ...knowledge.map((entry) => ({
              id: entry.id,
              kind: 'knowledge' as const,
              text: `${entry.topic}: ${entry.summary}`,
              extra: `kind=${entry.kind}, v${entry.version}`,
            })),
          ];
          if (!shouldRunDeepConsolidation(items.length)) continue;
          botsConsidered += 1;

          // Consecutive failing passes for this bot — the hygiene analog of a
          // dream run's attemptCount (see the ladder note above); a clean pass
          // clears it.
          const attempts = context.coworkStore.getDeepConsolidationAttempts(bot.id);

          let raw: string;
          // The bot's full brain pair (provider hint + fallback brain), same
          // as every other per-bot automation path (dreams, A2A, group tasks).
          // A bare llm_id misresolves on cross-provider model-id collisions,
          // and without the fallback brain a single dead/unreachable primary
          // brain fails the bot's consolidation every pass.
          const brain = metabotBrainOptions(bot);
          const brainLabel = brain.llmId
            ? ` (brain ${brain.llmProvider ? `${brain.llmProvider}/` : ''}${brain.llmId})`
            : '';
          try {
            raw = await this.deps.performChat(
              'You are a memory consolidation assistant. Respond only with the requested JSON object.',
              buildDeepConsolidationPrompt({ botName: bot.name ?? `MetaBot ${bot.id}`, items }),
              brain.llmId,
              {
                thinking: 'disabled',
                // Per-attempt window: each brain gets its own fresh window,
                // escalating with the bot's consecutive failing passes.
                attemptTimeoutMs: resolveDreamAttemptTimeoutMs(attempts + 1),
                maxTokens: DEEP_CONSOLIDATION_MAX_OUTPUT_TOKENS,
                // The Responses-path default web_search injection turns this
                // into a search-plus-prose answer that blows the JSON budget.
                webSearch: false,
                llmProvider: brain.llmProvider,
                fallbackLlmId: brain.fallbackLlmId,
                fallbackLlmProvider: brain.fallbackLlmProvider,
              },
            );
          } catch (error) {
            // Name the brain in the surfaced error: a stale/removed model id
            // (upstream 400) is only actionable when the settings page shows
            // WHICH configured brain the endpoint rejected.
            errors.push(`deep-consolidation bot ${bot.id}${brainLabel}: ${error instanceof Error ? error.message : String(error)}`);
            // A failed pass bumps the attempt ladder so the next pass resolves
            // a wider window instead of re-hitting the same wall.
            context.coworkStore.setDeepConsolidationAttempts(bot.id, attempts + 1);
            continue;
          }
          const output = parseDeepConsolidationOutput(raw);
          if (!output) {
            errors.push(
              `deep-consolidation bot ${bot.id}: unparseable output (${describeDeepConsolidationParseFailure(raw)})`
            );
            context.coworkStore.setDeepConsolidationAttempts(bot.id, attempts + 1);
            continue;
          }
          const errorsBeforeApply = errors.length;

          const knowledgeIds = new Set(knowledge.map((entry) => entry.id));
          // Retire/rewrite protection aligned with the deterministic decay
          // stroke: only dream-origin rows are ever auto-archived or rewritten
          // — conversation-origin entries may carry the user's explicit
          // "remember this" and ride along as read-only context.
          const dreamMemoryIds = new Set(
            memories
              .filter((memory) => memory.origin === 'dream')
              .map((memory) => memory.id),
          );
          // One row, one action: a rewrite is the survivor of a merge, so an
          // id the model also lists for retirement keeps its (rewritten) row.
          const rewriteMemories = output.rewriteMemories.filter((rewrite) => dreamMemoryIds.has(rewrite.id));
          const rewriteMemoryIds = new Set(rewriteMemories.map((rewrite) => rewrite.id));
          const retireMemories = output.retireMemoryIds.filter((id) => dreamMemoryIds.has(id) && !rewriteMemoryIds.has(id));
          const retireKnowledge = output.retireKnowledgeIds.filter((id) => knowledgeIds.has(id));
          const rewrites = output.rewriteKnowledge.filter((rewrite) => knowledgeIds.has(rewrite.id));

          // Guardrail: a VALIDATED action list eating more than a quarter of
          // the belief layer in one pass smells like a hallucinated purge —
          // refuse the whole proposal and let the cadence retry later.
          // (Bogus and conversation-origin ids are already filtered out, so
          // junk output cannot trip the guardrail by itself.) Memory rewrites
          // count: a narrative rewrite changes what the bot believes, even
          // though the previous wording stays reversible in the revision log.
          const retireCap = deepConsolidationRetireCap(items.length);
          const actionCount = retireMemories.length + retireKnowledge.length + rewriteMemories.length;
          if (actionCount > retireCap) {
            errors.push(
              `deep-consolidation bot ${bot.id}: action list exceeds guardrail` +
                ` (${actionCount} > ${retireCap}); refusing`
            );
            context.coworkStore.setDeepConsolidationAttempts(bot.id, attempts + 1);
            continue;
          }

          // Rewrites first so the survivor of a contradiction is written even
          // when the retire half of the proposal is partly refused below.
          for (const rewrite of rewriteMemories) {
            try {
              const changed = context.coworkStore.rewriteUserMemoryText({
                id: rewrite.id,
                metabotId: bot.id,
                text: rewrite.text,
                reason: 'evolution_rewrite',
                sourceType: `deep_consolidation:${rewrite.reason}`,
                // Same await-window guard as the archive below.
                notUsedSince: context.nowMs,
              });
              if (changed) rewrittenMemories += 1;
            } catch (error) {
              errors.push(`deep-consolidation bot ${bot.id}: rewrite memory ${rewrite.id} failed`);
            }
          }

          retiredMemories += context.coworkStore.archiveUserMemories({
            ids: retireMemories,
            archivedAt: context.nowMs,
            // The LLM call had an await window: anything edited or injected
            // (touched) since the inventory snapshot must survive the proposal.
            notUsedSince: context.nowMs,
          });
          if (context.knowledgeStore) {
            for (const id of retireKnowledge) {
              try {
                context.knowledgeStore.archiveKnowledge({ id, metabotId: bot.id });
                retiredKnowledge += 1;
              } catch (error) {
                errors.push(`deep-consolidation bot ${bot.id}: archive knowledge ${id} failed`);
              }
            }
            for (const rewrite of rewrites) {
              try {
                // Rewrite IN PLACE by id (version bump + revision kept). A
                // topic-fingerprint upsert here would fork a new entry whenever
                // the LLM rephrases the topic, growing the layer it should
                // shrink.
                const updated = context.knowledgeStore.updateKnowledge({
                  id: rewrite.id,
                  metabotId: bot.id,
                  topic: rewrite.topic,
                  summary: rewrite.summary,
                  kind: rewrite.kind,
                });
                if (updated) {
                  rewrittenKnowledge += 1;
                } else {
                  errors.push(`deep-consolidation bot ${bot.id}: rewrite knowledge ${rewrite.id} not found`);
                }
              } catch (error) {
                errors.push(`deep-consolidation bot ${bot.id}: rewrite knowledge ${rewrite.id} failed`);
              }
            }
          }
          // Stamp the cadence only for clean runs: a bot with errors retries
          // on the next pass instead of waiting out the whole interval. A
          // clean pass also clears the attempt ladder.
          if (errors.length === errorsBeforeApply) {
            context.coworkStore.setDeepConsolidationLastRunAt(bot.id, context.nowMs);
            context.coworkStore.setDeepConsolidationAttempts(bot.id, 0);
          }
        }
        void errors;
        if (errors.length > 0) {
          console.warn(`[MemoryHygiene] Deep consolidation warnings: ${errors.join(' | ')}`);
        }
        return {
          counts: {
            deepConsolidationBots: botsConsidered,
            deepRetiredMemories: retiredMemories,
            deepRewrittenMemories: rewrittenMemories,
            deepRetiredKnowledge: retiredKnowledge,
            deepRewrittenKnowledge: rewrittenKnowledge,
          },
          errors,
        };
      },
    });
    // Standing pages (memory evolution #2): per-bot briefing pages rebuilt in
    // the background whenever the sediments in their scope change. Scope
    // fingerprints gate every LLM call — an unchanged scope costs nothing.
    // Surgical operations keep unmentioned sections physically untouched.
    this.steps.push({
      name: 'standing-pages',
      run: async (context) => {
        if (!this.deps.performChat || !context.standingPageStore) return { counts: {} };
        const errors: string[] = [];
        let botsConsidered = 0;
        let pagesBuilt = 0;
        let pagesRefreshed = 0;
        let pagesFreshSkipped = 0;
        let pagesNoSediment = 0;
        for (const bot of this.deps.metabotStore.listMetabots()) {
          if (context.disabledMetabotIds.has(bot.id)) continue;
          if (bot.enabled === false) continue;
          context.standingPageStore.seedDefaultPages(bot.id);
          const pages = context.standingPageStore.listStandingPages(bot.id);
          if (pages.length === 0) continue;
          botsConsidered += 1;
          const brain = metabotBrainOptions(bot);
          for (const page of pages) {
            const sample = sampleStandingPageScope(
              {
                coworkStore: context.coworkStore,
                dreamStore: context.dreamStore,
                knowledgeStore: context.knowledgeStore,
              },
              bot.id,
              page.spec
            );
            if (!sample) {
              pagesNoSediment += 1;
              continue;
            }
            if (page.scopeFingerprint === sample.fingerprint && page.builtAt != null) {
              pagesFreshSkipped += 1;
              continue;
            }
            let raw: string;
            try {
              raw = await this.deps.performChat(
                'You are a memory consolidation assistant. Respond only with the requested JSON object.',
                buildStandingPageRefreshPrompt({
                  botName: bot.name ?? `MetaBot ${bot.id}`,
                  pageName: page.name,
                  question: page.question,
                  sections: page.sections,
                  lines: sample.lines,
                }),
                brain.llmId,
                {
                  thinking: 'disabled',
                  attemptTimeoutMs: resolveDreamAttemptTimeoutMs(1),
                  maxTokens: STANDING_PAGE_MAX_OUTPUT_TOKENS,
                  webSearch: false,
                  llmProvider: brain.llmProvider,
                  fallbackLlmId: brain.fallbackLlmId,
                  fallbackLlmProvider: brain.fallbackLlmProvider,
                },
              );
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              errors.push(`standing-pages bot ${bot.id} page ${page.pageKey}: LLM request failed: ${message}`);
              context.standingPageStore.setRefreshError(page.id, message);
              continue;
            }
            const parsed = parseStandingPageRefreshOutput(raw);
            if (!parsed) {
              errors.push(`standing-pages bot ${bot.id} page ${page.pageKey}: unparseable output`);
              context.standingPageStore.setRefreshError(page.id, 'unparseable output (no complete JSON object)');
              continue;
            }
            const updated = context.standingPageStore.commitPageRefresh({
              pageId: page.id,
              operations: parsed.operations,
              scopeFingerprint: sample.fingerprint,
              reason: page.builtAt == null ? 'initial' : 'scope_refresh',
            });
            if (updated) {
              if (page.builtAt == null) pagesBuilt += 1;
              else pagesRefreshed += 1;
            }
          }
        }
        if (errors.length > 0) {
          console.warn(`[MemoryHygiene] Standing page warnings: ${errors.join(' | ')}`);
        }
        return {
          counts: {
            standingPagesBots: botsConsidered,
            standingPagesBuilt: pagesBuilt,
            standingPagesRefreshed: pagesRefreshed,
            standingPagesFreshSkipped: pagesFreshSkipped,
            standingPagesNoSediment: pagesNoSediment,
          },
          errors,
        };
      },
    });
    this.steps.push({
      name: 'storage-hygiene',
      run: (context) => {
        const snapshotsCompacted = context.dreamStore?.compactPromptLayerSnapshots?.(500) ?? 0;
        let surfBotsPruned = 0;
        if (context.surfStore) {
          const nowIso = new Date(context.nowMs).toISOString();
          for (const bot of this.deps.metabotStore.listMetabots()) {
            if (context.disabledMetabotIds.has(bot.id)) continue;
            context.surfStore.pruneSeenPins(bot.id, nowIso);
            surfBotsPruned += 1;
          }
        }
        const chainReadsPruned = context.chainHistoryStore?.pruneOldChainReads({
          cutoffMs: context.nowMs - 90 * 86_400_000,
          excludeMetabotIds: context.disabledMetabotIds,
        }) ?? 0;
        return {
          snapshotsCompacted,
          surfBotsPruned,
          chainReadsPruned,
        };
      },
    });
  }

  start(): void {
    this.stopTimer();
    this.stopped = false;
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.deps.tickIntervalMs ?? HYGIENE_TICK_INTERVAL_MS);
  }

  stop(): void {
    this.stopped = true;
    this.stopTimer();
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private emitStatus(stats: MemoryHygieneRunStats): void {
    try {
      this.deps.emitToRenderer?.(HYGIENE_STATUS_CHANNEL, stats);
    } catch {
      // Renderer notification is best-effort.
    }
  }

  getLastRun(): MemoryHygieneRunStats | null {
    return this.deps.coworkStore.getMemoryHygieneLastRun();
  }

  /** Scheduled gate: run-time check plus once-per-local-date dedupe. */
  async tick(): Promise<void> {
    if (this.stopped || this.running) {
      return;
    }
    const now = this.now();
    if (!isMemoryHygieneRunTimeDue(now)) {
      return;
    }
    const dateKey = formatBotWorkspaceDate(now);
    const lastRun = this.deps.coworkStore.getMemoryHygieneLastRun();
    if (lastRun && lastRun.dateKey === dateKey) {
      return;
    }
    await this.runAll('scheduled');
  }

  /** Manual trigger (settings UI / IPC): bypasses the window and dedupe gates. */
  async runNow(): Promise<MemoryHygieneRunStats> {
    return this.runAll('manual');
  }

  async runAll(trigger: 'scheduled' | 'manual'): Promise<MemoryHygieneRunStats> {
    if (this.running) {
      throw new Error('Memory hygiene run already in progress');
    }
    const config = this.deps.coworkStore.getMemoryHygieneConfig();
    if (trigger === 'scheduled' && !config.enabled) {
      // Do not stamp the last-run record: a later enable still runs tonight.
      return {
        dateKey: formatBotWorkspaceDate(this.now()),
        ranAt: this.now().getTime(),
        trigger,
        counts: { skippedDisabled: 1 },
        errors: [],
      };
    }

    this.running = true;
    const stats: MemoryHygieneRunStats = {
      dateKey: formatBotWorkspaceDate(this.now()),
      ranAt: this.now().getTime(),
      trigger,
      counts: {},
      errors: [],
    };
    try {
      const context: MemoryHygieneRunContext = {
        config,
        nowMs: stats.ranAt,
        disabledOwners: this.resolveDisabledOwners(),
        disabledMetabotIds: this.resolveDisabledMetabotIds(),
        coworkStore: this.deps.coworkStore,
        dreamStore: this.deps.dreamStore,
        experienceStore: this.deps.metaidExperienceStore,
        impressionStore: this.deps.metaidImpressionStore,
        knowledgeStore: this.deps.metaidKnowledgeStore,
        cultureStore: this.deps.metaidCultureStore,
        standingPageStore: this.deps.standingPageStore,
        surfStore: this.deps.metawebSurfStore,
        chainHistoryStore: this.deps.chainContentHistoryStore,
      };
      for (const step of this.steps) {
        try {
          const result = await step.run(context);
          const isEnvelope = Boolean(
            result && typeof result === 'object' && 'counts' in result
              && (result as { counts?: unknown }).counts
              && typeof (result as { counts?: unknown }).counts === 'object',
          );
          const stepCounts = isEnvelope
            ? (result as { counts: Record<string, number> }).counts
            : ((result ?? {}) as Record<string, number>);
          for (const [key, value] of Object.entries(stepCounts)) {
            stats.counts[key] = value;
          }
          if (isEnvelope) {
            for (const stepError of (result as { errors?: string[] }).errors ?? []) {
              stats.errors.push(stepError);
            }
          }
        } catch (error) {
          const message = `${step.name}: ${error instanceof Error ? error.message : String(error)}`;
          stats.errors.push(message);
          console.warn(`[MemoryHygiene] Step "${step.name}" failed: ${message}`);
        }
      }
      this.deps.coworkStore.setMemoryHygieneLastRun(stats);
      this.emitStatus(stats);
      return stats;
    } finally {
      this.running = false;
    }
  }

  /** Bots whose per-bot policy opts out; their owned stores are skipped by steps. */
  protected resolveDisabledOwners(): Set<string> {
    const owners = new Set<string>();
    try {
      for (const bot of this.deps.metabotStore.listMetabots()) {
        const policy = this.deps.coworkStore.getEffectiveMemoryPolicyForMetabot(bot.id);
        if (!policy.hygieneEnabled && bot.globalmetaid) {
          owners.add(String(bot.globalmetaid));
        }
      }
    } catch (error) {
      console.warn(
        `[MemoryHygiene] Failed to resolve per-bot hygiene policy: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return owners;
  }

  /** The same opt-out set expressed as metabot ids for metabot-keyed stores. */
  protected resolveDisabledMetabotIds(): Set<number> {
    const ids = new Set<number>();
    try {
      for (const bot of this.deps.metabotStore.listMetabots()) {
        const policy = this.deps.coworkStore.getEffectiveMemoryPolicyForMetabot(bot.id);
        if (!policy.hygieneEnabled) {
          ids.add(bot.id);
        }
      }
    } catch (error) {
      console.warn(
        `[MemoryHygiene] Failed to resolve per-bot hygiene policy ids: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return ids;
  }
}

let memoryHygieneServiceInstance: MemoryHygieneService | null = null;

export function startMemoryHygieneService(deps: MemoryHygieneDeps): MemoryHygieneService {
  stopMemoryHygieneService();
  memoryHygieneServiceInstance = new MemoryHygieneService(deps);
  memoryHygieneServiceInstance.start();
  return memoryHygieneServiceInstance;
}

export function stopMemoryHygieneService(): void {
  memoryHygieneServiceInstance?.stop();
  memoryHygieneServiceInstance = null;
}

export function getMemoryHygieneService(): MemoryHygieneService | null {
  return memoryHygieneServiceInstance;
}
