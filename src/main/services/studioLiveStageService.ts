import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import type { CoworkMessage, CoworkSession } from '../coworkStore';
import type { BotBrowserProjectionInput, BotBrowserProjectionOutcome } from './botBrowserProjectionService';
import type { StudioLiveStageSettings } from './studioLiveStageSettings';
import { completeLiveStage, createLiveStageState, buildLiveStageInteraction, dismissLiveStageInteraction, isLiveStageWorkerReport, liveStageError, presentLiveStageInteraction, reduceLiveStageMessage, reportReadyLiveStage, type LiveStageInteraction, type LiveStageState } from './studioLiveStageModel';
import { renderLiveStageHtml } from './studioLiveStageTemplate';
import { resolveStudioLiveStageTemplate, type StudioLiveStageTemplateResolution } from './studioLiveStageTemplateRegistry';
import { directLiveStageScene } from './studioLiveStageDirector';

const MAX_DIRECTOR_CALLS_PER_TURN = 4;
const MAX_DIRECTOR_CONSECUTIVE_FAILURES = 2;
const DIRECTOR_COALESCE_MS = 900;
const INTERACTION_POLL_MS = 400;

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
  stagePath: string | null;
  tabId: number | null;
  reportProjected: boolean;
  queue: Promise<void>;
  seen: Set<string>;
  submissionId: string | null;
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
  findStageTab?(localPath: string): Promise<number | null>;
  applyPatch(input: { tabId: number; state: LiveStageState }): Promise<void>;
  assetRoot: string;
  fallbackAvatarDataUri: string;
  directScene?: typeof directLiveStageScene;
  now?: () => number;
  /** Pulls queued stage-card clicks over the patch frame channel. */
  drainInteractions?(tabId: number): Promise<unknown[]>;
  /** Resolves a pending permission in the cowork runner (main-side sink). */
  respondToPermission?(requestId: string, result: Record<string, unknown>): void;
  interactionPollMs?: number;
  /** Resolve and validate the template package; defaults to the built-in registry. */
  resolveTemplate?: () => StudioLiveStageTemplateResolution;
  /** Another stage (the first-run Genesis Stage) owns this session's projector. */
  isSessionClaimed?(sessionId: string): boolean;
  /** Resolves when the previous stage has played its outro (the handoff). */
  beforeProjection?(sessionId: string): Promise<void> | null;
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

  const safeAvatar = (avatar: unknown): string | undefined => typeof avatar === 'string' && /^(?:data:image\/|https?:\/\/)/i.test(avatar) ? avatar : undefined;

  const avatarFor = (session: CoworkSession): string => {
    const metabot = session.metabotId == null ? null : deps.getMetabotById(session.metabotId);
    return safeAvatar(session.metabotAvatar ?? metabot?.avatar) ?? deps.fallbackAvatarDataUri;
  };

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

  function writeStage(run: LiveStageRun, reportUri?: string): void {
    const session = deps.getSession(run.state.sessionId);
    if (!session) return;
    // The template resolved at turn start is pinned for the whole turn; a
    // fallback resolution keeps rendering from the raw built-in assets.
    const templateAssetRoot = run.template.status === 'ok' ? run.template.template.assetRoot : deps.assetRoot;
    const html = renderLiveStageHtml({
      state: run.state,
      avatarDataUri: avatarFor(session),
      assets: { assetRoot: templateAssetRoot, fallbackAvatarDataUri: deps.fallbackAvatarDataUri },
      reportUri,
    });
    fs.mkdirSync(path.dirname(run.stagePath!), { recursive: true });
    fs.writeFileSync(run.stagePath!, html, 'utf8');
  }

  function projectStage(run: LiveStageRun): void {
    enqueue(run, async () => {
      await deps.beforeProjection?.(run.state.sessionId);
      const session = deps.getSession(run.state.sessionId);
      if (!session || !run.state.enabled) return;
      writeStage(run);
      const outcome = await deps.project({ sessionId: run.state.sessionId, localPath: run.stagePath!, title: `${run.state.botName} · Live Stage` });
      run.tabId = outcome.tabId;
      if (run.tabId == null && deps.findStageTab) {
        run.tabId = await deps.findStageTab(run.stagePath!);
      }
      if (process.env.NODE_ENV === 'development') {
        console.warn(`[StudioLiveStage] stage tab ${run.state.sessionId} outcome=${outcome.tabId} resolved=${run.tabId}`);
      }
      if (run.tabId != null && run.state.enabled) {
        await deps.applyPatch({ tabId: run.tabId, state: run.state }).catch(() => undefined);
      }
    });
  }

  function schedulePatch(run: LiveStageRun): void {
    enqueue(run, async () => {
      if (run.reportProjected) return;
      if (run.tabId == null && deps.findStageTab) {
        run.tabId = await deps.findStageTab(run.stagePath!);
      }
      if (run.tabId == null) return;
      await deps.applyPatch({ tabId: run.tabId, state: run.state });
    });
  }

  function scheduleDirector(run: LiveStageRun): void {
    if (run.state.family === 'report-ready' || run.directorConsecutiveFailures >= MAX_DIRECTOR_CONSECUTIVE_FAILURES || !currentSettings.directorEnabled || !run.state.enabled || run.directorCalls >= MAX_DIRECTOR_CALLS_PER_TURN) return;
    run.directorDirty = true;
    if (run.directorInFlight || run.directorTimer) return;
    console.log(`[StudioLiveStage] Director scheduled for ${run.state.sessionId} family=${run.state.family}`);
    run.directorTimer = setTimeout(() => {
      run.directorTimer = null;
      if (!run.directorDirty || run.directorInFlight || run.directorConsecutiveFailures >= MAX_DIRECTOR_CONSECUTIVE_FAILURES || !currentSettings.directorEnabled || !run.state.enabled) return;
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
          run.state = { ...run.state, ...scene, revision: run.state.revision + 1, metrics };
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
    const state = createLiveStageState({
      sessionId,
      turnId,
      botName: botNameFor(session),
      language: deps.getLanguage(),
      directorEnabled: currentSettings.directorEnabled,
    });
    const run: LiveStageRun = {
      state,
      stagePath: path.join(session.cwd, 'reports', `live-stage-${turnId}.html`),
      tabId: null,
      reportProjected: false,
      queue: Promise.resolve(),
      seen: new Set(),
      submissionId: null,
      directorCalls: 0,
      directorConsecutiveFailures: 0,
      directorTimer: null,
      directorInFlight: false,
      directorDirty: false,
      directorGeneration: 0,
      interactionTimer: null,
      interactionInFlight: false,
      template: resolveTurnTemplate(),
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
        run.directorGeneration += 1;
        if (run.directorTimer) clearTimeout(run.directorTimer);
        // The turn's stage file is replaced; a pending card disappears with
        // it. The permission itself stays pending — the desktop overlay seat
        // still answers it.
        stopInteractionPolling(run);
        runs.delete(sessionId);
      }
      run = null;
    }
    run ??= ensureRun(sessionId);
    if (!run || run.seen.has(message.id)) return;
    run.seen.add(message.id);
    if (submissionId) run.submissionId = submissionId;
    const worker = workerIdentityFor(message);
    const nextState = reduceLiveStageMessage(run.state, message, { workerName: worker.name, workerAvatar: worker.avatar });
    if (nextState === run.state) return;
    run.state = nextState;
    schedulePatch(run);
    scheduleDirector(run);
  }

  function observeComplete(sessionId: string): void {
    const run = runs.get(sessionId);
    if (!run) return;
    const nextState = completeLiveStage(run.state);
    if (nextState === run.state) return;
    run.state = nextState;
    run.directorGeneration += 1;
    schedulePatch(run);
  }

  function observeError(sessionId: string): void {
    const run = runs.get(sessionId);
    if (!run) return;
    run.state = liveStageError(run.state);
    run.directorGeneration += 1;
    schedulePatch(run);
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
    if (record.requestId !== interaction.requestId || record.token !== interaction.token) return false;
    const result = resultForInteraction(interaction, record);
    if (!result) return false;
    deps.respondToPermission?.(interaction.requestId, result);
    run.state = dismissLiveStageInteraction(run.state, interaction.requestId);
    stopInteractionPolling(run);
    schedulePatch(run);
    return true;
  }

  function startInteractionPolling(run: LiveStageRun): void {
    if (run.interactionTimer || !deps.drainInteractions) return;
    const pollMs = Math.max(10, deps.interactionPollMs ?? INTERACTION_POLL_MS);
    run.interactionTimer = setInterval(() => {
      const interaction = run.state.interaction;
      if (!interaction || !run.state.enabled || run.interactionInFlight || run.tabId == null || !deps.drainInteractions) return;
      run.interactionInFlight = true;
      deps.drainInteractions(run.tabId)
        .then((items) => {
          run.interactionInFlight = false;
          for (const item of items) {
            if (handleDrainedItem(run, item)) break;
          }
          if (!run.state.interaction) stopInteractionPolling(run);
        })
        .catch(() => {
          // Frame lost (stage tab closed or navigated): keep the poll alive;
          // the desktop overlay seat remains the answering fallback.
          run.interactionInFlight = false;
        });
    }, pollMs);
  }

  function presentInteraction(sessionId: string, request: unknown): 'presented' | 'busy' | 'declined' {
    currentSettings = deps.getSettings();
    if (!currentSettings.enabled) return 'declined';
    const run = runs.get(sessionId);
    if (!run) return 'declined';
    if (run.state.interaction) return 'busy';
    const candidate = request && typeof request === 'object' && !Array.isArray(request)
      ? request as { requestId?: unknown; toolName?: unknown; toolInput?: Record<string, unknown> | null; expiresAt?: unknown; timeoutDefault?: unknown }
      : {};
    const interaction = buildLiveStageInteraction(candidate, randomBytes(16).toString('hex'));
    if (!interaction) return 'declined';
    run.state = presentLiveStageInteraction(run.state, interaction);
    startInteractionPolling(run);
    schedulePatch(run);
    return 'presented';
  }

  function clearInteraction(sessionId: string, requestId: string): void {
    const run = runs.get(sessionId);
    if (!run) return;
    const before = run.state.revision;
    run.state = dismissLiveStageInteraction(run.state, requestId);
    if (run.state.revision !== before) {
      stopInteractionPolling(run);
      schedulePatch(run);
    }
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
    run.state = reportReadyLiveStage(run.state);
    schedulePatch(run);
    await run.queue;
    try {
      const outcome = await project(run.tabId);
      run.reportProjected = true;
      stopInteractionPolling(run);
      try {
        writeStage(run, outcome.uri);
      } catch (error) {
        console.warn(`[StudioLiveStage] report recovery snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return outcome;
    } catch (error) {
      run.state = liveStageError(run.state);
      schedulePatch(run);
      throw error;
    }
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
    if (run?.directorTimer) clearTimeout(run.directorTimer);
    if (run) stopInteractionPolling(run);
    runs.delete(sessionId);
  }

  return {
    prepareSession,
    observeMessage,
    observeComplete,
    observeError,
    presentInteraction,
    clearInteraction,
    projectReport,
    updateSettings,
    forget,
    getState: (sessionId: string): LiveStageState | null => runs.get(sessionId)?.state ?? null,
    getRunInternals: (sessionId: string) => runs.get(sessionId) ?? null,
    dispose: () => {
      for (const run of runs.values()) {
        run.directorGeneration += 1;
        if (run.directorTimer) clearTimeout(run.directorTimer);
        stopInteractionPolling(run);
      }
      runs.clear();
    },
  };
}

export type StudioLiveStageService = ReturnType<typeof createStudioLiveStageService>;
