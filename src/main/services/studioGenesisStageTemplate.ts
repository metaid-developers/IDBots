import fs from 'node:fs';
import path from 'node:path';
import type { GenesisStageState } from './studioGenesisStageModel';

export type GenesisStageAssets = {
  /** `public/genesis-stage` (dev) or `dist/genesis-stage` (packaged). */
  genesisRoot: string;
  /** The Live Stage package that owns the shared orb shader and renderer. */
  orbRoot: string;
  fallbackAvatarDataUri: string;
};

function inlineJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

const PLACEHOLDER = /__(GENESIS_CSS|INITIAL_STATE|AVATAR_URI|FALLBACK_AVATAR_URI|ORB_EFFECT|ORB_RENDERER|FALLBACK_ORB|GENESIS_SOUND|GENESIS_JS)__/g;

/**
 * One self-contained HTML file per greeting session. Placeholders are filled
 * in a single pass so inlined bot text can never be mistaken for a slot.
 */
export function renderGenesisStageHtml(input: {
  state: GenesisStageState;
  avatarDataUri: string;
  assets: GenesisStageAssets;
}): string {
  const readGenesis = (name: string): string => fs.readFileSync(path.join(input.assets.genesisRoot, name), 'utf8');
  const readOrb = (name: string): string => fs.readFileSync(path.join(input.assets.orbRoot, name), 'utf8');
  const values: Record<string, () => string> = {
    GENESIS_CSS: () => readGenesis('genesis.css'),
    INITIAL_STATE: () => inlineJson(input.state),
    AVATAR_URI: () => inlineJson(input.avatarDataUri),
    FALLBACK_AVATAR_URI: () => inlineJson(input.assets.fallbackAvatarDataUri),
    ORB_EFFECT: () => readOrb('liquid-orb-effect.js'),
    ORB_RENDERER: () => readOrb('liquid-orb.js'),
    FALLBACK_ORB: () => readGenesis('genesis-fallback-orb.js'),
    GENESIS_SOUND: () => readGenesis('genesis-sound.js'),
    GENESIS_JS: () => readGenesis('genesis.js'),
  };
  return readGenesis('genesis.html').replace(PLACEHOLDER, (_match, key: string) => values[key]());
}
