import type { BotBrowserTabCommand, BotBrowserTabCommandResult } from './botBrowserTabBridge';
import { collectMatchingFrames, isActableRenderUrl } from './botBrowserPreviewAct';
import { readRendererFromEnvelope } from './botBrowserSourceLocator';
import type { ActFrameShape, ActWindowShape } from './botBrowserPreviewAct';
import type { LiveStageState } from './studioLiveStageModel';

export type LiveStageFrameDeps = {
  getWindows(): ActWindowShape[];
  executeTabCommand(command: BotBrowserTabCommand): Promise<BotBrowserTabCommandResult>;
};

export type DrainedLiveStageInteraction = {
  requestId?: unknown;
  token?: unknown;
  behavior?: unknown;
  answers?: unknown;
};

/**
 * Frame-location failure with a machine-readable `reason` so the service can
 * pick retry vs. self-heal without parsing messages:
 *  - 'tab-not-found' / 'frame-not-found' / 'not-ready' → transient, retry
 *  - 'session-mismatch' → the page is claimed by another session, re-project
 */
export class LiveStageFrameError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = 'LiveStageFrameError';
    this.reason = reason;
  }
}

export function liveStageFrameErrorReason(error: unknown): string {
  const reason = (error as { reason?: unknown } | null | undefined)?.reason;
  return typeof reason === 'string' && reason ? reason : 'unknown';
}

const STAGE_PAGE_PROBE_SCRIPT = `(() => {
  const bridge = window.IDBotsLiveStage;
  if (!bridge || typeof bridge.getState !== 'function') return { bridge: false, sessionId: null, turnId: null, turnStartedAt: null };
  const state = bridge.getState();
  return {
    bridge: true,
    sessionId: state && typeof state.sessionId === 'string' ? state.sessionId : null,
    turnId: state && typeof state.turnId === 'string' ? state.turnId : null,
    turnStartedAt: state && typeof state.turnStartedAt === 'number' ? state.turnStartedAt : null,
  };
})()`;

type StagePageProbe = {
  frame: ActFrameShape;
  bridge: boolean;
  sessionId: string | null;
  turnId: string | null;
  turnStartedAt: number | null;
};

async function locateLiveStageFrame(deps: LiveStageFrameDeps, tabId: number, expectedSessionId?: string): Promise<ActFrameShape> {
  let info: BotBrowserTabCommandResult;
  try {
    // Host-side frame lookup: stay off the app surface (controlTabsSilent).
    info = await deps.executeTabCommand({ action: 'get-tab-info', tabId, background: true });
  } catch {
    throw new LiveStageFrameError('tab-not-found', 'The Live Stage tab is not reachable');
  }
  const renderer = readRendererFromEnvelope(info.info?.current);
  if (renderer.type !== 'html-iframe' || !renderer.url || !isActableRenderUrl(renderer.url)) {
    throw new LiveStageFrameError('tab-not-found', 'The Live Stage tab is not a locally served preview');
  }
  const frames: ActFrameShape[] = [];
  for (const window of deps.getWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
    frames.push(...collectMatchingFrames(window.webContents.mainFrame, renderer.url));
  }
  if (!frames.length) throw new LiveStageFrameError('frame-not-found', 'The Live Stage frame is not ready');
  if (expectedSessionId == null) return frames[0];
  // The persistent entry URI is shared by every session's stage tab: several
  // frames can match the renderer URL. Probe each page and deliver to the one
  // claimed by THIS session — or to an unclaimed page, which claims it on the
  // first accepted patch.
  const probed = await Promise.all(frames.map(async (frame): Promise<StagePageProbe> => {
    try {
      const result = await frame.executeJavaScript(STAGE_PAGE_PROBE_SCRIPT, true) as {
        bridge?: boolean; sessionId?: unknown; turnId?: unknown; turnStartedAt?: unknown;
      } | null;
      return {
        frame,
        bridge: result?.bridge === true,
        sessionId: typeof result?.sessionId === 'string' && result.sessionId ? result.sessionId : null,
        turnId: typeof result?.turnId === 'string' ? result.turnId : null,
        turnStartedAt: typeof result?.turnStartedAt === 'number' ? result.turnStartedAt : null,
      };
    } catch {
      return { frame, bridge: false, sessionId: null, turnId: null, turnStartedAt: null };
    }
  }));
  const bridged = probed.filter((entry) => entry.bridge);
  if (!bridged.length) throw new LiveStageFrameError('not-ready', 'The Live Stage frame is not ready');
  const match = bridged.find((entry) => entry.sessionId === expectedSessionId)
    ?? bridged.find((entry) => entry.sessionId == null);
  if (!match) throw new LiveStageFrameError('session-mismatch', 'The Live Stage frame belongs to a different session');
  return match.frame;
}

/**
 * Run a script inside a stage tab's locally served preview frame (the same
 * trusted channel the Live Stage patch uses; the Genesis Stage reuses it).
 */
export async function executeStageFrameScript(
  deps: LiveStageFrameDeps,
  input: { tabId: number; script: string },
): Promise<unknown> {
  const frame = await locateLiveStageFrame(deps, input.tabId);
  return frame.executeJavaScript(input.script, true);
}

export function buildLiveStagePatchScript(state: LiveStageState): string {
  const payload = JSON.stringify(state).replace(/</g, '\\u003c');
  return `(() => {
  const bridge = window.IDBotsLiveStage;
  if (!bridge || typeof bridge.applyPatch !== 'function') {
    return { ok: false, reason: 'not-ready' };
  }
  const applied = bridge.applyPatch(${payload});
  if (applied === true) return { ok: true };
  const reason = applied && typeof applied === 'object' && typeof applied.reason === 'string' ? applied.reason : 'protocol';
  return { ok: false, reason };
})()`;
}

export async function applyStudioLiveStagePatch(
  deps: LiveStageFrameDeps,
  input: { tabId: number; state: LiveStageState },
): Promise<void> {
  const frame = await locateLiveStageFrame(deps, input.tabId, input.state.sessionId);
  const result = await frame.executeJavaScript(buildLiveStagePatchScript(input.state), true) as { ok?: boolean; reason?: string } | null;
  if (result?.ok === true) return;
  const reason = typeof result?.reason === 'string' && result.reason ? result.reason : 'rejected';
  throw new LiveStageFrameError(reason, `Live Stage patch was rejected: ${reason}`);
}

export function buildLiveStageDrainScript(): string {
  return `(() => {
  if (!window.IDBotsLiveStage || typeof window.IDBotsLiveStage.drainInteractions !== 'function') {
    return { ok: false, reason: 'live-stage-not-ready', items: [] };
  }
  const items = window.IDBotsLiveStage.drainInteractions();
  return { ok: true, items: Array.isArray(items) ? items : [] };
})()`;
}

/**
 * Pull the stage card's queued clicks over the same privileged frame channel
 * the patch uses. The drain consumes the page queue, so a response lost in
 * transit is a lost click (the card stays answered and the desktop overlay
 * seat remains available) — never a duplicate submission. Items are untrusted
 * until the service validates requestId + token against the pending card.
 */
export async function drainStudioLiveStageInteractions(
  deps: LiveStageFrameDeps,
  input: { tabId: number; sessionId?: string },
): Promise<DrainedLiveStageInteraction[]> {
  const frame = await locateLiveStageFrame(deps, input.tabId, input.sessionId);
  const result = await frame.executeJavaScript(buildLiveStageDrainScript(), true) as { ok?: boolean; reason?: string; items?: DrainedLiveStageInteraction[] } | null;
  // A not-ready stage (stale page, missing bridge) must surface as an error,
  // not as an empty queue — an empty array here is indistinguishable from
  // "no clicks yet" and the poller would sit silently forever (2026-11-12
  // MetaPo retest had zero drain observability).
  if (!result?.ok) throw new Error(result?.reason || 'stage drain unavailable');
  return Array.isArray(result.items) ? result.items : [];
}
