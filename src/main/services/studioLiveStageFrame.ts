import type { BotBrowserTabCommand, BotBrowserTabCommandResult } from './botBrowserTabBridge';
import { collectMatchingFrames, isActableRenderUrl } from './botBrowserPreviewAct';
import { readRendererFromEnvelope } from './botBrowserSourceLocator';
import type { ActFrameShape, ActWindowShape } from './botBrowserPreviewAct';
import type { LiveStageState } from './studioLiveStageModel';

export type LiveStageFrameDeps = {
  getWindows(): ActWindowShape[];
  executeTabCommand(command: BotBrowserTabCommand): Promise<BotBrowserTabCommandResult>;
};

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
  const info = await deps.executeTabCommand({ action: 'get-tab-info', tabId: input.tabId });
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
  const result = await frames[0].executeJavaScript(buildLiveStagePatchScript(input.state), true) as { ok?: boolean; reason?: string } | null;
  if (!result?.ok) throw new Error(result?.reason || 'Live Stage patch was rejected');
}
