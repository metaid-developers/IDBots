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

async function locateLiveStageFrame(deps: LiveStageFrameDeps, tabId: number): Promise<ActFrameShape> {
  const info = await deps.executeTabCommand({ action: 'get-tab-info', tabId });
  const renderer = readRendererFromEnvelope(info.info?.current);
  if (renderer.type !== 'html-iframe' || !renderer.url || !isActableRenderUrl(renderer.url)) {
    throw new Error('The Live Stage tab is not a locally served preview');
  }
  const frames: ActFrameShape[] = [];
  for (const window of deps.getWindows()) {
    if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
    frames.push(...collectMatchingFrames(window.webContents.mainFrame, renderer.url));
  }
  if (!frames.length) throw new Error('The Live Stage frame is not ready');
  return frames[0];
}

export function buildLiveStagePatchScript(state: LiveStageState): string {
  const payload = JSON.stringify(state).replace(/</g, '\\u003c');
  return `(() => {
  if (!window.IDBotsLiveStage || typeof window.IDBotsLiveStage.applyPatch !== 'function') {
    return { ok: false, reason: 'live-stage-not-ready' };
  }
  return { ok: window.IDBotsLiveStage.applyPatch(${payload}) === true };
})()`;
}

export async function applyStudioLiveStagePatch(
  deps: LiveStageFrameDeps,
  input: { tabId: number; state: LiveStageState },
): Promise<void> {
  const frame = await locateLiveStageFrame(deps, input.tabId);
  const result = await frame.executeJavaScript(buildLiveStagePatchScript(input.state), true) as { ok?: boolean; reason?: string } | null;
  if (!result?.ok) throw new Error(result?.reason || 'Live Stage patch was rejected');
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
  input: { tabId: number },
): Promise<DrainedLiveStageInteraction[]> {
  const frame = await locateLiveStageFrame(deps, input.tabId);
  const result = await frame.executeJavaScript(buildLiveStageDrainScript(), true) as { ok?: boolean; items?: DrainedLiveStageInteraction[] } | null;
  return Array.isArray(result?.items) ? result.items : [];
}
