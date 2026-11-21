/**
 * Server-mode mobile page hosting (`mobile_open_page`, plan A of the
 * "移动端 bot 弹页能力" work order).
 *
 * A bot session hands this module one local path — an HTML file, or a
 * directory whose `index.html` is the entry — plus a title/description and an
 * optional TTL. The module validates the page against a fixed safety
 * envelope, then mints a gateway page token (HMAC-SHA256, see tokens.ts) and
 * returns the browser-facing URL `/pages/{token}/`.
 *
 * Safety envelope (all enforced HERE, before a token exists):
 *  - the page root must resolve (realpath, so symlinks cannot escape) inside
 *    the tenant data root(s) — the same R-path confinement fileSign uses;
 *  - only HTML and static asset extensions are servable, dot files and
 *    non-asset files are never served;
 *  - per-file size cap, total size cap and file-count cap;
 *  - the entry file must itself be servable;
 *  - expiry defaults to 24 h and is clamped to a 7-day ceiling.
 *
 * Every request under `/gateway/v1/pages/{token}/{asset}` re-checks
 * containment (lexical + realpath) so `../`, encoded traversal, absolute
 * paths, NUL bytes and symlink escapes all answer 404 — the token alone never
 * grants a read outside its page root.
 *
 * Pure module: node:fs / node:path plus sibling gateway modules — no electron
 * imports, loadable from plain node.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { dataRootList, isPathInside, resolveConfinementPath, type GatewayPaths } from './restrictions';
import { isGatewayError, makeError, type GatewayError } from './protocol';
import { signPageToken, verifyPageToken } from './tokens';

/** Tenant route the mobile client proxies to (control plane `/pages/*`). */
export const MOBILE_PAGE_ROUTE_PATH_PREFIX = '/gateway/v1/pages';
/** Same-origin browser route the PWA (and the dev proxy) exposes. */
export const MOBILE_PAGE_BROWSER_ROUTE_PREFIX = '/pages';

export const MOBILE_PAGE_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
export const MOBILE_PAGE_MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** One served asset may not exceed this size. */
export const MOBILE_PAGE_MAX_FILE_BYTES = 8 * 1024 * 1024;
/** The whole page (all servable files) may not exceed this size. */
export const MOBILE_PAGE_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
/** Upper bound on servable files so a huge tree cannot be turned into a token. */
export const MOBILE_PAGE_MAX_FILES = 256;
/** Recursion guard for asset discovery. */
export const MOBILE_PAGE_MAX_DEPTH = 8;

/**
 * Extensions a hosted page may serve. HTML is the page itself; everything
 * else is a static asset an HTML page legitimately loads. Deliberately NO
 * documents/archives/binaries that would turn the route into a general file
 * downloader (that is `gateway:file:sign`'s job).
 */
export const MOBILE_PAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
};

export const MOBILE_PAGE_ALLOWED_EXTENSIONS: ReadonlySet<string> = new Set(
  Object.keys(MOBILE_PAGE_MIME_BY_EXTENSION),
);

/** MIME for a servable page asset; null means "not servable". */
export function mobilePageMimeForPath(filePath: string): string | null {
  return MOBILE_PAGE_MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? null;
}

export interface MobilePageDeps {
  secret: string;
  tenantId: string;
  paths: GatewayPaths;
  /** Injected for testability; fs.realpathSync in production. */
  realpathSync: (target: string) => string;
}

export interface HostMobilePageInput {
  /** Absolute local path: an .html file, or a directory with index.html. */
  path: string;
  /** Token lifetime in hours; omitted → 24 h, clamped to 7 days. */
  ttlHours?: number;
}

export interface HostedMobilePage {
  /** Gateway page token (also embedded in the URLs). */
  token: string;
  /** Same-origin browser URL the card points at. */
  url: string;
  /** Tenant route (`/gateway/v1/pages/{token}/`). */
  gatewayPath: string;
  /** Entry file relative to the page root. */
  entry: string;
  expiresAt: number;
  /** Servable files discovered under the root (entry included). */
  fileCount: number;
  totalBytes: number;
  /** Served page root (realpath) — diagnostics only, never on the card. */
  root: string;
  /** True when ONE file was hosted (siblings are never servable). */
  singleFile: boolean;
}

interface PageRootResolution {
  root: string;
  entry: string;
  fileCount: number;
  totalBytes: number;
}

function isServableFile(filePath: string): boolean {
  return mobilePageMimeForPath(filePath) !== null && !path.basename(filePath).startsWith('.');
}

/** True when any path segment is `.`/`..` or the value is absolute. */
export function isSuspiciousRelativePath(relPath: string): boolean {
  if (relPath.includes('\0') || relPath.includes('\\')) return true;
  if (path.isAbsolute(relPath)) return true;
  return relPath.split('/').some((segment) => segment === '..');
}

/**
 * Walk the page root and account every servable file. Rejects on the size /
 * count caps and on symlinks that resolve outside the root.
 */
function scanPageFiles(
  deps: MobilePageDeps,
  root: string,
  entry: string,
): PageRootResolution | GatewayError {
  const entryPath = path.join(root, entry);
  let entryStat: fs.Stats;
  try {
    entryStat = fs.statSync(entryPath);
  } catch {
    return makeError('INVALID_ARGS', 'page entry file is missing');
  }
  if (!entryStat.isFile() || !isServableFile(entry)) {
    return makeError('INVALID_ARGS', 'page entry must be an .html/.htm file');
  }

  let fileCount = 0;
  let totalBytes = 0;
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  const accountFile = (filePath: string): GatewayError | null => {
    if (!isServableFile(filePath)) return null;
    let realPath: string;
    try {
      realPath = deps.realpathSync(filePath);
    } catch {
      return makeError('INVALID_ARGS', 'page asset is unreadable');
    }
    if (!isPathInside(realPath, root)) {
      return makeError('ARG_RESTRICTED', 'page asset resolves outside the page root');
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(realPath);
    } catch {
      return makeError('INVALID_ARGS', 'page asset is unreadable');
    }
    if (!stat.isFile()) return null;
    if (stat.size > MOBILE_PAGE_MAX_FILE_BYTES) {
      return makeError('INVALID_ARGS', `page asset exceeds the ${MOBILE_PAGE_MAX_FILE_BYTES}-byte file cap`);
    }
    fileCount += 1;
    if (fileCount > MOBILE_PAGE_MAX_FILES) {
      return makeError('INVALID_ARGS', `page has more than ${MOBILE_PAGE_MAX_FILES} servable files`);
    }
    totalBytes += stat.size;
    if (totalBytes > MOBILE_PAGE_MAX_TOTAL_BYTES) {
      return makeError('INVALID_ARGS', `page exceeds the ${MOBILE_PAGE_MAX_TOTAL_BYTES}-byte total cap`);
    }
    return null;
  };

  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    if (depth > MOBILE_PAGE_MAX_DEPTH) {
      return makeError('INVALID_ARGS', 'page directory nesting is too deep');
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return makeError('INVALID_ARGS', 'page directory is unreadable');
    }
    for (const dirent of entries) {
      if (dirent.name.startsWith('.')) continue;
      const child = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        queue.push({ dir: child, depth: depth + 1 });
        continue;
      }
      if (dirent.isSymbolicLink()) {
        // Only a symlink that stays inside the root is part of the page.
        let target: fs.Stats;
        try {
          target = fs.statSync(child);
        } catch {
          continue;
        }
        if (target.isDirectory()) {
          queue.push({ dir: child, depth: depth + 1 });
          continue;
        }
      }
      const error = accountFile(child);
      if (error) return error;
    }
  }

  if (fileCount === 0) {
    return makeError('INVALID_ARGS', 'page has no servable files');
  }
  return { root, entry, fileCount, totalBytes };
}

/** Normalize a caller TTL (hours) into [default, ceiling]. */
export function resolveMobilePageTtlMs(ttlHours: unknown, now: number = Date.now()): number {
  if (typeof ttlHours !== 'number' || !Number.isFinite(ttlHours) || ttlHours <= 0) {
    return MOBILE_PAGE_DEFAULT_TTL_MS;
  }
  return Math.min(Math.round(ttlHours * 60 * 60 * 1000), MOBILE_PAGE_MAX_TTL_MS);
}

/**
 * Validate one page path and mint its hosting token. Returns a GatewayError
 * (INVALID_ARGS / ARG_RESTRICTED) instead of throwing so the agent tool can
 * report a refusal without a stack trace.
 */
export function hostMobilePage(
  deps: MobilePageDeps,
  input: HostMobilePageInput,
  now: number = Date.now(),
): HostedMobilePage | GatewayError {
  const rawPath = typeof input?.path === 'string' ? input.path.trim() : '';
  if (!rawPath) return makeError('INVALID_ARGS', 'path is required');

  let realPath: string;
  try {
    realPath = deps.realpathSync(path.resolve(rawPath));
  } catch {
    return makeError('INVALID_ARGS', 'path is not readable');
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(realPath);
  } catch {
    return makeError('INVALID_ARGS', 'path is not readable');
  }

  let root: string;
  let entry: string;
  let singleFile = false;
  let fileCount = 0;
  let totalBytes = 0;
  if (stat.isDirectory()) {
    root = realPath;
    entry = 'index.html';
  } else if (stat.isFile()) {
    if (!isServableFile(realPath)) {
      return makeError('INVALID_ARGS', 'path must be an .html/.htm file or a directory with index.html');
    }
    // Single-file hosting: the token serves ONLY this file. Siblings in the
    // same directory are never exposed (a bot handing over one report must
    // not publish every other asset that happens to live next to it).
    root = path.dirname(realPath);
    entry = path.basename(realPath);
    singleFile = true;
    if (stat.size > MOBILE_PAGE_MAX_FILE_BYTES) {
      return makeError('INVALID_ARGS', `page asset exceeds the ${MOBILE_PAGE_MAX_FILE_BYTES}-byte file cap`);
    }
    fileCount = 1;
    totalBytes = stat.size;
  } else {
    return makeError('INVALID_ARGS', 'path must be an .html/.htm file or a directory with index.html');
  }

  // R-path confinement: only the tenant data root(s) can be hosted.
  const dataRoots = dataRootList(deps.paths).map(resolveConfinementPath);
  if (!dataRoots.some((dataRoot) => isPathInside(root, dataRoot))) {
    return makeError('ARG_RESTRICTED', 'path resolves outside the data root');
  }

  if (!singleFile) {
    const scanned = scanPageFiles(deps, root, entry);
    if (isGatewayError(scanned)) return scanned;
    fileCount = scanned.fileCount;
    totalBytes = scanned.totalBytes;
  }

  const expiresAt = now + resolveMobilePageTtlMs(input?.ttlHours, now);
  const token = signPageToken(deps.secret, deps.tenantId, root, entry, expiresAt, singleFile);
  return {
    token,
    url: `${MOBILE_PAGE_BROWSER_ROUTE_PREFIX}/${token}/`,
    gatewayPath: `${MOBILE_PAGE_ROUTE_PATH_PREFIX}/${token}/`,
    entry,
    expiresAt,
    fileCount,
    totalBytes,
    root,
    singleFile,
  };
}

export interface ResolvedMobilePageAsset {
  filePath: string;
  mime: string;
  size: number;
}

/**
 * Resolve one request path under a page token. `null` covers every refusal
 * (bad/expired/wrong-tenant token, traversal, symlink escape, non-servable
 * extension, missing file) — the HTTP route answers 404 uniformly so the
 * route never becomes an existence oracle.
 */
export function resolveMobilePageAsset(
  deps: Pick<MobilePageDeps, 'secret' | 'tenantId' | 'realpathSync'>,
  token: string,
  relPath: string,
  now: number = Date.now(),
): ResolvedMobilePageAsset | null {
  const payload = verifyPageToken(deps.secret, deps.tenantId, token, now);
  if (!payload) return null;
  // Single-file grant: any asset path (including '/') is refused — only the
  // entry file itself is servable.
  if (payload.s === 1 && relPath !== '' && relPath !== payload.i) return null;

  const requested = relPath === '' ? payload.i : relPath;
  if (!requested || isSuspiciousRelativePath(requested)) return null;

  const root = payload.p;
  const lexical = path.resolve(root, requested);
  if (!isPathInside(lexical, root)) return null;

  let realPath: string;
  try {
    realPath = deps.realpathSync(lexical);
  } catch {
    return null;
  }
  if (!isPathInside(realPath, root)) return null;

  const mime = mobilePageMimeForPath(realPath);
  if (!mime) return null;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(realPath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > MOBILE_PAGE_MAX_FILE_BYTES) return null;
  return { filePath: realPath, mime, size: stat.size };
}
