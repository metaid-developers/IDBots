import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { previewMetaappUriForPath } from '../libs/localPreviewUri';
import { renderLiveStageHtml } from './studioLiveStageTemplate';

/**
 * Persistent Live Stage entry page (2026-11-12 owner ruling): instead of
 * writing a fresh ~150KB stage HTML per turn into each bot workspace, the
 * stage renderer is materialized ONCE per template content under
 * `<userData>/live-stage/<templateId>-<sha1-12>/stage.html`. Every session's
 * stage tab opens the same file; identity and turn state arrive exclusively
 * through patches, so the file never needs rewriting.
 *
 * Avatars never travel inline in patches: data-URI avatars are decoded once
 * into `<stageDir>/avatars/<sha1-16>.<ext>` and referenced by the relative
 * path `avatars/<sha1-16>.<ext>`, which the preview server resolves against
 * the stage file's own directory.
 */

export type LiveStageEntry = {
  /** Absolute directory holding stage.html (+ avatars/ once written). */
  dir: string;
  /** Absolute path of the materialized stage.html. */
  filePath: string;
  /** preview-metaapp:// URI the stage tab navigates to. */
  uri: string;
  templateId: string;
};

const ENTRY_DIR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*-[0-9a-f]{12}$/;

function sha1Hex(value: string | Buffer, length: number): string {
  return createHash('sha1').update(value).digest('hex').slice(0, length);
}

/**
 * Render the built-in stage page with a null initial state and write it under
 * `stageRoot` once per content hash. Idempotent: an existing file is kept.
 * Sibling directories matching our `<templateId>-<12hex>` naming that are not
 * the current one are pruned (only directories this mechanism creates).
 */
export function materializeLiveStageEntry(deps: {
  stageRoot: string;
  templateId: string;
  assetRoot: string;
  fallbackAvatarDataUri: string;
}): LiveStageEntry {
  const html = renderLiveStageHtml({
    state: null,
    avatarDataUri: deps.fallbackAvatarDataUri,
    assets: { assetRoot: deps.assetRoot, fallbackAvatarDataUri: deps.fallbackAvatarDataUri },
  });
  const dirName = `${deps.templateId}-${sha1Hex(html, 12)}`;
  const dir = path.join(deps.stageRoot, dirName);
  const filePath = path.join(dir, 'stage.html');
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, html, 'utf8');
  }
  // Prune stale entries for THIS template only — directories we created whose
  // content hash no longer matches the current render.
  try {
    const prefix = `${deps.templateId}-`;
    for (const entry of fs.readdirSync(deps.stageRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !ENTRY_DIR_PATTERN.test(entry.name) || !entry.name.startsWith(prefix)) continue;
      if (entry.name === dirName) continue;
      fs.rmSync(path.join(deps.stageRoot, entry.name), { recursive: true, force: true });
    }
  } catch {
    // A missing/unreadable stageRoot only costs the prune; the entry itself is written.
  }
  return { dir, filePath, uri: previewMetaappUriForPath(filePath), templateId: deps.templateId };
}

const DATA_IMAGE_RE = /^data:image\/([a-z0-9]+);base64,(.+)$/is;

/**
 * Resolve an avatar reference for the stage page:
 * - https? URLs pass through unchanged;
 * - `data:image/<ext>;base64,…` is decoded and written once to
 *   `<stageDir>/avatars/<sha1-16>.<ext>`, referenced as the relative path
 *   `avatars/<sha1-16>.<ext>`;
 * - anything else (missing/invalid) returns undefined → the page's fallback.
 */
export function stageAssetFor(avatar: unknown, stageDir: string): string | undefined {
  if (typeof avatar !== 'string' || !avatar) return undefined;
  if (/^https?:\/\//i.test(avatar)) return avatar;
  const match = DATA_IMAGE_RE.exec(avatar);
  if (!match) return undefined;
  const ext = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
  if (!/^[a-z0-9]+$/.test(ext)) return undefined;
  const bytes = Buffer.from(match[2], 'base64');
  if (!bytes.length) return undefined;
  const fileName = `${sha1Hex(bytes, 16)}.${ext}`;
  const avatarsDir = path.join(stageDir, 'avatars');
  const filePath = path.join(avatarsDir, fileName);
  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(avatarsDir, { recursive: true });
    fs.writeFileSync(filePath, bytes);
  }
  return `avatars/${fileName}`;
}

/**
 * True when a tab URI is a Live Stage page — either the persistent materialized
 * entry (`…/live-stage/<templateId>-<hash>/stage.html`) or a legacy per-turn
 * file (`…/reports/live-stage-*.html` still open in old sessions).
 */
export function isLiveStagePageUri(uri: string | null | undefined): boolean {
  if (typeof uri !== 'string' || !uri) return false;
  if (uri.includes('/reports/live-stage-')) return true;
  return uri.includes('/live-stage/') && /\/stage\.html(?:[?#]|$)/.test(uri);
}
