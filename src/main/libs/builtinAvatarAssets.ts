/**
 * Resolve a built-in avatar's `metafile://` reference to a local image data
 * URI. Built-in avatars are stored as their on-chain reference (the first-run
 * Twin picks one at random), but surfaces that render from the main process —
 * the Genesis and Live Stage pages — only accept data:/http(s) avatars, so
 * they would otherwise fall back to the generic bot image. The files ship in
 * public/builtin-avatars (dist/builtin-avatars when packaged).
 */
import fs from 'fs';
import path from 'path';
import { BUILTIN_AVATARS } from '../../renderer/assets/builtinAvatarCatalog';

const cache = new Map<string, string | null>();

export function resolveBuiltinAvatarDataUri(avatar: unknown, publicRoot: string): string | undefined {
  if (typeof avatar !== 'string') return undefined;
  const reference = avatar.trim().toLowerCase();
  if (!reference.startsWith('metafile://')) return undefined;
  const entry = BUILTIN_AVATARS.find((item) => item.metafileUri.toLowerCase() === reference
    || `metafile://${item.pinId.toLowerCase()}` === reference);
  if (!entry) return undefined;
  const filePath = path.join(publicRoot, entry.src);
  if (!cache.has(filePath)) {
    try {
      cache.set(filePath, `data:image/png;base64,${fs.readFileSync(filePath).toString('base64')}`);
    } catch {
      cache.set(filePath, null);
    }
  }
  return cache.get(filePath) ?? undefined;
}
