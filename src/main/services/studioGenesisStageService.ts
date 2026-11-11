import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { CoworkMessage, CoworkSession } from '../coworkStore';
import type { BotBrowserProjectionInput, BotBrowserProjectionOutcome } from './botBrowserProjectionService';
import type { StudioLiveStageSettings } from './studioLiveStageSettings';
import { isLiveStageWorkerReport } from './studioLiveStageModel';
import {
  applyTurnText,
  beginListening,
  clearInvite,
  createGenesisStageState,
  isGenesisTalkTool,
  setGenesisNaming,
  setGenesisPhase,
  showInvite,
  type GenesisPhase,
  type GenesisStageState,
  type GenesisTurnKind,
} from './studioGenesisStageModel';
import { renderGenesisStageHtml, type GenesisStageAssets } from './studioGenesisStageTemplate';

/**
 * Studio Genesis Stage host (docs/superpowers/specs/2026-11-11-studio-welcome-genesis-design.md).
 *
 * Owns the first-run greeting session's projector from creation until the
 * welcome concludes: the greeting, the invite, an optional four-part tour, and
 * talk-only replies (naming, questions) play on the Genesis page. The first
 * real work — a tool outside the talk allowlist, a worker report, or the first
 * human turn after the welcome concluded — releases the session: the page
 * plays its outro and the Live Stage takes over the same tab. State is
 * in-memory; after a restart the session simply runs on the Live Stage.
 */

type GenesisMetabot = { name?: string | null; avatar?: string | null; globalmetaid?: string | null };

export type StudioGenesisStageTiming = {
  /** Minimum gap between two patches (streamed text arrives much faster). */
  patchMs: number;
  /** Invite-click drain interval while the invite is up. */
  pollMs: number;
  /** Projection retry interval: during onboarding the Studio browser mounts after the session exists. */
  retryMs: number;
  retryLimit: number;
  /** How long the page's outro plays before the Live Stage navigates the tab. */
  outroMs: number;
};

export type StudioGenesisStageServiceDeps = {
  getSession(sessionId: string): CoworkSession | null;
  getMetabotById(id: number): GenesisMetabot | null;
  getSettings(): StudioLiveStageSettings;
  getLanguage(): 'zh' | 'en';
  project(input: BotBrowserProjectionInput): Promise<BotBrowserProjectionOutcome>;
  findStageTab?(localPath: string): Promise<number | null>;
  /** Run a script inside the stage tab's preview frame. */
  runScript(input: { tabId: number; script: string }): Promise<unknown>;
  /** Submit a visible owner turn into the session (the tour request). */
  submitTurn(input: { sessionId: string; submissionId: string; text: string }): Promise<boolean>;
  assets: GenesisStageAssets;
  fallbackAvatarDataUri: string;
  timing?: Partial<StudioGenesisStageTiming>;
};

type TurnTrack = {
  id: string;
  kind: GenesisTurnKind;
  submissionId: string | null;
  texts: Map<string, string>;
  complete: boolean;
  failed: boolean;
};

type GenesisRun = {
  sessionId: string;
  metabotId: number | null;
  state: GenesisStageState;
  stagePath: string;
  avatar: string;
  tabId: number | null;
  projected: boolean;
  projectAttempts: number;
  turn: TurnTrack;
  textDirty: boolean;
  inviteShown: boolean;
  inviteToken: string | null;
  tourSubmissionId: string | null;
  concluded: boolean;
  released: boolean;
  handoff: Promise<void> | null;
  namings: Map<string, string>;
  patchTimer: NodeJS.Timeout | null;
  patchInFlight: boolean;
  patchDirty: boolean;
  patchFailures: number;
  lastPatchAt: number;
  pollTimer: NodeJS.Timeout | null;
  pollInFlight: boolean;
  retryTimer: NodeJS.Timeout | null;
};

const DEFAULT_TIMING: StudioGenesisStageTiming = { patchMs: 220, pollMs: 400, retryMs: 800, retryLimit: 25, outroMs: 1250 };
const MAX_PATCH_FAILURES = 40;

function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function buildGenesisPatchScript(state: GenesisStageState): string {
  return `(() => {
  const stage = window.IDBotsGenesisStage;
  if (!stage || typeof stage.applyPatch !== 'function') return { ok: false, reason: 'genesis-not-ready' };
  stage.applyPatch(${inlineJson(state)});
  return { ok: true };
})()`;
}

export function buildGenesisDrainScript(): string {
  return `(() => {
  const stage = window.IDBotsGenesisStage;
  if (!stage || typeof stage.drainActions !== 'function') return { ok: false, items: [] };
  const items = stage.drainActions();
  return { ok: true, items: Array.isArray(items) ? items : [] };
})()`;
}

const normalizeToolName = (name: unknown): string => String(name ?? '').trim().toLowerCase().replace(/^mcp__.+?__/, '');
const safeAvatar = (avatar: unknown): string | undefined => (
  typeof avatar === 'string' && /^(?:data:image\/|https?:\/\/)/i.test(avatar) ? avatar : undefined
);
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createStudioGenesisStageService(deps: StudioGenesisStageServiceDeps) {
  const runs = new Map<string, GenesisRun>();
  const timing: StudioGenesisStageTiming = { ...DEFAULT_TIMING, ...deps.timing };

  function writeStage(run: GenesisRun, state: GenesisStageState): void {
    const html = renderGenesisStageHtml({ state, avatarDataUri: run.avatar, assets: { ...deps.assets, fallbackAvatarDataUri: deps.fallbackAvatarDataUri } });
    fs.mkdirSync(path.dirname(run.stagePath), { recursive: true });
    fs.writeFileSync(run.stagePath, html, 'utf8');
  }

  /** A reloaded tab (Back, app restart) shows the latest words without replaying the intro. */
  function persistSnapshot(run: GenesisRun, phase?: GenesisPhase): void {
    try {
      writeStage(run, { ...run.state, intro: 'skip', phase: phase ?? run.state.phase, invite: null, listening: false });
    } catch (error) {
      console.warn(`[StudioGenesisStage] snapshot failed for ${run.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  function flushText(run: GenesisRun): void {
    if (!run.textDirty) return;
    run.textDirty = false;
    const text = [...run.turn.texts.values()].map((value) => value.trim()).filter(Boolean).join('\n\n');
    run.state = applyTurnText(run.state, {
      turnId: run.turn.id,
      kind: run.turn.kind,
      text,
      complete: run.turn.complete,
      failed: run.turn.failed,
    });
  }

  function schedulePatch(run: GenesisRun, immediate = false): void {
    run.patchDirty = true;
    if (run.patchTimer || run.patchInFlight || run.released) return;
    const wait = immediate ? 0 : Math.max(0, timing.patchMs - (Date.now() - run.lastPatchAt));
    run.patchTimer = setTimeout(() => {
      run.patchTimer = null;
      void flushPatch(run);
    }, wait);
  }

  async function flushPatch(run: GenesisRun): Promise<void> {
    if (run.released || !runs.has(run.sessionId) || !run.projected) return;
    run.patchDirty = false;
    flushText(run);
    if (run.tabId == null && deps.findStageTab) run.tabId = await deps.findStageTab(run.stagePath).catch(() => null);
    if (run.tabId == null) return;
    run.patchInFlight = true;
    run.lastPatchAt = Date.now();
    let applied = false;
    try {
      const result = await deps.runScript({ tabId: run.tabId, script: buildGenesisPatchScript(run.state) }) as { ok?: boolean } | null;
      applied = result?.ok === true;
    } catch {
      applied = false;
    }
    run.patchInFlight = false;
    if (applied) {
      run.patchFailures = 0;
    } else {
      // The page is still booting (or its frame is not reachable yet).
      run.patchFailures += 1;
      if (run.patchFailures < MAX_PATCH_FAILURES) run.patchDirty = true;
    }
    if (run.patchDirty) schedulePatch(run);
  }

  async function projectStage(run: GenesisRun): Promise<void> {
    if (run.released || !runs.has(run.sessionId)) return;
    run.projectAttempts += 1;
    try {
      flushText(run);
      writeStage(run, run.state);
      const outcome = await deps.project({ sessionId: run.sessionId, localPath: run.stagePath, title: `${run.state.botName} · Genesis` });
      run.tabId = outcome.tabId ?? (deps.findStageTab ? await deps.findStageTab(run.stagePath).catch(() => null) : null);
      run.projected = true;
      schedulePatch(run);
      if (run.inviteToken) startPolling(run);
    } catch (error) {
      if (run.released || run.projectAttempts >= timing.retryLimit) {
        console.warn(`[StudioGenesisStage] projection gave up for ${run.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      run.retryTimer = setTimeout(() => {
        run.retryTimer = null;
        void projectStage(run);
      }, timing.retryMs);
    }
  }

  function stopPolling(run: GenesisRun): void {
    if (run.pollTimer) clearInterval(run.pollTimer);
    run.pollTimer = null;
    run.pollInFlight = false;
  }

  function startPolling(run: GenesisRun): void {
    if (run.pollTimer || !run.inviteToken || run.released) return;
    run.pollTimer = setInterval(() => { void pollOnce(run); }, Math.max(5, timing.pollMs));
  }

  async function pollOnce(run: GenesisRun): Promise<void> {
    if (!run.inviteToken || run.released) { stopPolling(run); return; }
    if (run.pollInFlight || run.tabId == null || !run.projected) return;
    run.pollInFlight = true;
    try {
      const result = await deps.runScript({ tabId: run.tabId, script: buildGenesisDrainScript() }) as { items?: unknown[] } | null;
      for (const item of Array.isArray(result?.items) ? result.items : []) {
        if (handleAction(run, item)) break;
      }
    } catch {
      // Frame not reachable this tick (navigation or boot); keep polling.
    } finally {
      run.pollInFlight = false;
    }
  }

  function conclude(run: GenesisRun): void {
    run.concluded = true;
    run.inviteToken = null;
    stopPolling(run);
    run.state = setGenesisPhase(clearInvite(run.state), 'settled');
    schedulePatch(run, true);
    persistSnapshot(run);
  }

  /** Invite clicks queued by the page; authority stays here (the token must match). */
  function handleAction(run: GenesisRun, item: unknown): boolean {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const { token, choice } = item as Record<string, unknown>;
    if (!run.inviteToken || token !== run.inviteToken) return false;
    if (choice === 'later') {
      conclude(run);
      return true;
    }
    if (choice !== 'tour') return false;
    run.inviteToken = null;
    stopPolling(run);
    const submissionId = randomUUID();
    run.tourSubmissionId = submissionId;
    run.state = setGenesisPhase(clearInvite(run.state), 'tour');
    schedulePatch(run, true);
    const fail = () => {
      if (run.tourSubmissionId !== submissionId) return;
      run.tourSubmissionId = null;
      conclude(run);
    };
    deps.submitTurn({ sessionId: run.sessionId, submissionId, text: run.state.copy.tourUserMessage })
      .then((ok) => { if (!ok) fail(); })
      .catch(fail);
    return true;
  }

  function release(run: GenesisRun): void {
    if (run.released) return;
    flushText(run);
    run.released = true;
    run.concluded = true;
    run.inviteToken = null;
    stopPolling(run);
    if (run.patchTimer) clearTimeout(run.patchTimer);
    run.patchTimer = null;
    if (run.retryTimer) clearTimeout(run.retryTimer);
    run.retryTimer = null;
    run.state = setGenesisPhase(clearInvite(run.state), 'handoff');
    const finalState = run.state;
    persistSnapshot(run, 'settled');
    const tabId = run.tabId;
    const projected = run.projected;
    run.handoff = (async () => {
      if (!projected || tabId == null) return;
      try {
        await deps.runScript({ tabId, script: buildGenesisPatchScript(finalState) });
      } catch {
        return;
      }
      await delay(timing.outroMs);
    })();
  }

  function startTurn(run: GenesisRun, id: string, kind: GenesisTurnKind, submissionId: string): void {
    flushText(run);
    run.turn = { id, kind, submissionId, texts: new Map(), complete: false, failed: false };
    run.textDirty = false;
    run.state = beginListening(run.state);
    schedulePatch(run, true);
  }

  function finishTurn(run: GenesisRun, failed: boolean): void {
    run.turn.complete = true;
    if (failed) run.turn.failed = true;
    run.textDirty = true;
    flushText(run);
    if (run.turn.kind === 'tour') {
      conclude(run);
      return;
    }
    if (!run.concluded && !run.inviteShown) {
      run.inviteShown = true;
      run.inviteToken = randomBytes(12).toString('hex');
      run.state = setGenesisPhase(showInvite(run.state, run.inviteToken), 'invite');
      startPolling(run);
    }
    schedulePatch(run, true);
    persistSnapshot(run);
  }

  function claimGreeting(sessionId: string): boolean {
    if (typeof sessionId !== 'string' || !sessionId.trim()) return false;
    if (runs.has(sessionId)) return true;
    const session = deps.getSession(sessionId);
    if (!deps.getSettings().enabled || !session || session.sessionType !== 'browser' || session.assistantMode !== true) return false;
    const metabot = session.metabotId == null ? null : deps.getMetabotById(session.metabotId);
    const run: GenesisRun = {
      sessionId,
      metabotId: session.metabotId ?? null,
      state: createGenesisStageState({
        sessionId,
        language: deps.getLanguage(),
        botName: session.metabotName ?? metabot?.name ?? 'Twin',
        globalMetaId: metabot?.globalmetaid ?? '',
      }),
      stagePath: path.join(session.cwd, 'reports', `genesis-${sessionId}.html`),
      avatar: safeAvatar(session.metabotAvatar ?? metabot?.avatar) ?? deps.fallbackAvatarDataUri,
      tabId: null,
      projected: false,
      projectAttempts: 0,
      turn: { id: 'greeting', kind: 'greeting', submissionId: null, texts: new Map(), complete: false, failed: false },
      textDirty: false,
      inviteShown: false,
      inviteToken: null,
      tourSubmissionId: null,
      concluded: false,
      released: false,
      handoff: null,
      namings: new Map(),
      patchTimer: null,
      patchInFlight: false,
      patchDirty: false,
      patchFailures: 0,
      lastPatchAt: 0,
      pollTimer: null,
      pollInFlight: false,
      retryTimer: null,
    };
    runs.set(sessionId, run);
    void projectStage(run);
    return true;
  }

  function observeMessage(sessionId: string, message: CoworkMessage): void {
    const run = runs.get(sessionId);
    if (!run || run.released || !message?.id) return;
    const metadata = message.metadata as Record<string, unknown> | undefined;
    if (message.type === 'user') {
      const origin = metadata?.origin;
      const human = !isLiveStageWorkerReport(message) && (!origin || origin === 'user' || origin === 'quick_action');
      if (!human) { release(run); return; }
      const submissionId = String(metadata?.submissionId ?? message.id);
      if (run.turn.submissionId === submissionId || run.turn.id === message.id) return;
      const isTour = run.tourSubmissionId != null && (submissionId === run.tourSubmissionId || message.id === run.tourSubmissionId);
      if (!isTour && run.concluded) { release(run); return; }
      if (isTour) run.tourSubmissionId = null;
      startTurn(run, message.id, isTour ? 'tour' : 'chat', submissionId);
      return;
    }
    if (message.type === 'assistant') {
      if (metadata?.isThinking) return;
      run.turn.texts.set(message.id, typeof message.content === 'string' ? message.content : '');
      run.textDirty = true;
      schedulePatch(run);
      return;
    }
    if (message.type === 'tool_use') {
      const toolName = normalizeToolName(metadata?.toolName);
      if (!isGenesisTalkTool(toolName)) { release(run); return; }
      const input = metadata?.toolInput as Record<string, unknown> | undefined;
      const targetsSelf = run.metabotId == null || input?.metabot_id === run.metabotId;
      if (toolName === 'metabot_update' && targetsSelf && typeof input?.name === 'string' && input.name.trim()) {
        run.namings.set(String(metadata?.toolUseId ?? message.id), input.name.trim());
      }
      return;
    }
    if (message.type === 'tool_result') {
      const toolUseId = String(metadata?.toolUseId ?? '');
      const name = run.namings.get(toolUseId);
      if (!name) return;
      run.namings.delete(toolUseId);
      if (metadata?.isError) return;
      run.state = setGenesisNaming(run.state, name, toolUseId);
      schedulePatch(run, true);
    }
  }

  function observeMessageUpdate(sessionId: string, messageId: string, content: unknown): void {
    const run = runs.get(sessionId);
    if (!run || run.released || !run.turn.texts.has(messageId) || typeof content !== 'string') return;
    run.turn.texts.set(messageId, content);
    run.textDirty = true;
    schedulePatch(run);
  }

  function observeComplete(sessionId: string): void {
    const run = runs.get(sessionId);
    if (!run || run.released) return;
    finishTurn(run, false);
  }

  function observeError(sessionId: string): void {
    const run = runs.get(sessionId);
    if (!run || run.released) return;
    finishTurn(run, true);
  }

  function forget(sessionId: string): void {
    const run = runs.get(sessionId);
    if (!run) return;
    stopPolling(run);
    if (run.patchTimer) clearTimeout(run.patchTimer);
    if (run.retryTimer) clearTimeout(run.retryTimer);
    runs.delete(sessionId);
  }

  return {
    claimGreeting,
    observeMessage,
    observeMessageUpdate,
    observeComplete,
    observeError,
    isClaimed: (sessionId: string): boolean => {
      const run = runs.get(sessionId);
      return Boolean(run && !run.released);
    },
    beforeLiveStageProjection: (sessionId: string): Promise<void> | null => runs.get(sessionId)?.handoff ?? null,
    getState: (sessionId: string): GenesisStageState | null => runs.get(sessionId)?.state ?? null,
    forget,
    dispose: () => { [...runs.keys()].forEach(forget); },
  };
}

export type StudioGenesisStageService = ReturnType<typeof createStudioGenesisStageService>;
