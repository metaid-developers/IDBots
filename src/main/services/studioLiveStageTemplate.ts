import fs from 'node:fs';
import path from 'node:path';
import type { LiveStageState } from './studioLiveStageModel';

export type LiveStageTemplateAssets = {
  assetRoot: string;
  fallbackAvatarDataUri: string;
};

function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

export function renderLiveStageHtml(input: {
  state: LiveStageState;
  avatarDataUri: string;
  assets: LiveStageTemplateAssets;
}): string {
  const read = (name: string): string => fs.readFileSync(path.join(input.assets.assetRoot, name), 'utf8');
  return read('stage.html')
    .replace('__STAGE_CSS__', () => read('stage.css'))
    .replace('__INITIAL_STATE__', () => inlineJson(input.state))
    .replaceAll('__FALLBACK_AVATAR_DATA_URI__', () => inlineJson(input.assets.fallbackAvatarDataUri))
    .replace('__ORB_EFFECT__', () => read('liquid-orb-effect.js'))
    .replace('__ORB_RENDERER__', () => read('liquid-orb.js'))
    .replace('__STAGE_JS__', () => read('stage.js'))
    .replaceAll('__AVATAR_DATA_URI__', () => input.avatarDataUri);
}
