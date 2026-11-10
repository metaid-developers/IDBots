import fs from 'node:fs';
import path from 'node:path';
import type { CoworkMessage, CoworkSession } from '../coworkStore';
import type { BotBrowserProjectionInput, BotBrowserProjectionOutcome } from './botBrowserProjectionService';
import type { BotHubLiveStageSettings } from './botHubLiveStageSettings';
import { completeLiveStage, createLiveStageState, isLiveStageWorkerReport, liveStageError, reduceLiveStageMessage, reportReadyLiveStage, type LiveStageState } from './botHubLiveStageModel';
import { renderLiveStageHtml } from './botHubLiveStageTemplate';
import { directLiveStageScene } from './botHubLiveStageDirector';

const MAX_DIRECTOR_CALLS_PER_TURN = 8;
const DIRECTOR_COALESCE_MS = 900;

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
  queue: Promise<void>;
  seen: Set<string>;
  submissionId: string | null;
  directorCalls: number;
  directorTimer: NodeJS.Timeout | null;
  directorInFlight: boolean;
  directorDirty: boolean;
  directorGeneration: number;
};

export type BotHubLiveStageServiceDeps = {
  getSession(sessionId: string): CoworkSession | null;
  getMetabotById(id: number): MetabotLiveStageIdentity | null;
  getSettings(): BotHubLiveStageSettings;
  getLanguage(): 'zh' | 'en';
  project(input: BotBrowserProjectionInput): Promise<BotBrowserProjectionOutcome>;
  findStageTab?(localPath: string): Promise<number | null>;
  applyPatch(input: { tabId: number; state: LiveStageState }): Promise<void>;
  assetRoot: string;
  fallbackAvatarDataUri: string;
  reportDelayMs?: number;
  directScene?: typeof directLiveStageScene;
  now?: () => number;
};

export function createBotHubLiveStageService(deps: BotHubLiveStageServiceDeps) {
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

  const avatarFor = (session: CoworkSession): string => {
    const metabot = session.metabotId == null ? null : deps.getMetabotById(session.metabotId);
    const avatar = session.metabotAvatar ?? metabot?.avatar;
    return typeof avatar === 'string' && /^(?:data:image\/|https?:\/\/)/i.test(avatar) ? avatar : deps.fallbackAvatarDataUri;
  };

  const botNameFor = (session: CoworkSession): string => {
    const metabot = session.metabotId == null ? null : deps.getMetabotById(session.metabotId);
    return session.metabotName ?? metabot?.name ?? 'Twin';
  };

  const workerNameFor = (message: CoworkMessage): string | undefined => {
    const metadata = message.metadata as { sourceSessionId?: unknown; toolInput?: { workerMetabotId?: unknown } } | undefined;
    if (typeof metadata?.sourceSessionId === 'string') {
      const sourceSession = deps.getSession(metadata.sourceSessionId);
      if (sourceSession) return botNameFor(sourceSession);
    }
    const workerId = metadata?.toolInput?.workerMetabotId;
    if (typeof workerId === 'number' && Number.isInteger(workerId) && workerId > 0) {
      return deps.getMetabotById(workerId)?.name?.trim().slice(0, 80) || undefined;
    }
    return undefined;
  };

  function enqueue(run: LiveStageRun, task: () => Promise<void>): void {
    run.queue = run.queue.then(task).catch((error) => {
      console.warn(`[BotHubLiveStage] ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  function projectStage(run: LiveStageRun): void {
    enqueue(run, async () => {
      const session = deps.getSession(run.state.sessionId);
      if (!session || !run.state.enabled) return;
      const html = renderLiveStageHtml({
        state: run.state,
        avatarDataUri: avatarFor(session),
        assets: { assetRoot: deps.assetRoot, fallbackAvatarDataUri: deps.fallbackAvatarDataUri },
      });
      fs.mkdirSync(path.dirname(run.stagePath!), { recursive: true });
      fs.writeFileSync(run.stagePath!, html, 'utf8');
      const outcome = await deps.project({ sessionId: run.state.sessionId, localPath: run.stagePath!, title: `${run.state.botName} · Live Stage` });
      run.tabId = outcome.tabId;
      if (run.tabId == null && deps.findStageTab) {
        run.tabId = await deps.findStageTab(run.stagePath!);
      }
      if (process.env.NODE_ENV === 'development') {
        console.warn(`[BotHubLiveStage] stage tab ${run.state.sessionId} outcome=${outcome.tabId} resolved=${run.tabId}`);
      }
      if (run.tabId != null && run.state.enabled) {
        await deps.applyPatch({ tabId: run.tabId, state: run.state }).catch(() => undefined);
      }
    });
  }

  function schedulePatch(run: LiveStageRun): void {
    enqueue(run, async () => {
      if (run.tabId == null && deps.findStageTab) {
        run.tabId = await deps.findStageTab(run.stagePath!);
      }
      if (run.tabId == null) return;
      await deps.applyPatch({ tabId: run.tabId, state: run.state });
    });
  }

  function scheduleDirector(run: LiveStageRun): void {
    if (!currentSettings.directorEnabled || !run.state.enabled || run.directorCalls >= MAX_DIRECTOR_CALLS_PER_TURN) return;
    run.directorDirty = true;
    if (run.directorInFlight || run.directorTimer) return;
    console.log(`[BotHubLiveStage] Director scheduled for ${run.state.sessionId} family=${run.state.family}`);
    run.directorTimer = setTimeout(() => {
      run.directorTimer = null;
      if (!run.directorDirty || run.directorInFlight || !currentSettings.directorEnabled || !run.state.enabled) return;
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
      console.log(`[BotHubLiveStage] Director call ${run.directorCalls} started for ${run.state.sessionId}`);
      void directScene(snapshot, brainFor(session)).then(({ scene, usage }) => {
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
        console.log(`[BotHubLiveStage] Director call ${run.directorCalls} finished: input=${usage.inputTokens} output=${usage.outputTokens} latencyMs=${usage.latencyMs}`);
        schedulePatch(run);
      }).catch((error) => {
        run.state.metrics.fallbackCount += 1;
        console.log(`[BotHubLiveStage] Director call ${run.directorCalls} failed: ${error instanceof Error ? error.message : String(error)}`);
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
      queue: Promise.resolve(),
      seen: new Set(),
      submissionId: null,
      directorCalls: 0,
      directorTimer: null,
      directorInFlight: false,
      directorDirty: false,
      directorGeneration: 0,
    };
    runs.set(sessionId, run);
    if (process.env.NODE_ENV === 'development') {
      console.warn(`[BotHubLiveStage] run created ${sessionId} turn=${turnId} director=${currentSettings.directorEnabled}`);
    }
    projectStage(run);
    return run;
  }

  function observeMessage(sessionId: string, message: CoworkMessage): void {
    if (!message?.id) return;
    currentSettings = deps.getSettings();
    if (process.env.NODE_ENV === 'development') {
      console.warn(`[BotHubLiveStage] observe ${sessionId} type=${message.type} id=${message.id} enabled=${currentSettings.enabled} director=${currentSettings.directorEnabled}`);
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
        runs.delete(sessionId);
      }
      run = null;
    }
    run ??= ensureRun(sessionId);
    if (!run || run.seen.has(message.id)) return;
    run.seen.add(message.id);
    if (submissionId) run.submissionId = submissionId;
    run.state = reduceLiveStageMessage(run.state, message, { workerName: workerNameFor(message) });
    schedulePatch(run);
    scheduleDirector(run);
  }

  function observeComplete(sessionId: string): void {
    const run = runs.get(sessionId);
    if (!run) return;
    run.state = completeLiveStage(run.state);
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

  async function projectReport(
    input: BotBrowserProjectionInput,
    project: () => Promise<BotBrowserProjectionOutcome>,
  ): Promise<BotBrowserProjectionOutcome> {
    currentSettings = deps.getSettings();
    const run = runs.get(input.sessionId);
    if (!currentSettings.enabled || !run) return project();
    run.state = reportReadyLiveStage(run.state);
    schedulePatch(run);
    const delayMs = deps.reportDelayMs ?? 1000;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return project();
  }

  function updateSettings(settings: BotHubLiveStageSettings): void {
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
    runs.delete(sessionId);
  }

  return {
    observeMessage,
    observeComplete,
    observeError,
    projectReport,
    updateSettings,
    forget,
    getState: (sessionId: string): LiveStageState | null => runs.get(sessionId)?.state ?? null,
    getRunInternals: (sessionId: string) => runs.get(sessionId) ?? null,
    dispose: () => {
      for (const run of runs.values()) {
        run.directorGeneration += 1;
        if (run.directorTimer) clearTimeout(run.directorTimer);
      }
      runs.clear();
    },
  };
}

export type BotHubLiveStageService = ReturnType<typeof createBotHubLiveStageService>;
