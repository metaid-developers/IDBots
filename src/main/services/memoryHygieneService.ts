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
import { metabotBrainOptions } from './llmFallback';

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
// Aligned with the dream synthesis budget (DREAM_SYNTHESIS_TIMEOUT_MS):
// consolidation prompts carry up to ~160 belief-layer rows + 60 knowledge
// entries and emit up to a 12K-token JSON at flash-tier generation speed.
// The 2026-09-23 04:00 run timed out on bots 22 and 10 (both glm-5.3-flash,
// last successful consolidations 09-13/09-15 — persistent failures) under
// the pre-fix build where the GLM thinking toggle was dropped upstream; the
// low-effort mapping (a5681845) shrinks the output but heavily-throttled
// generation of a full inventory JSON still legitimately runs 8-10 minutes,
// so 180s had the same squeeze as the dream synthesis before 600s. Only a
// genuinely stalled call exceeds 10 minutes and should abort to the fallback.
const DEEP_CONSOLIDATION_LLM_TIMEOUT_MS = 600_000;
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
        let retiredKnowledge = 0;
        let rewrittenKnowledge = 0;
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
          const knowledge = context.knowledgeStore
            ? context.knowledgeStore.listKnowledgeForDream(bot.id, 60)
            : [];
          const items: DeepConsolidationInventoryItem[] = [
            ...boundaries.map((memory) => ({ id: memory.id, kind: 'value_boundary' as const, text: memory.text })),
            ...reviews.map((memory) => ({ id: memory.id, kind: 'work_review' as const, text: memory.text })),
            ...knowledge.map((entry) => ({
              id: entry.id,
              kind: 'knowledge' as const,
              text: `${entry.topic}: ${entry.summary}`,
              extra: `kind=${entry.kind}, v${entry.version}`,
            })),
          ];
          if (!shouldRunDeepConsolidation(items.length)) continue;
          botsConsidered += 1;

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
                // Per-attempt window: the fallback brain gets its own fresh
                // 180s instead of inheriting the primary's spent signal.
                attemptTimeoutMs: DEEP_CONSOLIDATION_LLM_TIMEOUT_MS,
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
            continue;
          }
          const output = parseDeepConsolidationOutput(raw);
          if (!output) {
            errors.push(
              `deep-consolidation bot ${bot.id}: unparseable output (${describeDeepConsolidationParseFailure(raw)})`
            );
            continue;
          }
          const errorsBeforeApply = errors.length;

          const memoryIds = new Set([...boundaries, ...reviews].map((memory) => memory.id));
          const knowledgeIds = new Set(knowledge.map((entry) => entry.id));
          // Retire protection aligned with the deterministic decay stroke:
          // only dream-origin rows are ever auto-archived — conversation-origin
          // entries may carry the user's explicit "remember this".
          const dreamMemoryIds = new Set(
            [...boundaries, ...reviews]
              .filter((memory) => memory.origin === 'dream')
              .map((memory) => memory.id),
          );
          const retireMemories = output.retireMemoryIds.filter((id) => dreamMemoryIds.has(id));
          const retireKnowledge = output.retireKnowledgeIds.filter((id) => knowledgeIds.has(id));
          const rewrites = output.rewriteKnowledge.filter((rewrite) => knowledgeIds.has(rewrite.id));

          // Guardrail: a VALIDATED retire list eating more than a quarter of
          // the belief layer in one pass smells like a hallucinated purge —
          // refuse the whole proposal and let the cadence retry later.
          // (Bogus and conversation-origin ids are already filtered out, so
          // junk output cannot trip the guardrail by itself.)
          const retireCap = deepConsolidationRetireCap(items.length);
          if (retireMemories.length + retireKnowledge.length > retireCap) {
            errors.push(
              `deep-consolidation bot ${bot.id}: retire list exceeds guardrail` +
                ` (${retireMemories.length + retireKnowledge.length} > ${retireCap}); refusing`
            );
            continue;
          }
          void memoryIds;

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
          // on the next pass instead of waiting out the whole interval.
          if (errors.length === errorsBeforeApply) {
            context.coworkStore.setDeepConsolidationLastRunAt(bot.id, context.nowMs);
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
            deepRetiredKnowledge: retiredKnowledge,
            deepRewrittenKnowledge: rewrittenKnowledge,
          },
          errors,
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
