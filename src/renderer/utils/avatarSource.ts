import { builtinAvatarSrc, getBuiltinAvatarByReference } from '../assets/builtinAvatars';

/**
 * Avatar source helpers shared across cowork / A2A / group-task views.
 *
 * Some on-chain / MetaFS user records store the literal marker `/content/`
 * (or a bare `<base>/content/` URL) when a Bot has no avatar. A bug in the
 * upstream profile fetcher (`@openagentinternet/agent-browser-core`'s
 * `fetchBotProfileInfo`) turns that relative marker into an absolute URL by
 * prepending the P2P search base, producing e.g.
 *   `https://so.metaid.io/content/`  ->  404
 * which then flows into session/peer avatar fields and gets rendered as an
 * `<img>`. These guards treat such "no avatar" markers as unrenderable so the
 * UI falls back to the default avatar instead of firing a broken request.
 */

/** Marker strings that mean "no avatar" and must never be used as an <img src>. */
const NO_AVATAR_MARKERS: readonly string[] = [
  '/content/',
  '/content',
  '/metafile-indexer/content',
  '/metafile-indexer/thumbnail',
  '/metafile-indexer/api/v1/files/content',
  '/metafile-indexer/api/v1/files/accelerate/content',
  '/metafile-indexer/api/v1/users/avatar/accelerate',
];

const isNoAvatarMarker = (normalized: string): boolean => {
  if (!normalized) return true;
  return NO_AVATAR_MARKERS.some((marker) => normalized === marker);
};

/**
 * True when `value` is a directly renderable avatar source: a `data:`/`blob:`
 * URL, an absolute `http(s)` URL, **and** not one of the "no avatar" markers.
 * Bare MetaID references (`/content/<pinId>`, `metafile://…`, raw pin ids)
 * return false so callers resolve them through the main-process resolver.
 */
export const isRenderableAvatarSource = (value: string | null | undefined): boolean => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) return false;
  if (isNoAvatarMarker(normalized)) return false;
  // Reject a marker that already got promoted to an absolute URL by the
  // upstream fetcher (e.g. `https://so.metaid.io/content/`).
  if (/^https?:\/\//i.test(normalized)) {
    try {
      const parsed = new URL(normalized);
      const path = parsed.pathname.replace(/\/+$/, '');
      if (isNoAvatarMarker(path)) return false;
    } catch {
      return false;
    }
    return true;
  }
  return normalized.startsWith('data:image/') || normalized.startsWith('blob:');
};

/**
 * Pick the first renderable value, or null. Keeps call sites concise.
 */
export const pickRenderableAvatarSource = (
  ...values: Array<string | null | undefined>
): string | null => {
  for (const value of values) {
    const source = toRenderableAvatarSource(value);
    if (source) return source;
  }
  return null;
};

/**
 * The `<img src>` for an avatar value, or null when it is not renderable as
 * is. Built-in avatars are stored as their on-chain `metafile://<pinId>.png`
 * reference (the first-run Twin picks one at random); they map to the bundled
 * file so every surface — activity row, session list, A2A transcript —
 * shows the bot's face instead of a blank/default avatar.
 */
export const toRenderableAvatarSource = (value: string | null | undefined): string | null => {
  const builtin = getBuiltinAvatarByReference(value);
  if (builtin) return builtinAvatarSrc(builtin);
  return isRenderableAvatarSource(value) ? value!.trim() || null : null;
};

/**
 * A source an <img> can draw as-is: data:/blob:/http(s) URLs, or a bundled
 * app asset path (`./builtin-avatars/…` or `/builtin-avatars/…`, the form
 * toRenderableAvatarSource maps built-in avatars to). NftAvatarFrame's plain
 * branch only accepted data:/http, so a pre-mapped built-in avatar fell back
 * to the default robot in the Studio activity row (2026-11-14).
 */
export const isDirectImageSource = (value: string | null | undefined): boolean => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) return false;
  return /^(?:data:|blob:|https?:)/i.test(normalized) || /^\.?\/(?!\/)[^:]*$/.test(normalized);
};
