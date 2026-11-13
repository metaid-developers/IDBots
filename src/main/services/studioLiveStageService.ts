import { randomBytes } from 'node:crypto';
import type { CoworkMessage, CoworkSession } from '../coworkStore';
import type { BotBrowserProjectionInput, BotBrowserProjectionOutcome } from './botBrowserProjectionService';
import type { StudioLiveStageSettings } from './studioLiveStageSettings';
import { applyLiveStageSpeech, completeLiveStage, createLiveStageState, buildLiveStageInteraction, dismissLiveStageInteraction, isLiveStageWorkerReport, liveStageError, presentLiveStageInteraction, reduceLiveStageMessage, reportReadyLiveStage, waitingLiveStage, type LiveStageInteraction, type LiveStageState } from './studioLiveStageModel';
import { describeStudioTurnError } from '../shared/studioTurnErrorCopy';
import type { StudioOpenDelegation } from './studioOpenDelegations';
import { isLiveStagePageUri, materializeLiveStageEntry, stageAssetFor, type LiveStageEntry } from './studioLiveStageEntry';
import { previewMetaappUriForPath } from '../libs/localPreviewUri';
import { resolveStudioLiveStageTemplate, STUDIO_LIVE_STAGE_OFFICIAL_TEMPLATE_ID, type StudioLiveStageTemplateResolution } from './studioLiveStageTemplateRegistry';
import { directLiveStageScene } from './studioLiveStageDirector';

const MAX_DIRECTOR_CALLS_PER_TURN = 4;
const MAX_DIRECTOR_CONSECUTIVE_FAILURES = 2;
const DIRECTOR_COALESCE_MS = 900;
const INTERACTION_POLL_MS = 400;
/** Patch delivery retries after a transient frame/page failure. */
const PATCH_RETRY_BACKOFF_MS = [200, 400, 800, 1600, 3000, 5000] as const;
/** Stage re-projections allowed per run when the page cannot be reached. */
const MAX_STAGE_SELF_HEALS = 2;
/** Re-check open delegations once a minute while the stage waits on workers. */
const DELEGATION_RECHECK_MS = 60_000;
/** Minimum gap between speech-streaming patches. */
const SPEECH_PATCH_THROTTLE_MS = 600;
/** Failure reasons worth retrying against the same tab before self-healing. */
const RETRYABLE_PATCH_REASONS = new Set(['not-ready', 'frame-not-found', 'tab-not-found']);
/** Failure reasons that mean the page belongs to another session/protocol. */
const SELF_HEAL_PATCH_REASONS = new Set(['session-mismatch', 'protocol']);
/** Families the Director may restyle; terminal and owner-facing scenes are off limits. */
const DIRECTOR_FAMILIES = new Set([
  'local-recall', 'web2-research', 'metaweb-research', 'making',
  'delegation', 'verification', 'browser-action',
]);

type MetabotLiveStageIdentity = {
  name?: string | null;
  avatar?: string | null;
  llm_id?: string | null;
  llm_provider?: string | null;
  fallback_llm_id?: string | null;
  fallback_llm_provider?: string | null;
};

type LiveStageRun = {
  state: LiveStageState;
  /** Materialized persistent stage entry (shared per template content). */
  stagePath: string | null;
  stageUri: string;
  stageDir: string;
  tabId: number | null;
  reportProjected: boolean;
  queue: Promise<void>;
  seen: Set<string>;
  submissionId: string | null;
  /** Highest state revision confirmed on the stage page. */
  deliveredRevision: number;
  patchRetries: number;
  patchFailures: Record<string, number>;
  retryTimer: NodeJS.Timeout | null;
  selfHeals: number;
  /** A re-projection is already queued; concurrent failures share it. */
  healPending: boolean;
  /**
   * The stage tab was found showing a page the Twin or owner deliberately
   * opened (not a Live Stage). Patches keep failing there, so delivery is
   * parked: no retries, no self-heal — the next state change tries once more
   * and heals only if the tab is back on a stage page (or gone).
   */
  tabParked: boolean;
  /** Newest non-thinking assistant message id — the only id stream updates may touch. */
  latestSpeakingId: string | null;
  lastSpeechPatchAt: number;
  finished: boolean;
  errored: boolean;
  awaitingDelegation: boolean;
  delegationTimer: NodeJS.Timeout | null;
  delegationStartedAt: number | null;
  waitingSignature: string;
  directorCalls: number;
  directorConsecutiveFailures: number;
  directorTimer: NodeJS.Timeout | null;
  directorInFlight: boolean;
  directorDirty: boolean;
  directorGeneration: number;
  interactionTimer: NodeJS.Timeout | null;
  interactionInFlight: boolean;
  template: StudioLiveStageTemplateResolution;
};

export type StudioLiveStageServiceDeps = {
  getSession(sessionId: string): CoworkSession | null;
  getMetabotById(id: number): MetabotLiveStageIdentity | null;
  getSettings(): StudioLiveStageSettings;
  getLanguage(): 'zh' | 'en';
  project(input: BotBrowserProjectionInput): Promise<BotBrowserProjectionOutcome>;
  /**
   * The session's bound 'stage'-role tab ({id, uri}), or null when none is
   * bound/alive. Resolves through the renderer's session-tab binding.
   */
  getStageTab?(sessionId: string): Promise<{ id: number; uri: string | null } | null>;
  /** Current URI of a browser tab; null when the tab no longer exists. */
  getTabUri?(tabId: number): Promise<string | null>;
  applyPatch(input: { tabId: number; state: LiveStageState }): Promise<void>;
  /** Root under which the persistent stage entry pages are materialized. */
  stageRoot?: string;
  assetRoot: string;
  fallbackAvatarDataUri: string;
  directScene?: typeof directLiveStageScene;
  now?: () => number;
  /** Open cross-session delegations for a session (orchestration store). */
  listOpenDelegations?(sessionId: string): StudioOpenDelegation[];
  /** Pulls queued stage-card clicks over the patch frame channel. */
  drainInteractions?(tabId: number, sessionId?: string): Promise<unknown[]>;
  /** Resolves a pending permission in the cowork runner (main-side sink). */
  respondToPermission?(requestId: string, result: Record<string, unknown>): void;
  interactionPollMs?: number;
  /** Open-delegation recheck cadence while the stage waits on workers. */
  delegationRecheckMs?: number;
  /** Resolve and validate the template package; defaults to the built-in registry. */
  resolveTemplate?: () => StudioLiveStageTemplateResolution;
  /** Another stage (the first-run Genesis Stage) owns this session's projector. */
  isSessionClaimed?(sessionId: string): boolean;
  /** Resolves when the previous stage has played its outro (the handoff). */
  beforeProjection?(sessionId: string): Promise<void> | null;
  /**
   * Activates the session's stage-role tab (renderer binding switch-tab,
   * background). Fired on a new human turn and on turn errors — never on
   * completion, worker waiting, or ordinary tool activity.
   */
  activateStageTab?(sessionId: string): void | Promise<void>;
  /** Map a non-renderable avatar reference (a built-in metafile://) to a data URI. */
  resolveAvatar?(avatar: unknown): string | undefined;
};

export function createStudioLiveStageService(deps: StudioLiveStageServiceDeps) {
  const runs = new Map<string, LiveStageRun>();
  const now = deps.now ?? Date.now;
  let turnCounter = 0;
  let currentSettings = deps.getSettings();

  const brainFor = (session: CoworkSession) => {
    const metabot = session.metabotId == null ? null : deps.getMetabotById(session.metabotId);
    return {
      llmId: metabot?.llm_id ?? null,
      llmProvider: metabot?.llm_provider ?? null,
      fallbackLlmId: metabot?.fallback_llm_id ?? null,
      fallbackLlmProvider: metabot?.fallback_llm_provider ?? null,
    };
  };

  const renderableAvatar = (avatar: unknown): string | undefined => typeof avatar === 'string' && /^(?:data:image\/|https?:\/\/)/i.test(avatar) ? avatar : undefined;
  const safeAvatar = (avatar: unknown): string | undefined => renderableAvatar(avatar) ?? renderableAvatar(deps.resolveAvatar?.(avatar));

  const avatarFor = (session: CoworkSession): string => {
    const metabot = session.metabotId == null ? null : deps.getMetabotById(session.metabotId);
    return safeAvatar(session.metabotAvatar ?? metabot?.avatar) ?? deps.fallbackAvatarDataUri;
  };

  /**
   * Avatar reference safe to put in stage state: data-URI avatars become
   * stage-relative `avatars/<hash>.<ext>` files under the run's stage dir;
   * https URLs pass through. Without a materialized entry (no stageRoot)
   * the raw safe avatar is kept — patches cannot deliver anyway.
   */
  const stageAvatarFor = (run: LiveStageRun, avatar: unknown): string | undefined =>
    run.stageDir ? stageAssetFor(avatar, run.stageDir) : safeAvatar(avatar);

  const botNameFor = (session: CoworkSession): string => {
    const metabot = session.metabotId == null ? null : deps.getMetabotById(session.metabotId);
    return session.metabotName ?? metabot?.name ?? 'Twin';
  };

  const workerIdentityFor = (message: CoworkMessage): { name?: string; avatar?: string } => {
    const metadata = message.metadata as { sourceSessionId?: unknown; toolInput?: { workerMetabotId?: unknown } } | undefined;
    if (typeof metadata?.sourceSessionId === 'string') {
      const sourceSession = deps.getSession(metadata.sourceSessionId);
      if (sourceSession) {
        const metabot = sourceSession.metabotId == null ? null : deps.getMetabotById(sourceSession.metabotId);
        return { name: botNameFor(sourceSession), avatar: safeAvatar(sourceSession.metabotAvatar ?? metabot?.avatar) };
      }
    }
    const workerId = metadata?.toolInput?.workerMetabotId;
    if (typeof workerId === 'number' && Number.isInteger(workerId) && workerId > 0) {
      const worker = deps.getMetabotById(workerId);
      return { name: worker?.name?.trim().slice(0, 80) || undefined, avatar: safeAvatar(worker?.avatar) };
    }
    return {};
  };

  function enqueue(run: LiveStageRun, task: () => Promise<void>): void {
    run.queue = run.queue.then(task).catch((error) => {
      console.warn(`[StudioLiveStage] ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  // Resolve and validate one template version at the start of each turn and
  // pin it there: a task never changes appearance halfway through.
  function resolveTurnTemplate(): StudioLiveStageTemplateResolution {
    const resolution = deps.resolveTemplate
      ? deps.resolveTemplate()
      : resolveStudioLiveStageTemplate({ assetRoot: deps.assetRoot });
    return resolution;
  }

  function templateAssetRoot(template: StudioLiveStageTemplateResolution): string {
    // The template resolved at turn start is pinned for the whole turn; a
    // fallback resolution keeps rendering from the raw built-in assets.
    return template.status === 'ok' ? template.template.assetRoot : deps.assetRoot;
  }

  function templateIdFor(template: StudioLiveStageTemplateResolution): string {
    return template.status === 'ok' ? template.template.templateId : STUDIO_LIVE_STAGE_OFFICIAL_TEMPLATE_ID;
  }

  /**
   * Materialize the persistent stage entry for a template resolution — once
   * per content hash under `stageRoot`, idempotent. Returns null when no
   * stageRoot is configured (tests / degraded hosts keep working without
   * stage projection).
   */
  function entryForTemplate(template: StudioLiveStageTemplateResolution): LiveStageEntry | null {
    if (!deps.stageRoot) return null;
    return materializeLiveStageEntry({
      stageRoot: deps.stageRoot,
      templateId: templateIdFor(template),
      assetRoot: templateAssetRoot(template),
      fallbackAvatarDataUri: deps.fallbackAvatarDataUri,
    });
  }

  /**
   * Stage-entry URI a bound tab must already show for the "skip projection"
   * fast path. The preview URI may carry a query/hash suffix; the entry path
   * itself never does.
   */
  function uriMatchesEntry(candidate: string | null | undefined, entryUri: string): boolean {
    const value = String(candidate ?? '').trim();
    return value !== '' && (value === entryUri || value.startsWith(entryUri));
  }

  // Commit a produced state: phaseStartedAt resets whenever the family
  // changes, except a 'waiting' reached while a delegation is in flight —
  // that clock measures from when the delegation started, not from now.
  function commitRunState(run: LiveStageRun, nextState: LiveStageState): LiveStageState {
    if (nextState === run.state) return nextState;
    let state = nextState;
    if (state.family !== run.state.family) {
      const startedAt = state.family === 'waiting' && run.delegationStartedAt != null
        ? run.delegationStartedAt
        : now();
      state = { ...state, phaseStartedAt: startedAt };
    }
    if (state.family === 'delegation' && state.phaseStartedAt != null) {
      run.delegationStartedAt = state.phaseStartedAt;
    }
    run.state = state;
    return state;
  }

  function clearPatchRetry(run: LiveStageRun): void {
    if (run.retryTimer) {
      clearTimeout(run.retryTimer);
      run.retryTimer = null;
    }
  }

  function clearDelegationTimer(run: LiveStageRun): void {
    if (run.delegationTimer) {
      clearInterval(run.delegationTimer);
      run.delegationTimer = null;
    }
  }

  function patchFailureReason(error: unknown): string {
    const reason = (error as { reason?: unknown } | null | undefined)?.reason;
    return typeof reason === 'string' && reason ? reason : 'unknown';
  }

  function notePatchFailure(run: LiveStageRun, reason: string): void {
    const count = (run.patchFailures[reason] ?? 0) + 1;
    run.patchFailures[reason] = count;
    if (count === 1 || count % 10 === 0) {
      console.warn(`[StudioLiveStage] patch delivery failed reason=${reason} count=${count} session=${run.state.sessionId}`);
    }
  }

  async function attemptPatchDelivery(run: LiveStageRun): Promise<void> {
    // The stage is its own tab now: a projected report no longer freezes it.
    if (!run.state.enabled) return;
    if (run.state.revision <= run.deliveredRevision) return;
    if (run.tabId == null && deps.getStageTab) {
      const bound = await deps.getStageTab(run.state.sessionId);
      run.tabId = bound?.id ?? null;
    }
    if (run.tabId == null) {
      const error = new Error('The Live Stage tab is not resolved') as Error & { reason?: string };
      error.reason = 'tab-not-found';
      throw error;
    }
    const revision = run.state.revision;
    await deps.applyPatch({ tabId: run.tabId, state: run.state });
    run.deliveredRevision = Math.max(run.deliveredRevision, revision);
    run.patchRetries = 0;
    run.tabParked = false;
  }

  async function handlePatchFailure(run: LiveStageRun, error: unknown): Promise<void> {
    const reason = patchFailureReason(error);
    // A stale-revision/stale-turn rejection means the page already shows
    // something newer — drop the patch, never retry it.
    if (reason === 'stale-revision' || reason === 'stale-turn') {
      run.deliveredRevision = Math.max(run.deliveredRevision, run.state.revision);
      run.patchRetries = 0;
      return;
    }
    notePatchFailure(run, reason);
    if (SELF_HEAL_PATCH_REASONS.has(reason)) {
      await requestStageHeal(run);
      return;
    }
    if (run.tabParked) {
      // Parked on a page the Twin or owner opened on purpose: each state
      // change earns exactly one cheap delivery attempt — never a retry
      // timer, and a heal only if the tab is back on a stage page.
      await requestStageHeal(run);
      return;
    }
    if (RETRYABLE_PATCH_REASONS.has(reason) || reason === 'unknown') {
      if (run.patchRetries < PATCH_RETRY_BACKOFF_MS.length) {
        schedulePatchRetry(run);
        return;
      }
      await requestStageHeal(run);
      return;
    }
    // Unclassified rejection: same recovery budget as a transient failure.
    if (run.patchRetries < PATCH_RETRY_BACKOFF_MS.length) {
      schedulePatchRetry(run);
      return;
    }
    await requestStageHeal(run);
  }

  function schedulePatchRetry(run: LiveStageRun): void {
    if (run.retryTimer) return;
    const delay = PATCH_RETRY_BACKOFF_MS[Math.min(run.patchRetries, PATCH_RETRY_BACKOFF_MS.length - 1)];
    run.patchRetries += 1;
    run.retryTimer = setTimeout(() => {
      run.retryTimer = null;
      deliverPatch(run);
    }, delay);
    run.retryTimer.unref?.();
  }

  function deliverPatch(run: LiveStageRun): void {
    enqueue(run, async () => {
      try {
        await attemptPatchDelivery(run);
      } catch (error) {
        await handlePatchFailure(run, error);
      }
    });
  }

  /**
   * The stage tab's current URI. Returns undefined when the lookup itself
   * failed — an unknown page is treated like a foreign one (never heal).
   */
  async function stageTabUri(run: LiveStageRun): Promise<string | null | undefined> {
    if (run.tabId == null || !deps.getTabUri) return null;
    try {
      return await deps.getTabUri(run.tabId);
    } catch {
      return undefined;
    }
  }

  /**
   * A self-heal re-projects the persistent stage entry into the session's
   * stage role — that must never land on a tab the Twin or owner
   * deliberately navigated (e.g. the Twin opened a MetaApp page and is
   * reading it). Heal only when the tab still shows a Live Stage page of any
   * turn/entry (persistent entry or a legacy per-turn file), or when the
   * tab is gone entirely.
   */
  async function requestStageHeal(run: LiveStageRun): Promise<void> {
    if (run.healPending) return;
    if (run.selfHeals >= MAX_STAGE_SELF_HEALS) {
      notePatchFailure(run, 'self-heal-exhausted');
      return;
    }
    const uri = await stageTabUri(run);
    if (uri === undefined || (uri != null && !isLiveStagePageUri(uri))) {
      if (!run.tabParked) notePatchFailure(run, uri === undefined ? 'tab-uri-unknown' : 'tab-parked');
      run.tabParked = true;
      return;
    }
    run.tabParked = false;
    selfHealStage(run);
  }

  function selfHealStage(run: LiveStageRun): void {
    if (run.healPending) return;
    if (run.selfHeals >= MAX_STAGE_SELF_HEALS) {
      notePatchFailure(run, 'self-heal-exhausted');
      return;
    }
    run.selfHeals += 1;
    run.healPending = true;
    run.patchRetries = 0;
    clearPatchRetry(run);
    console.warn(`[StudioLiveStage] self-heal ${run.selfHeals}/${MAX_STAGE_SELF_HEALS} for ${run.state.sessionId}`);
    enqueue(run, async () => {
      try {
        const session = deps.getSession(run.state.sessionId);
        if (!session || !run.state.enabled || run.stagePath == null) return;
        // Re-project the SAME persistent entry into the stage role: the
        // binding reuses or reopens the role's tab, then the latest state
        // patches straight onto the fresh page.
        const outcome = await deps.project({
          sessionId: run.state.sessionId,
          localPath: run.stagePath,
          title: `${run.state.botName} · Live Stage`,
          role: 'stage',
        });
        run.tabId = outcome.tabId;
        if (run.tabId == null && deps.getStageTab) {
          const bound = await deps.getStageTab(run.state.sessionId);
          run.tabId = bound?.id ?? null;
        }
        try {
          await attemptPatchDelivery(run);
        } catch (error) {
          await handlePatchFailure(run, error);
        }
      } finally {
        run.healPending = false;
      }
    });
  }

  /**
   * Put the session's stage tab on the persistent entry, then patch.
   * Fast path: the role-bound tab already shows the current entry URI (the
   * common case — the entry is shared, so no navigation is needed at all).
   * Otherwise the entry is projected into the 'stage' role (the binding
   * reuses the bound tab, adopts the prewarmed draft, or opens a fresh
   * dedupe:false tab).
   */
  function projectStage(run: LiveStageRun): void {
    enqueue(run, async () => {
      await deps.beforeProjection?.(run.state.sessionId);
      const session = deps.getSession(run.state.sessionId);
      if (!session || !run.state.enabled || run.stagePath == null) return;
      const bound = deps.getStageTab ? await deps.getStageTab(run.state.sessionId) : null;
      if (bound && uriMatchesEntry(bound.uri, run.stageUri)) {
        run.tabId = bound.id;
        if (process.env.NODE_ENV === 'development') {
          console.warn(`[StudioLiveStage] stage tab ${run.state.sessionId} already on entry tab=${run.tabId}`);
        }
        deliverPatch(run);
        return;
      }
      const outcome = await deps.project({
        sessionId: run.state.sessionId,
        localPath: run.stagePath,
        title: `${run.state.botName} · Live Stage`,
        role: 'stage',
      });
      run.tabId = outcome.tabId;
      if (run.tabId == null && deps.getStageTab) {
        const again = await deps.getStageTab(run.state.sessionId);
        run.tabId = again?.id ?? null;
      }
      if (process.env.NODE_ENV === 'development') {
        console.warn(`[StudioLiveStage] stage tab ${run.state.sessionId} outcome=${outcome.tabId} resolved=${run.tabId}`);
      }
      deliverPatch(run);
    });
  }

  function schedulePatch(run: LiveStageRun): void {
    deliverPatch(run);
  }

  function openDelegationsFor(run: LiveStageRun): StudioOpenDelegation[] {
    if (!deps.listOpenDelegations) return [];
    try {
      return deps.listOpenDelegations(run.state.sessionId) ?? [];
    } catch (error) {
      console.warn(`[StudioLiveStage] delegation lookup failed for ${run.state.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  function applyDelegationWait(run: LiveStageRun, delegations: StudioOpenDelegation[]): void {
    const first = delegations[0];
    const startedAt = delegations.reduce((min, entry) => Math.min(min, entry.startedAt), first.startedAt);
    const signature = JSON.stringify([delegations.length, first.workerName ?? '', first.title ?? '', startedAt]);
    if (run.state.family === 'waiting' && run.waitingSignature === signature) return;
    run.waitingSignature = signature;
    // The delegation clock starts at the earliest worker start, not at the
    // moment the turn ended — commitRunState picks this up for 'waiting'.
    run.delegationStartedAt = startedAt;
    const nextState = waitingLiveStage(run.state, {
      workerName: first.workerName,
      workerAvatar: stageAvatarFor(run, first.workerAvatar),
      title: first.title,
      total: delegations.length,
      startedAt,
      nowMs: now(),
    });
    commitRunState(run, nextState);
  }

  function clearDelegationWait(run: LiveStageRun): void {
    run.awaitingDelegation = false;
    run.waitingSignature = '';
    clearDelegationTimer(run);
  }

  function scheduleDelegationRecheck(run: LiveStageRun): void {
    clearDelegationTimer(run);
    const recheckMs = Math.max(10, deps.delegationRecheckMs ?? DELEGATION_RECHECK_MS);
    run.delegationTimer = setInterval(() => {
      if (!run.awaitingDelegation || run.errored) {
        clearDelegationTimer(run);
        return;
      }
      const delegations = openDelegationsFor(run);
      if (delegations.length === 0) {
        clearDelegationWait(run);
        if (!run.errored) {
          const nextState = completeLiveStage(run.state, now());
          if (nextState !== run.state) {
            commitRunState(run, nextState);
            run.directorGeneration += 1;
            schedulePatch(run);
          }
        }
        return;
      }
      applyDelegationWait(run, delegations);
      schedulePatch(run);
    }, recheckMs);
    run.delegationTimer.unref?.();
  }

  function scheduleDirector(run: LiveStageRun): void {
    if (!DIRECTOR_FAMILIES.has(run.state.family)) return;
    // The Director only restyles family-default captions; a caption carrying
    // real message content is never overwritten.
    if (run.state.captionSource !== 'default') return;
    if (run.directorConsecutiveFailures >= MAX_DIRECTOR_CONSECUTIVE_FAILURES || !currentSettings.directorEnabled || !run.state.enabled || run.directorCalls >= MAX_DIRECTOR_CALLS_PER_TURN) return;
    run.directorDirty = true;
    if (run.directorInFlight || run.directorTimer) return;
    console.log(`[StudioLiveStage] Director scheduled for ${run.state.sessionId} family=${run.state.family}`);
    run.directorTimer = setTimeout(() => {
      run.directorTimer = null;
      if (!run.directorDirty || run.directorInFlight || run.directorConsecutiveFailures >= MAX_DIRECTOR_CONSECUTIVE_FAILURES || !currentSettings.directorEnabled || !run.state.enabled) return;
      if (!DIRECTOR_FAMILIES.has(run.state.family) || run.state.captionSource !== 'default') {
        run.directorDirty = false;
        return;
      }
      run.directorDirty = false;
      run.directorInFlight = true;
      run.directorCalls += 1;
      run.directorGeneration += 1;
      const generation = run.directorGeneration;
      const session = deps.getSession(run.state.sessionId);
      if (!session) { run.directorInFlight = false; return; }
      const snapshot = JSON.parse(JSON.stringify(run.state)) as LiveStageState;
      snapshot.metrics.directorCalls += 1;
      run.state.metrics.directorCalls += 1;
      const directScene = deps.directScene ?? directLiveStageScene;
      console.log(`[StudioLiveStage] Director call ${run.directorCalls} started for ${run.state.sessionId}`);
      void directScene(snapshot, brainFor(session)).then(({ scene, usage }) => {
        run.directorConsecutiveFailures = 0;
        const metrics = run.state.metrics;
        metrics.inputTokens += usage.inputTokens;
        metrics.outputTokens += usage.outputTokens;
        metrics.cacheReadTokens += usage.cacheReadTokens;
        metrics.cacheCreationTokens += usage.cacheCreationTokens;
        metrics.directorLatencyMs += usage.latencyMs;
        if (generation !== run.directorGeneration || run.state.family !== snapshot.family || !run.state.enabled) {
          metrics.rejectedPatches += 1;
        } else {
          // The Director restyles caption + composition/motif/motion only —
          // the headline always stays host-owned.
          run.state = commitRunState(run, {
            ...run.state,
            caption: scene.caption,
            composition: scene.composition,
            motif: scene.motif,
            motion: scene.motion,
            revision: run.state.revision + 1,
            metrics,
          });
        }
        console.log(`[StudioLiveStage] Director call ${run.directorCalls} finished: input=${usage.inputTokens} output=${usage.outputTokens} latencyMs=${usage.latencyMs}`);
        schedulePatch(run);
      }).catch((error) => {
        run.directorConsecutiveFailures += 1;
        run.state.metrics.fallbackCount += 1;
        if (run.directorConsecutiveFailures >= MAX_DIRECTOR_CONSECUTIVE_FAILURES) run.directorDirty = false;
        console.log(`[StudioLiveStage] Director call ${run.directorCalls} failed: ${error instanceof Error ? error.message : String(error)}`);
        schedulePatch(run);
      }).finally(() => {
        run.directorInFlight = false;
        if (run.directorDirty) scheduleDirector(run);
      });
    }, DIRECTOR_COALESCE_MS);
  }

  function ensureRun(sessionId: string): LiveStageRun | null {
    const session = deps.getSession(sessionId);
    if (!currentSettings.enabled || !session || session.sessionType !== 'browser' || session.assistantMode !== true) return null;
    if (deps.isSessionClaimed?.(sessionId)) return null;
    const existing = runs.get(sessionId);
    if (existing) return existing;
    turnCounter += 1;
    const turnId = `turn-${now().toString(36)}-${turnCounter.toString(36)}`;
    const template = resolveTurnTemplate();
    const entry = entryForTemplate(template);
    const stageDir = entry?.dir ?? '';
    const state = createLiveStageState({
      sessionId,
      turnId,
      botName: botNameFor(session),
      botAvatar: stageDir ? stageAssetFor(avatarFor(session), stageDir) : undefined,
      language: deps.getLanguage(),
      directorEnabled: currentSettings.directorEnabled,
      nowMs: now(),
    });
    const run: LiveStageRun = {
      state,
      stagePath: entry?.filePath ?? null,
      stageUri: entry?.uri ?? '',
      stageDir,
      tabId: null,
      reportProjected: false,
      queue: Promise.resolve(),
      seen: new Set(),
      submissionId: null,
      deliveredRevision: state.revision,
      patchRetries: 0,
      patchFailures: {},
      retryTimer: null,
      selfHeals: 0,
      healPending: false,
      tabParked: false,
      latestSpeakingId: null,
      lastSpeechPatchAt: 0,
      finished: false,
      errored: false,
      awaitingDelegation: false,
      delegationTimer: null,
      delegationStartedAt: null,
      waitingSignature: '',
      directorCalls: 0,
      directorConsecutiveFailures: 0,
      directorTimer: null,
      directorInFlight: false,
      directorDirty: false,
      directorGeneration: 0,
      interactionTimer: null,
      interactionInFlight: false,
      template,
    };
    if (run.template.status === 'fallback') {
      console.warn(`[StudioLiveStage] template fallback for ${sessionId}: ${run.template.reason}`);
    }
    runs.set(sessionId, run);
    if (process.env.NODE_ENV === 'development') {
      console.warn(`[StudioLiveStage] run created ${sessionId} turn=${turnId} director=${currentSettings.directorEnabled}`);
    }
    projectStage(run);
    return run;
  }

  function teardownRun(run: LiveStageRun): void {
    run.directorGeneration += 1;
    if (run.directorTimer) clearTimeout(run.directorTimer);
    clearPatchRetry(run);
    clearDelegationTimer(run);
    // A pending card belongs to this turn; the permission itself stays
    // pending — the desktop overlay seat still answers it.
    stopInteractionPolling(run);
  }

  function prepareSession(sessionId: string): void {
    if (typeof sessionId !== 'string' || !sessionId.trim()) return;
    currentSettings = deps.getSettings();
    ensureRun(sessionId);
  }

  function observeMessage(sessionId: string, message: CoworkMessage): void {
    if (!message?.id) return;
    currentSettings = deps.getSettings();
    if (process.env.NODE_ENV === 'development') {
      console.warn(`[StudioLiveStage] observe ${sessionId} type=${message.type} id=${message.id} enabled=${currentSettings.enabled} director=${currentSettings.directorEnabled}`);
    }
    if (!currentSettings.enabled) return;
    const humanOrigin = message.type === 'user' && !isLiveStageWorkerReport(message)
      && (!message.metadata?.origin || message.metadata.origin === 'user' || message.metadata.origin === 'quick_action');
    let run = runs.get(sessionId);
    const submissionId = humanOrigin ? String(message.metadata?.submissionId ?? message.id) : null;
    if (humanOrigin && submissionId && run?.submissionId !== submissionId) {
      if (run) {
        teardownRun(run);
        runs.delete(sessionId);
      }
      run = null;
    }
    // A finished run (complete or error) belongs to the previous turn: real
    // activity starts a fresh stage so the projector leaves the old screen.
    // System runtime-status noise and redelivered human submissions of the
    // same turn do not count.
    const runtimeNoise = typeof message.metadata?.sdkRuntimeStatus === 'string';
    const sameSubmission = humanOrigin && submissionId != null && run?.submissionId === submissionId;
    if (run && run.finished) {
      if (runtimeNoise || sameSubmission) return;
      teardownRun(run);
      runs.delete(sessionId);
      run = null;
    } else if (run && run.reportProjected && isLiveStageWorkerReport(message)) {
      // A cross-session worker report arriving after the report was projected
      // belongs to a new beat on the stage, not to the finished projection.
      teardownRun(run);
      runs.delete(sessionId);
      run = null;
    }
    run ??= ensureRun(sessionId);
    // reportProjected no longer gates delivery: the report lands on the
    // showcase tab, so the stage keeps receiving live patches after it.
    if (!run || run.seen.has(message.id) || run.finished) return;
    run.seen.add(message.id);
    if (submissionId) run.submissionId = submissionId;
    if (message.type === 'assistant' && !message.metadata?.isThinking) {
      run.latestSpeakingId = message.id;
    }
    const worker = workerIdentityFor(message);
    const nextState = reduceLiveStageMessage(run.state, message, { workerName: worker.name, workerAvatar: stageAvatarFor(run, worker.avatar), nowMs: now() });
    if (nextState === run.state) return;
    commitRunState(run, nextState);
    schedulePatch(run);
    scheduleDirector(run);
    // A new human turn puts the stage in front: the owner asked, the live
    // presence answers. Completion, worker waits and tool noise never do.
    if (humanOrigin) activateStage(run);
  }

  /** Queue the stage-role tab activation behind the pending patch delivery. */
  function activateStage(run: LiveStageRun): void {
    const sessionId = run.state.sessionId;
    enqueue(run, async () => {
      try {
        await deps.activateStageTab?.(sessionId);
      } catch {
        // Tab activation is best-effort; the patch itself already landed.
      }
    });
  }

  /**
   * Streamed assistant text for the newest non-thinking assistant message the
   * run saw — usually the final reply, which arrives as an empty bubble right
   * after the last tool call and only fills in through updates. Older message
   * ids are ignored, and so is anything while an owner card is up.
   */
  function observeMessageUpdate(sessionId: string, messageId: string, content: string, metadata?: Record<string, unknown>): void {
    const run = runs.get(sessionId);
    if (!run || run.finished || run.errored) return;
    if (!messageId || messageId !== run.latestSpeakingId || typeof content !== 'string') return;
    if (run.state.interaction) return;
    const nowMs = now();
    const isFinal = metadata?.isFinal === true || metadata?.isStreaming === false;
    if (!isFinal && run.lastSpeechPatchAt > 0 && nowMs - run.lastSpeechPatchAt < SPEECH_PATCH_THROTTLE_MS) return;
    run.lastSpeechPatchAt = nowMs;
    const nextState = applyLiveStageSpeech(run.state, content, nowMs);
    if (nextState === run.state) return;
    commitRunState(run, nextState);
    schedulePatch(run);
  }

  function observeComplete(sessionId: string): void {
    const run = runs.get(sessionId);
    if (!run || run.finished) return;
    run.finished = true;
    clearDelegationWait(run);
    const delegations = openDelegationsFor(run);
    if (!run.errored && delegations.length > 0) {
      // The twin's turn ended but delegated workers are still running: the
      // stage waits on them honestly instead of claiming completion.
      run.awaitingDelegation = true;
      applyDelegationWait(run, delegations);
      schedulePatch(run);
      scheduleDelegationRecheck(run);
      return;
    }
    const nextState = completeLiveStage(run.state, now());
    if (nextState === run.state) return;
    commitRunState(run, nextState);
    run.directorGeneration += 1;
    schedulePatch(run);
  }

  function observeError(sessionId: string, error?: string): void {
    const run = runs.get(sessionId);
    if (!run) return;
    run.finished = true;
    run.errored = true;
    clearDelegationWait(run);
    const language = run.state.language;
    const { reason, hint } = describeStudioTurnError(typeof error === 'string' ? error : '', language);
    const copy = {
      headline: language === 'zh' ? '这一轮没能完成' : "This run didn't finish",
      caption: language === 'zh' ? `${reason}。${hint}` : `${reason}. ${hint}`,
    };
    const nextState = liveStageError(run.state, copy, now());
    if (nextState === run.state) return;
    commitRunState(run, nextState);
    run.directorGeneration += 1;
    schedulePatch(run);
    // A failed turn is owner-facing: bring the stage (with its problem scene)
    // forward so the owner sees what happened.
    activateStage(run);
  }

  // Stage interaction card: present → poll-drain → respond, all in-process.
  // The card is a presentation surface for prompts the runner already gates;
  // authority never leaves the host (requestId must match a live pending
  // permission and the drained click must echo the single-use token).

  function stopInteractionPolling(run: LiveStageRun): void {
    if (run.interactionTimer) {
      clearInterval(run.interactionTimer);
      run.interactionTimer = null;
    }
    run.interactionInFlight = false;
  }

  function resultForInteraction(
    interaction: LiveStageInteraction,
    record: Record<string, unknown>,
  ): Record<string, unknown> | null {
    if (record.behavior === 'deny') return { behavior: 'deny', message: 'Denied on the Live Stage' };
    if (record.behavior !== 'allow') return null;
    if (interaction.kind !== 'ask') return { behavior: 'allow' };
    // Stage-level skip: every question is handed back unanswered. The runner
    // maps skippedQuestions to {id, selected: []} with NO custom note — the
    // honest "no answer" the ask protocol exposes (skip ≠ veto, nothing
    // fabricated on the host side).
    if (record.skip === true) {
      return {
        behavior: 'allow',
        updatedInput: { answers: {}, skippedQuestions: interaction.questions.map((question) => question.question) },
      };
    }
    const raw = record.answers && typeof record.answers === 'object' && !Array.isArray(record.answers)
      ? record.answers as Record<string, unknown>
      : {};
    // Keyed by question text with '|||'-joined segments — the same wire shape
    // the runner's ask resolve path maps into selected/custom. An empty string
    // resolves as "declined to answer", mirroring the desktop wizard.
    const answers: Record<string, string> = {};
    for (const question of interaction.questions) {
      const value = raw[question.question];
      answers[question.question] = typeof value === 'string' ? value : '';
    }
    return { behavior: 'allow', updatedInput: { answers } };
  }

  function handleDrainedItem(run: LiveStageRun, item: unknown): boolean {
    const interaction = run.state.interaction;
    if (!interaction || !item || typeof item !== 'object' || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    if (record.requestId !== interaction.requestId || record.token !== interaction.token) {
      console.warn(`[StudioLiveStage] drained click rejected for ${run.state.sessionId}: requestId/token mismatch`);
      return false;
    }
    const result = resultForInteraction(interaction, record);
    if (!result) {
      console.warn(`[StudioLiveStage] drained click rejected for ${run.state.sessionId}: unmappable behavior`);
      return false;
    }
    console.log(`[StudioLiveStage] stage answer ${interaction.requestId} (${interaction.kind}) for ${run.state.sessionId}`);
    deps.respondToPermission?.(interaction.requestId, result);
    run.state = dismissLiveStageInteraction(run.state, interaction.requestId);
    stopInteractionPolling(run);
    schedulePatch(run);
    return true;
  }

  function startInteractionPolling(run: LiveStageRun): void {
    if (run.interactionTimer || !deps.drainInteractions) return;
    const pollMs = Math.max(10, deps.interactionPollMs ?? INTERACTION_POLL_MS);
    // Drain observability: the 2026-11-12 MetaPo retest lost a skip click
    // with ZERO trace — every failure path below used to be silent. Failures
    // now log rate-limited, and an in-flight drain that never settles (hung
    // tab-bridge command) is force-released after 10s so the poller
    // self-heals instead of freezing for the life of the card.
    let drainFailures = 0;
    let inFlightSince = 0;
    run.interactionTimer = setInterval(() => {
      const interaction = run.state.interaction;
      if (!interaction || !run.state.enabled || run.tabId == null || !deps.drainInteractions) return;
      if (run.interactionInFlight) {
        if (inFlightSince && Date.now() - inFlightSince > 10000) {
          console.warn(`[StudioLiveStage] drain stuck >10s for ${run.state.sessionId}; releasing the poller`);
          run.interactionInFlight = false;
          inFlightSince = 0;
        }
        return;
      }
      run.interactionInFlight = true;
      inFlightSince = Date.now();
      deps.drainInteractions(run.tabId, run.state.sessionId)
        .then((items) => {
          run.interactionInFlight = false;
          inFlightSince = 0;
          if (drainFailures > 0) {
            console.log(`[StudioLiveStage] drain recovered for ${run.state.sessionId} after ${drainFailures} failure(s)`);
            drainFailures = 0;
          }
          if (items.length > 0) {
            console.log(`[StudioLiveStage] drained ${items.length} stage click(s) for ${run.state.sessionId}`);
          }
          for (const item of items) {
            if (handleDrainedItem(run, item)) break;
          }
          if (!run.state.interaction) stopInteractionPolling(run);
        })
        .catch((error) => {
          // Frame lost (stage tab closed or navigated): keep the poll alive;
          // the desktop overlay seat remains the answering fallback.
          run.interactionInFlight = false;
          inFlightSince = 0;
          drainFailures += 1;
          if (drainFailures === 1 || drainFailures % 25 === 0) {
            console.warn(`[StudioLiveStage] stage drain failed ×${drainFailures} for ${run.state.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
          }
        });
    }, pollMs);
  }

  function presentInteraction(sessionId: string, request: unknown): 'presented' | 'busy' | 'declined' {
    currentSettings = deps.getSettings();
    if (!currentSettings.enabled) return 'declined';
    const run = runs.get(sessionId);
    if (!run || run.reportProjected) return 'declined';
    if (run.state.interaction) return 'busy';
    const candidate = request && typeof request === 'object' && !Array.isArray(request)
      ? request as { requestId?: unknown; toolName?: unknown; toolInput?: Record<string, unknown> | null; expiresAt?: unknown; timeoutDefault?: unknown }
      : {};
    const interaction = buildLiveStageInteraction(candidate, randomBytes(16).toString('hex'));
    if (!interaction) return 'declined';
    run.state = presentLiveStageInteraction(run.state, interaction, now());
    startInteractionPolling(run);
    schedulePatch(run);
    console.log(`[StudioLiveStage] present ${interaction.kind} ${interaction.requestId} on ${sessionId}'s stage`);
    return 'presented';
  }

  function clearInteraction(sessionId: string, requestId: string): 'cleared' | 'absent' {
    const run = runs.get(sessionId);
    if (!run) return 'absent';
    const before = run.state.revision;
    run.state = dismissLiveStageInteraction(run.state, requestId);
    if (run.state.revision !== before) {
      stopInteractionPolling(run);
      schedulePatch(run);
      console.log(`[StudioLiveStage] clear ${requestId} from ${sessionId}'s stage`);
      return 'cleared';
    }
    return 'absent';
  }

  /** RequestIds whose stage card is currently showing (overlay dedup seed). */
  function listPresentedRequestIds(): string[] {
    const ids: string[] = [];
    for (const run of runs.values()) {
      if (run.state.interaction) ids.push(run.state.interaction.requestId);
    }
    return ids;
  }

  /**
   * Push delivery for a stage card click (stage → shell bridge → renderer →
   * main). Primary path alongside the poll fallback: locate the run whose
   * card matches the entry's requestId + token and run it through the same
   * validated resolve as the drain. Single-use is preserved — the first
   * delivery (push or poll) dismisses the card, so the second is rejected.
   */
  function acceptPushedInteraction(entry: unknown): boolean {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const record = entry as { requestId?: unknown; token?: unknown };
    const requestId = typeof record.requestId === 'string' ? record.requestId : '';
    if (!requestId) return false;
    for (const run of runs.values()) {
      const interaction = run.state.interaction;
      if (!interaction || interaction.requestId !== requestId) continue;
      if (record.token !== interaction.token) {
        console.warn(`[StudioLiveStage] pushed click token mismatch for ${requestId}`);
        return false;
      }
      return handleDrainedItem(run, entry);
    }
    console.warn(`[StudioLiveStage] pushed click for unknown interaction ${requestId}`);
    return false;
  }

  async function projectReport(
    input: BotBrowserProjectionInput,
    project: (stageTabId: number | null) => Promise<BotBrowserProjectionOutcome>,
  ): Promise<BotBrowserProjectionOutcome> {
    currentSettings = deps.getSettings();
    const run = runs.get(input.sessionId);
    if (!currentSettings.enabled || !run) return project(null);
    run.directorGeneration += 1;
    if (run.directorTimer) {
      clearTimeout(run.directorTimer);
      run.directorTimer = null;
    }
    run.directorDirty = false;
    // The report URI travels in stage state (never baked into the page): the
    // stage's report button opens the showcase tab that receives the report.
    const reportUri = previewMetaappUriForPath(input.localPath);
    commitRunState(run, reportReadyLiveStage(run.state, reportUri, now()));
    schedulePatch(run);
    await run.queue;
    try {
      // Reports land in the session's showcase role (main.ts wires role +
      // reveal); the stage tab is never the report's target anymore.
      const outcome = await project(null);
      run.reportProjected = true;
      stopInteractionPolling(run);
      return outcome;
    } catch (error) {
      commitRunState(run, liveStageError(run.state, undefined, now()));
      schedulePatch(run);
      throw error;
    }
  }

  /**
   * The materialized persistent stage entry for the current template
   * resolution — the IPC prewarm path (`studio:liveStage:getStageEntry`).
   * Idempotent; returns null when no stageRoot is configured.
   */
  function getStageEntry(): { uri: string } | null {
    const entry = entryForTemplate(resolveTurnTemplate());
    return entry ? { uri: entry.uri } : null;
  }

  function updateSettings(settings: StudioLiveStageSettings): void {
    currentSettings = settings;
    for (const run of runs.values()) {
      run.state.enabled = settings.enabled;
      run.state.metrics.directorEnabled = settings.directorEnabled;
      run.directorGeneration += 1;
      if (!settings.directorEnabled && run.directorTimer) {
        clearTimeout(run.directorTimer);
        run.directorTimer = null;
        run.directorDirty = false;
      }
      schedulePatch(run);
    }
  }

  function forget(sessionId: string): void {
    const run = runs.get(sessionId);
    if (run) teardownRun(run);
    runs.delete(sessionId);
  }

  return {
    prepareSession,
    observeMessage,
    observeMessageUpdate,
    observeComplete,
    observeError,
    presentInteraction,
    clearInteraction,
    listPresentedRequestIds,
    acceptPushedInteraction,
    projectReport,
    getStageEntry,
    updateSettings,
    forget,
    getState: (sessionId: string): LiveStageState | null => runs.get(sessionId)?.state ?? null,
    getRunInternals: (sessionId: string) => runs.get(sessionId) ?? null,
    dispose: () => {
      for (const run of runs.values()) {
        teardownRun(run);
      }
      runs.clear();
    },
  };
}

export type StudioLiveStageService = ReturnType<typeof createStudioLiveStageService>;
