/**
 * Twin Bot avatar for a first run: one of the built-in avatars, picked at
 * random so new users do not all start with the same face.
 *
 * The avatar is stored as the built-in's `metafile://` reference. Every
 * built-in image is already pinned on-chain, so `/info/avatar` publishes that
 * tiny text reference (see buildAvatarSyncStep in
 * src/main/services/metaidCore.ts) instead of re-uploading ~64 KB of image
 * bytes — the old inlined data-URL avatar alone consumed most of a new bot's
 * gas subsidy, which then left its later profile pins unfunded.
 */
import { BUILTIN_AVATARS } from './builtinAvatarCatalog';

export function pickTwinBotAvatar(random: () => number = Math.random): string {
  const index = Math.min(BUILTIN_AVATARS.length - 1, Math.max(0, Math.floor(random() * BUILTIN_AVATARS.length)));
  return BUILTIN_AVATARS[index].metafileUri;
}
